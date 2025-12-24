import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Interval } from '@nestjs/schedule';
import { MarketOrderbook, Market } from '../../database/entities';
import { MarketData } from '../../common/interfaces/market.interface';
import { APP_CONSTANTS } from '../../common/constants/app.constants';
import { RedisService } from '../../common/services/redis.service';

@Injectable()
export class BufferService {
  private readonly logger = new Logger(BufferService.name);
  private buffer: MarketData[] = [];
  private readonly batchSize: number = APP_CONSTANTS.BATCH_SIZE;
  private readonly flushInterval: number = APP_CONSTANTS.FLUSH_INTERVAL_MS;
  private isProcessing = false;
  private slugToMarketIdCache: Map<string, string> = new Map();

  constructor(
    @InjectRepository(MarketOrderbook)
    private readonly orderbookRepository: Repository<MarketOrderbook>,
    @InjectRepository(Market)
    private readonly marketRepository: Repository<Market>,
    private readonly redisService: RedisService,
  ) {
    this.logger.log(
      `Buffer initialized with batch size: ${this.batchSize}, flush interval: ${this.flushInterval}ms`,
    );
  }

  /**
   * Push new data to buffer
   */
  push(data: MarketData): void {
    this.buffer.push(data);

    // Auto-flush if buffer reaches batch size
    if (this.buffer.length >= this.batchSize) {
      this.flush();
    }
  }

  /**
   * Flush buffer every interval (time-based)
   */
  @Interval(APP_CONSTANTS.FLUSH_INTERVAL_MS)
  async handleInterval() {
    if (this.buffer.length > 0 && !this.isProcessing) {
      await this.flush();
    }
  }

  /**
   * Calculate best bid/ask and spread from orderbook levels
   * Spread = best ask - best bid
   */
  private calculateOrderbookMetrics(
    bids: any[],
    asks: any[],
  ): { bestBid: string | null; bestAsk: string | null; spread: string | null } {
    try {
      if (!bids || !asks || bids.length === 0 || asks.length === 0) {
        return { bestBid: null, bestAsk: null, spread: null };
      }

      // Helper function to extract price from different formats
      const extractPrice = (item: any): number | null => {
        if (Array.isArray(item)) {
          return parseFloat(item[0]);
        }
        if (item && typeof item === 'object') {
          return parseFloat(item.price ?? item[0]);
        }
        return parseFloat(item);
      };

      // Find max bid price (highest bid)
      let maxBidPrice: number | null = null;
      for (const bid of bids) {
        const price = extractPrice(bid);
        if (price !== null && !isNaN(price)) {
          if (maxBidPrice === null || price > maxBidPrice) {
            maxBidPrice = price;
          }
        }
      }

      // Find min ask price (lowest ask)
      let minAskPrice: number | null = null;
      for (const ask of asks) {
        const price = extractPrice(ask);
        if (price !== null && !isNaN(price)) {
          if (minAskPrice === null || price < minAskPrice) {
            minAskPrice = price;
          }
        }
      }

      if (
        maxBidPrice === null ||
        minAskPrice === null ||
        isNaN(maxBidPrice) ||
        isNaN(minAskPrice)
      ) {
        return { bestBid: null, bestAsk: null, spread: null };
      }

      // Spread = min(asks) - max(bids)
      const spread = minAskPrice - maxBidPrice;

      return {
        bestBid: maxBidPrice.toFixed(10),
        bestAsk: minAskPrice.toFixed(10),
        spread: spread.toFixed(10),
      };
    } catch (error) {
      this.logger.debug(
        `Error calculating orderbook metrics: ${error.message}`,
      );
      return { bestBid: null, bestAsk: null, spread: null };
    }
  }

  /**
   * Get slug from token metadata in Redis
   */
  private async getSlugFromToken(assetId: string): Promise<string | null> {
    try {
      const metadataStr = await this.redisService.get(
        `token_metadata:${assetId}`,
      );
      if (metadataStr) {
        const metadata = JSON.parse(metadataStr);
        return metadata.slug || null;
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Get baseSlug (type) from token metadata in Redis
   */
  private async getBaseSlugFromToken(assetId: string): Promise<string | null> {
    try {
      const metadataStr = await this.redisService.get(
        `token_metadata:${assetId}`,
      );
      if (metadataStr) {
        const metadata = JSON.parse(metadataStr);
        return metadata.baseSlug || null;
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Get market ID from slug (with caching)
   */
  private async getMarketIdFromSlug(slug: string): Promise<string | null> {
    if (!slug) {
      return null;
    }

    // Check cache first
    if (this.slugToMarketIdCache.has(slug)) {
      return this.slugToMarketIdCache.get(slug) || null;
    }

    try {
      const market = await this.marketRepository.findOne({
        where: { slug },
        select: ['id'],
      });

      if (market) {
        // Cache the result
        this.slugToMarketIdCache.set(slug, market.id);
        return market.id;
      }
      return null;
    } catch (error) {
      this.logger.debug(
        `Error finding market for slug ${slug}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Flush buffer to database
   */
  async flush(): Promise<void> {
    if (this.isProcessing || this.buffer.length === 0) {
      return;
    }

    this.isProcessing = true;

    try {
      // Take current buffer and reset immediately
      const dataToSave = [...this.buffer];
      this.buffer = [];

      // Transform data to entity format with slug and spread
      const entities = await Promise.all(
        dataToSave.map(async (data) => {
          // Get slug from Redis token metadata
          const slug = await this.getSlugFromToken(data.asset_id);

          // Get baseSlug (type) from Redis token metadata
          const baseSlug = await this.getBaseSlugFromToken(data.asset_id);

          // Get market ID from slug
          const marketId = slug ? await this.getMarketIdFromSlug(slug) : null;

          // If baseSlug not found in metadata, try to get from market entity
          let finalBaseSlug = baseSlug;
          if (!finalBaseSlug && marketId) {
            try {
              const market = await this.marketRepository.findOne({
                where: { id: marketId },
                select: ['type'],
              });
              if (market?.type) {
                finalBaseSlug = market.type;
              }
            } catch (error) {
              // Ignore error, continue without baseSlug
            }
          }

          // Calculate best bid/ask and spread
          const { bestBid, bestAsk, spread } = this.calculateOrderbookMetrics(
            data.bids || [],
            data.asks || [],
          );

          return {
            marketHash: data.market,
            assetId: data.asset_id,
            slug: slug || null,
            marketSlug: slug || null,
            marketId: marketId || null,
            type: finalBaseSlug || null,
            timestamp: data.timestamp.toString(),
            bids: data.bids || null,
            asks: data.asks || null,
            bestBid: bestBid || null,
            bestAsk: bestAsk || null,
            lastTradePrice: data.last_trade_price?.toString() || null,
            spread: spread || null,
          };
        }),
      );

      // Bulk insert using query builder for better performance
      if (entities.length > 0) {
        await this.orderbookRepository
          .createQueryBuilder()
          .insert()
          .into(MarketOrderbook)
          .values(entities)
          .execute();

        this.logger.log(`Flushed ${entities.length} records to database`);
      }
    } catch (error) {
      this.logger.error('Error flushing buffer:', error.message);
      // In production, you might want to implement retry logic or dead-letter queue
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Get current buffer size
   */
  getBufferSize(): number {
    return this.buffer.length;
  }

  /**
   * Force flush (for graceful shutdown)
   */
  async forceFlush(): Promise<void> {
    this.logger.log('Force flushing buffer...');
    await this.flush();
  }
}
