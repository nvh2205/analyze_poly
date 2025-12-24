import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MarketOrderbook } from '../../database/entities/market-orderbook.entity';

export interface ArbitrageInsightQuery {
  assetIdA: string;
  assetIdB: string;
  startTime?: number; // Unix timestamp
  endTime?: number; // Unix timestamp
  limit?: number;
}

export interface ArbitrageOpportunity {
  timestamp: string;
  assetIdA: string;
  assetIdB: string;

  // Arbitrage under 0.98 (total cost of buying both outcomes < 0.98)
  arbitrageUnder1: {
    value: number; // min(asks_A) + min(asks_B)
    minAskAssetA: number;
    minAskAssetB: number;
    profitable: boolean; // value < 0.98 (means total cost < 0.98)
  };

  // Arbitrage over 1.01 (total payout from selling both outcomes > 1.01)
  arbitrageOver101: {
    value: number; // max(bids_A) + max(bids_B)
    maxBidAssetA: number;
    maxBidAssetB: number;
    profitable: boolean; // value > 1.01
  };
}

export interface ArbitrageInsightResponse {
  summary: {
    totalOpportunities: number;
    profitableUnder098: number;
    profitableOver101: number;
    timeRange: {
      start: string;
      end: string;
    };
  };
  opportunities: ArbitrageOpportunity[];
}

@Injectable()
export class ArbitrageInsightService {
  private readonly logger = new Logger(ArbitrageInsightService.name);

  constructor(
    @InjectRepository(MarketOrderbook)
    private readonly orderbookRepository: Repository<MarketOrderbook>,
  ) {}

  /**
   * Calculate arbitrage opportunities between two assets
   * Optimized for large database by using indexed queries and JSONB operations
   */
  async getArbitrageInsights(
    query: ArbitrageInsightQuery,
  ): Promise<ArbitrageInsightResponse> {
    const { assetIdA, assetIdB, startTime, endTime, limit = 100 } = query;

    this.logger.log(
      `Fetching arbitrage insights for ${assetIdA} and ${assetIdB}`,
    );

    // Build optimized SQL query that:
    // 1. Uses indexes (asset_id, timestamp)
    // 2. Joins on same timestamp
    // 3. Extracts JSONB data efficiently
    // 4. Limits result set
    const rawQuery = `
      WITH orderbook_a AS (
      (
        SELECT 
          timestamp,
          asset_id,
          (
            SELECT MIN((elem->>'price')::numeric)
            FROM jsonb_array_elements(asks) elem
            WHERE (elem->>'price') IS NOT NULL
          ) as min_ask,
          (
            SELECT MAX((elem->>'price')::numeric)
            FROM jsonb_array_elements(bids) elem
            WHERE (elem->>'price') IS NOT NULL
          ) as max_bid,
          created_at
        FROM market_orderbooks
        WHERE asset_id = $1
          ${startTime ? 'AND timestamp >= $3' : ''}
          ${endTime ? `AND timestamp <= $${startTime ? '4' : '3'}` : ''}
          AND asks IS NOT NULL 
          AND bids IS NOT NULL
          AND jsonb_array_length(asks) > 0
          AND jsonb_array_length(bids) > 0
        ORDER BY timestamp DESC
        LIMIT $${endTime ? (startTime ? '5' : '4') : startTime ? '4' : '3'}
      )
      ),
      orderbook_b AS (
      (
        SELECT 
          timestamp,
          asset_id,
          (
            SELECT MIN((elem->>'price')::numeric)
            FROM jsonb_array_elements(asks) elem
            WHERE (elem->>'price') IS NOT NULL
          ) as min_ask,
          (
            SELECT MAX((elem->>'price')::numeric)
            FROM jsonb_array_elements(bids) elem
            WHERE (elem->>'price') IS NOT NULL
          ) as max_bid,
          created_at
        FROM market_orderbooks
        WHERE asset_id = $2
          ${startTime ? 'AND timestamp >= $3' : ''}
          ${endTime ? `AND timestamp <= $${startTime ? '4' : '3'}` : ''}
          AND asks IS NOT NULL 
          AND bids IS NOT NULL
          AND jsonb_array_length(asks) > 0
          AND jsonb_array_length(bids) > 0
        ORDER BY timestamp DESC
      )
      )
      SELECT 
        a.timestamp,
        a.asset_id as asset_id_a,
        b.asset_id as asset_id_b,
        a.min_ask as min_ask_a,
        a.max_bid as max_bid_a,
        b.min_ask as min_ask_b,
        b.max_bid as max_bid_b,
        -- Arbitrage under 1: min(asks_A) + min(asks_B)
        (a.min_ask + b.min_ask) as arbitrage_under_1_value,
        -- Arbitrage over 1.01: max(bids_A) + max(bids_B)
        (a.max_bid + b.max_bid) as arbitrage_over_101_value,
        a.created_at
      FROM orderbook_a a
      INNER JOIN orderbook_b b ON a.timestamp = b.timestamp
      ORDER BY a.timestamp DESC
    `;

    // Build parameters array dynamically
    const params: any[] = [assetIdA, assetIdB];
    if (startTime) params.push(startTime);
    if (endTime) params.push(endTime);
    params.push(limit);

    try {
      const results = await this.orderbookRepository.query(rawQuery, params);

      // Log raw results for debugging
      if (results.length > 0) {
        this.logger.log(
          `[ARBITRAGE DEBUG] Query params: assetIdA=${assetIdA}, assetIdB=${assetIdB}`,
        );
        this.logger.log(
          `[ARBITRAGE DEBUG] Raw result: ${JSON.stringify({
            timestamp: results[0].timestamp,
            asset_id_a: results[0].asset_id_a,
            asset_id_b: results[0].asset_id_b,
            min_ask_a: results[0].min_ask_a,
            min_ask_b: results[0].min_ask_b,
            max_bid_a: results[0].max_bid_a,
            max_bid_b: results[0].max_bid_b,
          })}`,
        );
      }

      // Transform results into structured response
      const opportunities: ArbitrageOpportunity[] = results.map((row: any) => ({
        timestamp: row.timestamp,
        assetIdA: row.asset_id_a,
        assetIdB: row.asset_id_b,
        arbitrageUnder1: {
          value: parseFloat(row.arbitrage_under_1_value),
          minAskAssetA: parseFloat(row.min_ask_a),
          minAskAssetB: parseFloat(row.min_ask_b),
          profitable: parseFloat(row.arbitrage_under_1_value) < 0.98,
        },
        arbitrageOver101: {
          value: parseFloat(row.arbitrage_over_101_value),
          maxBidAssetA: parseFloat(row.max_bid_a),
          maxBidAssetB: parseFloat(row.max_bid_b),
          profitable: parseFloat(row.arbitrage_over_101_value) > 1.01,
        },
      }));

      // Calculate summary statistics
      const profitableUnder098 = opportunities.filter(
        (opp) => opp.arbitrageUnder1.profitable,
      ).length;
      const profitableOver101 = opportunities.filter(
        (opp) => opp.arbitrageOver101.profitable,
      ).length;

      const timeRange = {
        start:
          opportunities.length > 0
            ? opportunities[opportunities.length - 1].timestamp
            : 'N/A',
        end: opportunities.length > 0 ? opportunities[0].timestamp : 'N/A',
      };

      return {
        summary: {
          totalOpportunities: opportunities.length,
          profitableUnder098,
          profitableOver101,
          timeRange,
        },
        opportunities,
      };
    } catch (error) {
      this.logger.error('Error fetching arbitrage insights:', error);
      throw error;
    }
  }

  /**
   * Get latest arbitrage opportunity for two assets
   */
  async getLatestArbitrageOpportunity(
    assetIdA: string,
    assetIdB: string,
  ): Promise<ArbitrageOpportunity | null> {
    const result = await this.getArbitrageInsights({
      assetIdA,
      assetIdB,
      limit: 1,
    });

    return result.opportunities.length > 0 ? result.opportunities[0] : null;
  }

  /**
   * Get arbitrage statistics over a time period
   */
  async getArbitrageStatistics(
    assetIdA: string,
    assetIdB: string,
    startTime: number,
    endTime: number,
  ): Promise<{
    totalSamples: number;
    profitableUnder098Count: number;
    profitableOver101Count: number;
    avgArbitrageUnder1: number;
    avgArbitrageOver101: number;
    maxArbitrageUnder1: number;
    maxArbitrageOver101: number;
    minArbitrageUnder1: number;
    minArbitrageOver101: number;
  }> {
    const insights = await this.getArbitrageInsights({
      assetIdA,
      assetIdB,
      startTime,
      endTime,
      limit: 10000, // Larger limit for statistical analysis
    });

    const opportunities = insights.opportunities;

    if (opportunities.length === 0) {
      return {
        totalSamples: 0,
        profitableUnder098Count: 0,
        profitableOver101Count: 0,
        avgArbitrageUnder1: 0,
        avgArbitrageOver101: 0,
        maxArbitrageUnder1: 0,
        maxArbitrageOver101: 0,
        minArbitrageUnder1: 0,
        minArbitrageOver101: 0,
      };
    }

    const under1Values = opportunities.map((opp) => opp.arbitrageUnder1.value);
    const over101Values = opportunities.map(
      (opp) => opp.arbitrageOver101.value,
    );

    return {
      totalSamples: opportunities.length,
      profitableUnder098Count: insights.summary.profitableUnder098,
      profitableOver101Count: insights.summary.profitableOver101,
      avgArbitrageUnder1:
        under1Values.reduce((a, b) => a + b, 0) / under1Values.length,
      avgArbitrageOver101:
        over101Values.reduce((a, b) => a + b, 0) / over101Values.length,
      maxArbitrageUnder1: Math.max(...under1Values),
      maxArbitrageOver101: Math.max(...over101Values),
      minArbitrageUnder1: Math.min(...under1Values),
      minArbitrageOver101: Math.min(...over101Values),
    };
  }

  /**
   * Debug method to get raw orderbook data for specific assets
   */
  async getOrderbookDebug(assetIdA: string, assetIdB: string): Promise<any> {
    const query = `
      (
        SELECT 
          'Asset A' as source,
          asset_id,
          timestamp,
          (
            SELECT MIN((elem->>'price')::numeric)
            FROM jsonb_array_elements(asks) elem
            WHERE (elem->>'price') IS NOT NULL
          ) as min_ask,
          (
            SELECT MAX((elem->>'price')::numeric)
            FROM jsonb_array_elements(bids) elem
            WHERE (elem->>'price') IS NOT NULL
          ) as max_bid,
          asks->0 as first_ask_level,
          bids->0 as first_bid_level,
          jsonb_array_length(asks) as ask_count,
          jsonb_array_length(bids) as bid_count,
          created_at
        FROM market_orderbooks
        WHERE asset_id = $1
          AND asks IS NOT NULL 
          AND bids IS NOT NULL
          AND jsonb_array_length(asks) > 0
          AND jsonb_array_length(bids) > 0
        ORDER BY timestamp DESC
        LIMIT 5
      )
      
      UNION ALL
      
      (
        SELECT 
          'Asset B' as source,
          asset_id,
          timestamp,
          (
            SELECT MIN((elem->>'price')::numeric)
            FROM jsonb_array_elements(asks) elem
            WHERE (elem->>'price') IS NOT NULL
          ) as min_ask,
          (
            SELECT MAX((elem->>'price')::numeric)
            FROM jsonb_array_elements(bids) elem
            WHERE (elem->>'price') IS NOT NULL
          ) as max_bid,
          asks->0 as first_ask_level,
          bids->0 as first_bid_level,
          jsonb_array_length(asks) as ask_count,
          jsonb_array_length(bids) as bid_count,
          created_at
        FROM market_orderbooks
        WHERE asset_id = $2
          AND asks IS NOT NULL 
          AND bids IS NOT NULL
          AND jsonb_array_length(asks) > 0
          AND jsonb_array_length(bids) > 0
        ORDER BY timestamp DESC
        LIMIT 5
      )
      ORDER BY source, timestamp DESC
    `;

    try {
      const results = await this.orderbookRepository.query(query, [
        assetIdA,
        assetIdB,
      ]);
      return results;
    } catch (error) {
      this.logger.error('Error in getOrderbookDebug:', error);
      throw error;
    }
  }

  /**
   * Get profitable arbitrage opportunities across all available asset pairs
   */
  async getProfitableArbitrageOpportunities(): Promise<{
    totalPairsChecked: number;
    profitableOpportunities: Array<{
      assetIdA: string;
      assetIdB: string;
      marketA?: any;
      marketB?: any;
      latestOpportunity: ArbitrageOpportunity;
      profitableTypes: string[];
    }>;
  }> {
    this.logger.log('Scanning for profitable arbitrage opportunities...');

    // Get available pairs
    const pairs = await this.getAvailableAssetPairs();
    const profitableOpportunities = [];

    // Check each pair for profitable opportunities
    for (const pair of pairs) {
      try {
        const opportunity = await this.getLatestArbitrageOpportunity(
          pair.assetIdA,
          pair.assetIdB,
        );

        if (opportunity) {
          const profitableTypes = [];

          if (opportunity.arbitrageUnder1.profitable) {
            profitableTypes.push('under_0.98');
          }

          if (opportunity.arbitrageOver101.profitable) {
            profitableTypes.push('over_1.01');
          }

          // Only add if at least one type is profitable
          if (profitableTypes.length > 0) {
            profitableOpportunities.push({
              assetIdA: pair.assetIdA,
              assetIdB: pair.assetIdB,
              latestOpportunity: opportunity,
              profitableTypes,
            });
          }
        }
      } catch (error) {
        this.logger.error(
          `Error checking pair ${pair.assetIdA} / ${pair.assetIdB}:`,
          error.message,
        );
      }
    }

    this.logger.log(
      `Found ${profitableOpportunities.length} profitable opportunities out of ${pairs.length} pairs`,
    );

    return {
      totalPairsChecked: pairs.length,
      profitableOpportunities,
    };
  }

  /**
   * Get profitable opportunities with market details
   */
  async getProfitableArbitrageWithMarketDetails(): Promise<{
    totalPairsChecked: number;
    profitableCount: number;
    opportunities: Array<{
      assetIdA: string;
      assetIdB: string;
      market: {
        marketId: string;
        slugA: string;
        slugB: string;
      };
      orderBookA: any;
      orderBookB: any;
      arbitrage: ArbitrageOpportunity;
      profitableTypes: string[];
      profitAmount: {
        under098?: number;
        over101?: number;
      };
    }>;
  }> {
    this.logger.log(
      'Scanning for profitable arbitrage with market details (same market & timestamp)...',
    );

    // Query to get profitable pairs with market and orderbook info
    // IMPORTANT: Both assets must be from same market (same market_id) and same timestamp
    const query = `
      WITH recent_orderbooks AS (
        SELECT 
          asset_id,
          timestamp,
          market_id,
          slug,
          (
            SELECT MIN((elem->>'price')::numeric)
            FROM jsonb_array_elements(asks) elem
            WHERE (elem->>'price') IS NOT NULL
          ) as min_ask,
          (
            SELECT MAX((elem->>'price')::numeric)
            FROM jsonb_array_elements(bids) elem
            WHERE (elem->>'price') IS NOT NULL
          ) as max_bid,
          asks,
          bids,
          last_trade_price,
          created_at
        FROM market_orderbooks
        WHERE created_at > NOW() - INTERVAL '1 hour'
          AND asks IS NOT NULL
          AND bids IS NOT NULL
          AND jsonb_array_length(asks) > 0
          AND jsonb_array_length(bids) > 0
          AND market_id IS NOT NULL
      ),
      asset_pairs AS (
        SELECT 
          a.asset_id as asset_id_a,
          b.asset_id as asset_id_b,
          a.min_ask as min_ask_a,
          b.min_ask as min_ask_b,
          a.max_bid as max_bid_a,
          b.max_bid as max_bid_b,
          (a.min_ask + b.min_ask) as total_cost,
          (a.max_bid + b.max_bid) as total_payout,
          a.timestamp,
          a.asks as asks_a,
          a.bids as bids_a,
          b.asks as asks_b,
          b.bids as bids_b,
          a.last_trade_price as last_price_a,
          b.last_trade_price as last_price_b,
          a.market_id,
          a.slug as slug_a,
          b.slug as slug_b
        FROM recent_orderbooks a
        INNER JOIN recent_orderbooks b 
          ON a.market_id = b.market_id 
          AND a.timestamp = b.timestamp
          AND a.asset_id < b.asset_id
      )
      SELECT 
        asset_id_a,
        asset_id_b,
        min_ask_a,
        min_ask_b,
        max_bid_a,
        max_bid_b,
        total_cost,
        total_payout,
        (total_cost < 0.98) as profitable_under,
        (total_payout > 1.01) as profitable_over,
        timestamp,
        asks_a,
        bids_a,
        asks_b,
        bids_b,
        last_price_a,
        last_price_b,
        market_id,
        slug_a,
        slug_b
      FROM asset_pairs
      WHERE (total_cost < 0.98 OR total_payout > 1.01)
      ORDER BY 
        CASE 
          WHEN total_cost < 0.98 THEN (0.98 - total_cost)
          ELSE 0
        END +
        CASE
          WHEN total_payout > 1.01 THEN (total_payout - 1.01)
          ELSE 0
        END DESC
      LIMIT 50
    `;

    try {
      const results = await this.orderbookRepository.query(query);

      const opportunities = results.map((row: any) => {
        const profitableTypes = [];
        const profitAmount: any = {};

        if (row.profitable_under) {
          profitableTypes.push('under_0.98');
          profitAmount.under098 = 0.98 - parseFloat(row.total_cost);
        }

        if (row.profitable_over) {
          profitableTypes.push('over_1.01');
          profitAmount.over101 = parseFloat(row.total_payout) - 1.01;
        }

        return {
          assetIdA: row.asset_id_a,
          assetIdB: row.asset_id_b,
          market: {
            marketId: row.market_id,
            slugA: row.slug_a,
            slugB: row.slug_b,
          },
          orderBookA: {
            timestamp: row.timestamp,
            minAsk: parseFloat(row.min_ask_a),
            maxBid: parseFloat(row.max_bid_a),
            lastTradePrice: row.last_price_a,
            asksCount: row.asks_a ? row.asks_a.length : 0,
            bidsCount: row.bids_a ? row.bids_a.length : 0,
          },
          orderBookB: {
            timestamp: row.timestamp,
            minAsk: parseFloat(row.min_ask_b),
            maxBid: parseFloat(row.max_bid_b),
            lastTradePrice: row.last_price_b,
            asksCount: row.asks_b ? row.asks_b.length : 0,
            bidsCount: row.bids_b ? row.bids_b.length : 0,
          },
          arbitrage: {
            timestamp: row.timestamp,
            assetIdA: row.asset_id_a,
            assetIdB: row.asset_id_b,
            arbitrageUnder1: {
              value: parseFloat(row.total_cost),
              minAskAssetA: parseFloat(row.min_ask_a),
              minAskAssetB: parseFloat(row.min_ask_b),
              profitable: row.profitable_under,
            },
            arbitrageOver101: {
              value: parseFloat(row.total_payout),
              maxBidAssetA: parseFloat(row.max_bid_a),
              maxBidAssetB: parseFloat(row.max_bid_b),
              profitable: row.profitable_over,
            },
          },
          profitableTypes,
          profitAmount,
        };
      });

      return {
        totalPairsChecked: results.length,
        profitableCount: opportunities.length,
        opportunities,
      };
    } catch (error) {
      this.logger.error('Error getting profitable opportunities:', error);
      throw error;
    }
  }

  /**
   * Get all available asset pairs for arbitrage analysis
   */
  async getAvailableAssetPairs(): Promise<
    Array<{ assetIdA: string; assetIdB: string; commonTimestamps: number }>
  > {
    const query = `
      SELECT 
        a.asset_id as asset_id_a,
        b.asset_id as asset_id_b,
        COUNT(DISTINCT a.timestamp) as common_timestamps
      FROM (
        SELECT DISTINCT asset_id, timestamp
        FROM market_orderbooks
        WHERE created_at > NOW() - INTERVAL '24 hours'
      ) a
      INNER JOIN (
        SELECT DISTINCT asset_id, timestamp
        FROM market_orderbooks
        WHERE created_at > NOW() - INTERVAL '24 hours'
      ) b ON a.timestamp = b.timestamp AND a.asset_id < b.asset_id
      GROUP BY a.asset_id, b.asset_id
      HAVING COUNT(DISTINCT a.timestamp) > 10
      ORDER BY common_timestamps DESC
      LIMIT 50
    `;

    try {
      const results = await this.orderbookRepository.query(query);
      return results.map((row: any) => ({
        assetIdA: row.asset_id_a,
        assetIdB: row.asset_id_b,
        commonTimestamps: parseInt(row.common_timestamps),
      }));
    } catch (error) {
      this.logger.error('Error fetching available asset pairs:', error);
      throw error;
    }
  }
}
