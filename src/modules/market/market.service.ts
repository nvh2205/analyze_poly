import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';
import { RedisService } from '../../common/services/redis.service';
import { UtilService } from '../../common/services/util.service';
import { MarketApiResponse } from '../../common/interfaces/market.interface';
import { IngestionService } from '../ingestion/ingestion.service';
import {
  APP_CONSTANTS,
  SlugConfig,
} from '../../common/constants/app.constants';
import { Market } from '../../database/entities/market.entity';
import { LiveActivitySocketService } from '../ingestion/live-activity-socket.service';

@Injectable()
export class MarketService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MarketService.name);
  private readonly apiUrl: string = APP_CONSTANTS.POLYMARKET_API_URL;
  private readonly cacheTtl: number = APP_CONSTANTS.MARKET_CACHE_TTL;
  private readonly slugConfigs: SlugConfig[] = APP_CONSTANTS.SLUG_CONFIGS;

  constructor(
    private readonly redisService: RedisService,
    private readonly utilService: UtilService,
    private readonly ingestionService: IngestionService,
    private readonly liveActivitySocketService: LiveActivitySocketService,
    @InjectRepository(Market)
    private readonly marketRepository: Repository<Market>,
  ) {}

  /**
   * Run market discovery immediately when application starts
   */
  async onApplicationBootstrap() {
    this.logger.log(
      'Application started - triggering initial market discovery...',
    );
    try {
      await this.handleMarketDiscovery();
      this.logger.log('Initial market discovery completed successfully');
    } catch (error) {
      this.logger.error('Error in initial market discovery:', error.message);
    }
  }

  /**
   * Cron job runs every 15 minutes to check and remove expired markets
   */
  @Cron('0 */15 * * * *') // Every 15 minutes
  async handleExpiredMarketsCleanup() {
    this.logger.log('Starting expired markets cleanup...');
    try {
      const now = new Date();

      // Find all active markets with endDate in the past
      const expiredMarkets = await this.marketRepository.find({
        where: {
          active: true,
        },
      });

      const expiredMarketsToClose = expiredMarkets.filter(
        (market) => market.endDate && new Date(market.endDate) < now,
      );

      if (expiredMarketsToClose.length === 0) {
        this.logger.debug('No expired markets found');
        return;
      }

      this.logger.log(
        `Found ${expiredMarketsToClose.length} expired markets to cleanup`,
      );

      const allExpiredTokens: string[] = [];

      for (const market of expiredMarketsToClose) {
        try {
          // Collect tokens from expired markets
          if (market.clobTokenIds && market.clobTokenIds.length > 0) {
            allExpiredTokens.push(...market.clobTokenIds);
          }

          // Update market status
          market.active = false;
          market.closed = true;
          await this.marketRepository.save(market);

          await this.liveActivitySocketService.closeConnection(
            market.slug,
            'market expired',
          );

          this.logger.log(
            `Marked market as closed: ${market.marketId} (${market.slug})`,
          );
        } catch (error) {
          this.logger.error(
            `Error closing market ${market.marketId}:`,
            error.message,
          );
        }
      }

      // Unsubscribe from expired tokens if any
      if (allExpiredTokens.length > 0) {
        // Remove duplicates
        const uniqueExpiredTokens = [...new Set(allExpiredTokens)];
        this.logger.log(
          `Unsubscribing from ${uniqueExpiredTokens.length} expired tokens`,
        );
        await this.ingestionService.unsubscribeFromTokens(uniqueExpiredTokens);
      }

      this.logger.log(
        `Expired markets cleanup completed. Closed ${expiredMarketsToClose.length} markets, unsubscribed from ${allExpiredTokens.length} tokens`,
      );
    } catch (error) {
      this.logger.error('Error in expired markets cleanup:', error.message);
    }
  }

  /**
   * Cron job runs every 15 minutes to discover new markets
   * Now handles multiple slug patterns for different cryptocurrencies and intervals
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async handleMarketDiscovery() {
    this.logger.log('Starting market discovery for all configured patterns...');

    const discoveryResults = {
      total: 0,
      success: 0,
      failed: 0,
      cached: 0,
      newTokens: 0,
    };

    // Process all slug configurations in parallel
    const discoveryPromises = this.slugConfigs.map((config) =>
      this.discoverMarketForConfig(config, discoveryResults),
    );

    await Promise.allSettled(discoveryPromises);

    this.logger.log(
      `Market discovery completed. Total: ${discoveryResults.total}, ` +
        `Success: ${discoveryResults.success}, Failed: ${discoveryResults.failed}, ` +
        `Cached: ${discoveryResults.cached}, New Tokens: ${discoveryResults.newTokens}`,
    );
  }

  /**
   * Job runs every 5 seconds to check markets with startTime <= current
   * and subscribe to socket if not already subscribed
   */
  @Interval(5000) // Every 5 seconds
  async crawlMarketsForSocketSubscription() {
    try {
      const now = new Date();

      // Query markets with startTime <= current time and active = true using query builder
      const marketsToCheck = await this.marketRepository
        .createQueryBuilder('market')
        .select([
          'market.id',
          'market.slug',
          'market.clobTokenIds',
          'market.startTime',
          'market.marketId',
          'market.type',
          'market.endDate',
        ])
        .where('market.active = :active', { active: true })
        .andWhere('market.startTime IS NOT NULL')
        .andWhere('market.startTime <= :now', { now })
        .getMany();

      if (marketsToCheck.length === 0) {
        return; // No markets to process
      }

      this.logger.debug(
        `Found ${marketsToCheck.length} markets with startTime <= current time`,
      );

      let totalNewTokens = 0;

      for (const market of marketsToCheck) {
        try {
          const endDateMs = market.endDate?.getTime();
          if (endDateMs && endDateMs <= now.getTime()) {
            await this.liveActivitySocketService.closeConnection(
              market.slug,
              'market ended',
            );
            continue;
          }

          await this.liveActivitySocketService.ensureConnection(
            market.slug,
            market.endDate || null,
          );

          // Skip if no clobTokenIds
          if (
            !market.clobTokenIds ||
            !Array.isArray(market.clobTokenIds) ||
            market.clobTokenIds.length === 0
          ) {
            continue;
          }

          // Check which tokens are not yet subscribed
          const tokensToSubscribe: string[] = [];

          for (const tokenId of market.clobTokenIds) {
            const isSubscribed = await this.redisService.sismember(
              'active_clob_tokens',
              tokenId,
            );

            if (!isSubscribed) {
              tokensToSubscribe.push(tokenId);
            }
          }

          // If there are tokens to subscribe
          if (tokensToSubscribe.length > 0) {
            this.logger.log(
              `Found ${tokensToSubscribe.length} unsubscribed tokens for market ${market.slug} (${market.marketId})`,
            );

            // Add to active tokens set
            await this.redisService.sadd(
              'active_clob_tokens',
              ...tokensToSubscribe,
            );

            // Store metadata for each token
            const startTime = market.startTime!;
            for (const tokenId of tokensToSubscribe) {
              await this.redisService.set(
                `token_metadata:${tokenId}`,
                JSON.stringify({
                  slug: market.slug,
                  baseSlug: market.type || null,
                  marketId: market.marketId,
                  startTimeMs: startTime.getTime(),
                  startTime: startTime.toISOString(),
                  discoveredAt: Date.now(),
                }),
                this.cacheTtl,
              );
            }

            // Subscribe to socket
            await this.ingestionService.subscribeToTokens(tokensToSubscribe);

            totalNewTokens += tokensToSubscribe.length;

            this.logger.log(
              `Subscribed to ${tokensToSubscribe.length} tokens for market ${market.slug}`,
            );
          }
        } catch (error) {
          this.logger.error(
            `Error processing market ${market.slug} for socket subscription:`,
            error.message,
          );
        }
      }

      if (totalNewTokens > 0) {
        this.logger.log(
          `Crawl job completed: subscribed to ${totalNewTokens} new tokens from ${marketsToCheck.length} markets`,
        );
      }
    } catch (error) {
      this.logger.error(
        'Error in crawl markets for socket subscription:',
        error.message,
      );
    }
  }

  /**
   * Discover market for a specific slug configuration
   * Processes 3 consecutive time intervals (current, +1, +2)
   * Example: 10:00, 10:15, 10:30 for 15m interval
   */
  private async discoverMarketForConfig(
    config: SlugConfig,
    stats: any,
  ): Promise<void> {
    try {
      stats.total++;

      // Process 3 consecutive time intervals: current (0), next (+1), and 2 intervals ahead (+2)
      const offsets = [0, 1, 2];
      let processedCount = 0;

      for (const offset of offsets) {
        try {
          const result = await this.processSlugForConfig(config, offset, stats);
          if (result) {
            processedCount++;
          }
        } catch (error) {
          this.logger.error(
            `Error processing offset ${offset} for [${config.crypto}] [${config.interval}]:`,
            error.message,
          );
        }
      }

      if (processedCount > 0) {
        stats.success++;
      } else {
        stats.failed++;
      }
    } catch (error) {
      stats.failed++;
      this.logger.error(
        `Error processing config [${config.crypto}] [${config.interval}]:`,
        error.message,
      );
      if (error.response) {
        this.logger.error('API Response:', error.response.data);
      }
    }
  }

  /**
   * Process a single slug for a specific configuration and offset
   * @returns true if successfully processed, false otherwise
   */
  private async processSlugForConfig(
    config: SlugConfig,
    offset: number,
    stats: any,
  ): Promise<boolean> {
    // Generate slug with offset
    const slug = this.utilService.generateSlugWithOffset(config, offset);
    const offsetLabel =
      offset === 0
        ? 'current'
        : offset === 1
          ? 'next'
          : `${offset} intervals ahead`;

    this.logger.log(
      `Processing [${config.crypto}] [${config.interval}] [${config.pattern}] (${offsetLabel}): ${slug}`,
    );

    // Check if this slug was already processed
    const cacheKey = `market_info:${slug}`;
    const cached = await this.redisService.get(cacheKey);

    if (cached) {
      this.logger.debug(`Market ${slug} already processed (cached)`);
      stats.cached++;
      return false;
    }

    // Fetch market data from API
    const marketData = await this.fetchMarketBySlug(slug);

    if (!marketData) {
      this.logger.debug(`No market data found for slug: ${slug}`);
      return false;
    }

    const startTime = this.extractStartTime(marketData);

    // Always save market entity to database (if not exists)
    await this.saveMarket(marketData, config.baseSlug);

    // Parse CLOB token IDs
    const tokenIds = this.utilService.parseClobTokenIds(marketData);

    if (tokenIds.length === 0) {
      this.logger.debug(`No token IDs found for slug: ${slug}`);
      return true; // Still consider it successful, market saved to DB
    }

    this.logger.log(`Found ${tokenIds.length} token IDs for ${slug}`);

    // Only cache Redis and subscribe socket when startTime < current time (market has started)
    const now = Date.now();
    if (!startTime || startTime.getTime() > now) {
      this.logger.log(
        `Skipping Redis cache and websocket subscribe for ${slug} (startTime=${startTime ? startTime.toISOString() : 'null'}, market not started yet)`,
      );
      return true; // Market saved to DB, but not subscribed yet
    }

    // Market has started (startTime < current), proceed with cache and subscription
    this.logger.log(
      `Market ${slug} has started (startTime=${startTime.toISOString()}), caching and subscribing...`,
    );

    // Cache the market data in Redis (only for started markets)
    await this.redisService.set(
      cacheKey,
      JSON.stringify(marketData),
      this.cacheTtl,
    );

    // Filter out already active tokens
    const newTokenIds = await this.filterNewTokens(tokenIds);

    if (newTokenIds.length === 0) {
      this.logger.debug(`No new tokens to subscribe for ${slug}`);
      return true; // Still consider it successful even if no new tokens
    }

    this.logger.log(
      `Subscribing to ${newTokenIds.length} new tokens for ${slug}`,
    );

    // Add to active tokens set with metadata
    await this.redisService.sadd('active_clob_tokens', ...newTokenIds);

    // Store metadata for each token
    for (const tokenId of newTokenIds) {
      await this.redisService.set(
        `token_metadata:${tokenId}`,
        JSON.stringify({
          slug,
          baseSlug: config.baseSlug,
          crypto: config.crypto,
          interval: config.interval,
          pattern: config.pattern,
          startTimeMs: startTime.getTime(),
          startTime: startTime.toISOString(),
          discoveredAt: Date.now(),
        }),
        this.cacheTtl,
      );
    }

    // Trigger ingestion service to start listening
    await this.ingestionService.subscribeToTokens(newTokenIds);

    stats.newTokens += newTokenIds.length;

    this.logger.log(
      `Successfully processed ${slug}: ${newTokenIds.length} new tokens`,
    );

    return true;
  }

  /**
   * Fetch market data from Polymarket API
   */
  async fetchMarketBySlug(slug: string): Promise<MarketApiResponse | null> {
    try {
      const url = `${this.apiUrl}/markets?slug=${slug}`;
      this.logger.debug(`Fetching: ${url}`);

      const response = await axios.get(url, {
        timeout: 10000,
        headers: {
          'User-Agent': 'PolymarketDataCollector/1.0',
        },
      });

      // API might return array or single object
      const data = Array.isArray(response.data)
        ? response.data[0]
        : response.data;

      return data || null;
    } catch (error) {
      if (error.response?.status === 404) {
        this.logger.warn(`Market not found: ${slug}`);
        return null;
      }
      throw error;
    }
  }

  /**
   * Filter out tokens that are already being tracked
   */
  private async filterNewTokens(tokenIds: string[]): Promise<string[]> {
    const newTokens: string[] = [];

    for (const tokenId of tokenIds) {
      const exists = await this.redisService.sismember(
        'active_clob_tokens',
        tokenId,
      );
      if (!exists) {
        newTokens.push(tokenId);
      }
    }

    return newTokens;
  }

  /**
   * Manual trigger for testing
   */
  async triggerDiscoveryManually(): Promise<void> {
    await this.handleMarketDiscovery();
  }

  /**
   * Manual trigger for specific crypto and interval
   */
  async triggerDiscoveryForConfig(
    crypto: string,
    interval: string,
  ): Promise<void> {
    const config = this.slugConfigs.find(
      (c) => c.crypto === crypto && c.interval === interval,
    );

    if (!config) {
      throw new Error(`No configuration found for ${crypto} ${interval}`);
    }

    const stats = { total: 0, success: 0, failed: 0, cached: 0, newTokens: 0 };
    await this.discoverMarketForConfig(config, stats);

    this.logger.log(
      `Discovery for ${crypto} ${interval}: ${JSON.stringify(stats)}`,
    );
  }

  /**
   * Get all active tokens
   */
  async getActiveTokens(): Promise<string[]> {
    return this.redisService.smembers('active_clob_tokens');
  }

  /**
   * Get active tokens with metadata
   */
  async getActiveTokensWithMetadata(): Promise<any[]> {
    const tokenIds = await this.getActiveTokens();
    const tokensWithMetadata = [];

    for (const tokenId of tokenIds) {
      const metadataStr = await this.redisService.get(
        `token_metadata:${tokenId}`,
      );
      const metadata = metadataStr ? JSON.parse(metadataStr) : null;

      tokensWithMetadata.push({
        tokenId,
        ...metadata,
      });
    }

    return tokensWithMetadata;
  }

  /**
   * Get all slug patterns that would be generated now
   */
  async getAllCurrentSlugs(): Promise<any[]> {
    return this.slugConfigs.map((config) => ({
      crypto: config.crypto,
      interval: config.interval,
      pattern: config.pattern,
      slug: this.utilService.generateSlug(config),
    }));
  }

  /**
   * Get market by slug from database
   */
  async getMarketBySlug(slug: string): Promise<Market | null> {
    try {
      const market = await this.marketRepository.findOne({
        where: { slug },
      });
      return market;
    } catch (error) {
      this.logger.error(
        `Error fetching market by slug ${slug}:`,
        error.message,
      );
      return null;
    }
  }

  /**
   * Save market entity to database if not exists
   */
  private async saveMarket(
    marketData: MarketApiResponse,
    baseSlug?: string,
  ): Promise<void> {
    try {
      // Parse clobTokenIds (handles stringified arrays)
      const clobTokenIds = this.utilService.parseClobTokenIds(marketData);

      // Parse dates
      const creationDate = marketData.creationDate
        ? new Date(marketData.creationDate)
        : marketData.createdAt
          ? new Date(marketData.createdAt)
          : null;

      const startTime = this.extractStartTime(marketData);

      const endDate = marketData.endDate
        ? new Date(marketData.endDate)
        : marketData.endTime
          ? new Date(marketData.endTime)
          : null;

      const { tokenYes, tokenNo } = this.extractYesNoTokens(
        marketData,
        clobTokenIds,
      );

      // Check if market already exists by marketId or slug
      const existingMarket = await this.marketRepository.findOne({
        where: [{ marketId: marketData.id }, { slug: marketData.slug }],
      });

      if (existingMarket) {
        let updated = false;

        // Backfill missing type (baseSlug)
        if (baseSlug && !existingMarket.type) {
          existingMarket.type = baseSlug;
          updated = true;
        }

        // Backfill missing yes/no tokens
        if (!existingMarket.tokenYes && tokenYes) {
          existingMarket.tokenYes = tokenYes;
          updated = true;
        }
        if (!existingMarket.tokenNo && tokenNo) {
          existingMarket.tokenNo = tokenNo;
          updated = true;
        }

        // Merge clob token ids if new ones appear
        if (clobTokenIds.length > 0) {
          const merged = Array.from(
            new Set([...(existingMarket.clobTokenIds || []), ...clobTokenIds]),
          );
          if (
            merged.length !== (existingMarket.clobTokenIds || []).length ||
            merged.some(
              (id, idx) => (existingMarket.clobTokenIds || [])[idx] !== id,
            )
          ) {
            existingMarket.clobTokenIds = merged;
            updated = true;
          }
        }

        // Fill missing dates if now available
        if (!existingMarket.creationDate && creationDate) {
          existingMarket.creationDate = creationDate;
          updated = true;
        }
        // Update startTime if missing or if new value is different
        if (startTime) {
          if (!existingMarket.startTime) {
            existingMarket.startTime = startTime;
            updated = true;
          } else if (
            existingMarket.startTime.getTime() !== startTime.getTime()
          ) {
            existingMarket.startTime = startTime;
            updated = true;
          }
        }
        if (!existingMarket.endDate && endDate) {
          existingMarket.endDate = endDate;
          updated = true;
        }

        if (updated) {
          await this.marketRepository.save(existingMarket);
          this.logger.log(
            `Updated existing market with tokens/dates: ${marketData.id} (${marketData.slug})`,
          );
        } else {
          this.logger.debug(
            `Market already exists with tokens: ${marketData.id} (${marketData.slug})`,
          );
        }
        return;
      }

      // Create market entity
      const market = this.marketRepository.create({
        marketId: marketData.id,
        question: marketData.question || null,
        conditionId: marketData.conditionId || marketData.condition_id || null,
        slug: marketData.slug || marketData.marketSlug || '',
        volume: marketData.volume ? String(marketData.volume) : null,
        active: marketData.active !== undefined ? marketData.active : true,
        closed: marketData.closed !== undefined ? marketData.closed : false,
        questionID: marketData.questionID || marketData.question_id || null,
        clobTokenIds: clobTokenIds.length > 0 ? clobTokenIds : null,
        tokenYes: tokenYes,
        tokenNo: tokenNo,
        creationDate: creationDate,
        startTime: startTime,
        endDate: endDate,
        type: baseSlug || null,
      });

      await this.marketRepository.save(market);
      this.logger.log(
        `Saved market entity: ${marketData.id} (${marketData.slug})`,
      );
    } catch (error) {
      // Handle unique constraint violation (market already exists)
      if (error.code === '23505') {
        this.logger.debug(
          `Market already exists (unique constraint): ${marketData.id}`,
        );
        return;
      }
      this.logger.error(
        `Error saving market entity ${marketData.id}:`,
        error.message,
      );
    }
  }

  /**
   * Extract start time from Polymarket API response.
   * Priority order:
   * 1. eventStartTime (root level)
   * 2. events[0].startTime or events[0].startDate
   * 3. startTime/startDate/start_time/start_date (root level)
   */
  private extractStartTime(marketData: MarketApiResponse): Date | null {
    let raw: any = null;

    // Priority 1: Check eventStartTime at root level
    if ((marketData as any).eventStartTime) {
      raw = (marketData as any).eventStartTime;
    }
    // Priority 2: Check events array
    else if (
      Array.isArray((marketData as any).events) &&
      (marketData as any).events.length > 0
    ) {
      const firstEvent = (marketData as any).events[0];
      raw =
        firstEvent.startTime ??
        firstEvent.startDate ??
        firstEvent.start_time ??
        firstEvent.start_date ??
        null;
    }
    // Priority 3: Check root level fields
    else {
      raw =
        (marketData as any).startTime ??
        (marketData as any).startDate ??
        (marketData as any).start_time ??
        (marketData as any).start_date ??
        null;
    }

    if (!raw) return null;

    // Already a Date
    if (raw instanceof Date) return raw;

    // Number (ms or seconds)
    if (typeof raw === 'number') {
      const ms = raw < 1e12 ? raw * 1000 : raw;
      const d = new Date(ms);
      return isNaN(d.getTime()) ? null : d;
    }

    // String (ISO or epoch)
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (!trimmed) return null;

      if (/^\d+$/.test(trimmed)) {
        const num = Number(trimmed);
        const ms = num < 1e12 ? num * 1000 : num;
        const d = new Date(ms);
        return isNaN(d.getTime()) ? null : d;
      }

      const d = new Date(trimmed);
      return isNaN(d.getTime()) ? null : d;
    }

    return null;
  }

  /**
   * Extract YES/NO token IDs from market data
   */
  private extractYesNoTokens(
    marketData: MarketApiResponse,
    clobTokenIds?: string[],
  ): { tokenYes: string | null; tokenNo: string | null } {
    const normalize = (val: any): string | null => {
      if (!val) return null;
      if (typeof val === 'string') {
        // Attempt JSON parse if it looks like an array/object
        if (
          (val.startsWith('[') && val.endsWith(']')) ||
          (val.startsWith('{') && val.endsWith('}'))
        ) {
          try {
            const parsed = JSON.parse(val);
            return normalize(parsed);
          } catch {
            return val;
          }
        }
        return val;
      }
      if (Array.isArray(val)) {
        return val.length > 0 ? normalize(val[0]) : null;
      }
      if (typeof val === 'object') {
        return (
          (val as any).token_id ||
          (val as any).tokenId ||
          (val as any).tokenID ||
          (val as any).id ||
          null
        );
      }
      return String(val);
    };

    let tokenYes =
      normalize(marketData.token_yes) ||
      normalize(marketData.tokenYes) ||
      normalize((marketData as any).token_yes) ||
      normalize((marketData as any).tokenYes);

    let tokenNo =
      normalize(marketData.token_no) ||
      normalize(marketData.tokenNo) ||
      normalize((marketData as any).token_no) ||
      normalize((marketData as any).tokenNo);

    const tokens = Array.isArray(marketData.tokens) ? marketData.tokens : [];

    for (const token of tokens) {
      if (!token || !token.outcome) continue;

      const outcome = String(token.outcome).toLowerCase();
      const tokenId =
        (token as any).token_id ||
        (token as any).tokenId ||
        (token as any).tokenID ||
        (token as any).id;

      if (outcome === 'yes' && !tokenYes && tokenId) {
        tokenYes = tokenId;
      } else if (outcome === 'no' && !tokenNo && tokenId) {
        tokenNo = tokenId;
      }

      if (tokenYes && tokenNo) {
        break;
      }
    }

    // If token_yes was an array with two entries, use second as no
    if (!tokenNo) {
      const rawYes =
        marketData.token_yes ||
        marketData.tokenYes ||
        (marketData as any).token_yes ||
        (marketData as any).tokenYes;
      if (Array.isArray(rawYes) && rawYes.length > 1) {
        tokenNo = normalize(rawYes[1]);
      } else if (typeof rawYes === 'string') {
        try {
          const parsed = JSON.parse(rawYes);
          if (Array.isArray(parsed) && parsed.length > 1) {
            tokenNo = normalize(parsed[1]);
          }
        } catch {
          // ignore
        }
      }
    }

    // Fallback: if still missing, try the first two clob token ids in order
    if ((!tokenYes || !tokenNo) && Array.isArray(clobTokenIds)) {
      if (!tokenYes && clobTokenIds.length > 0) {
        tokenYes = normalize(clobTokenIds[0]);
      }
      if (!tokenNo && clobTokenIds.length > 1) {
        tokenNo = normalize(clobTokenIds[1]);
      }
    }

    return {
      tokenYes: tokenYes || null,
      tokenNo: tokenNo || null,
    };
  }
}
