import { Injectable, Logger } from '@nestjs/common';
import { ClickHouseService } from '../../common/services/clickhouse.service';

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
  private readonly orderbookTable = 'market_orderbooks_analytics';

  constructor(
    private readonly clickHouseService: ClickHouseService,
  ) {}

  /**
   * Calculate arbitrage opportunities between two assets
   * Optimized for ClickHouse by using indexed joins on timestamp and precomputed best bid/ask columns
   */
  async getArbitrageInsights(
    query: ArbitrageInsightQuery,
  ): Promise<ArbitrageInsightResponse> {
    const { assetIdA, assetIdB, startTime, endTime, limit = 100 } = query;

    this.logger.log(
      `Fetching arbitrage insights for ${assetIdA} and ${assetIdB}`,
    );

    const whereClausesA = [
      'asset_id = {assetIdA:String}',
      'isFinite(best_ask)',
      'isFinite(best_bid)',
    ];
    const whereClausesB = [
      'asset_id = {assetIdB:String}',
      'isFinite(best_ask)',
      'isFinite(best_bid)',
    ];

    if (startTime) {
      whereClausesA.push('timestamp >= toDateTime64({startTime:UInt64}, 3)');
      whereClausesB.push('timestamp >= toDateTime64({startTime:UInt64}, 3)');
    }

    if (endTime) {
      whereClausesA.push('timestamp <= toDateTime64({endTime:UInt64}, 3)');
      whereClausesB.push('timestamp <= toDateTime64({endTime:UInt64}, 3)');
    }

    const whereA = whereClausesA.join(' AND ');
    const whereB = whereClausesB.join(' AND ');

    const rawQuery = `
      WITH
        orderbook_a AS (
          SELECT 
            timestamp,
            asset_id,
            best_ask AS min_ask,
            best_bid AS max_bid
          FROM ${this.orderbookTable}
          WHERE ${whereA}
          ORDER BY timestamp DESC
          LIMIT {limit:Int32}
        ),
        orderbook_b AS (
          SELECT 
            timestamp,
            asset_id,
            best_ask AS min_ask,
            best_bid AS max_bid
          FROM ${this.orderbookTable}
          WHERE ${whereB}
          ORDER BY timestamp DESC
          LIMIT {limit:Int32}
        )
      SELECT 
        a.timestamp,
        a.asset_id as asset_id_a,
        b.asset_id as asset_id_b,
        a.min_ask as min_ask_a,
        a.max_bid as max_bid_a,
        b.min_ask as min_ask_b,
        b.max_bid as max_bid_b,
        (a.min_ask + b.min_ask) as arbitrage_under_1_value,
        (a.max_bid + b.max_bid) as arbitrage_over_101_value
      FROM orderbook_a a
      INNER JOIN orderbook_b b ON a.timestamp = b.timestamp
      ORDER BY a.timestamp DESC
      LIMIT {limit:Int32}
    `;

    const params: Record<string, any> = {
      assetIdA,
      assetIdB,
      limit,
    };

    if (startTime) {
      params.startTime = startTime;
    }

    if (endTime) {
      params.endTime = endTime;
    }

    try {
      const results = await this.clickHouseService.query<any>(
        rawQuery,
        params,
      );

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
      SELECT 
        asset_id,
        timestamp,
        best_ask as min_ask,
        best_bid as max_bid,
        asks_price,
        asks_size,
        bids_price,
        bids_size,
        length(asks_price) as ask_count,
        length(bids_price) as bid_count,
        asks_price[1] as first_ask_price,
        asks_size[1] as first_ask_size,
        bids_price[1] as first_bid_price,
        bids_size[1] as first_bid_size
      FROM ${this.orderbookTable}
      WHERE asset_id IN ({assetIds:Array(String)})
        AND isFinite(best_ask)
        AND isFinite(best_bid)
      ORDER BY asset_id, timestamp DESC
      LIMIT 5 BY asset_id
    `;

    try {
      const results = await this.clickHouseService.query<any>(query, {
        assetIds: [assetIdA, assetIdB],
      });

      return results.map((row: any) => {
        const source =
          row.asset_id === assetIdA
            ? 'Asset A'
            : row.asset_id === assetIdB
              ? 'Asset B'
              : 'Unknown';

        return {
          source,
          asset_id: row.asset_id,
          timestamp: row.timestamp,
          min_ask: row.min_ask !== null ? parseFloat(row.min_ask) : null,
          max_bid: row.max_bid !== null ? parseFloat(row.max_bid) : null,
          first_ask_level:
            row.first_ask_price !== null && row.first_ask_size !== null
              ? { price: row.first_ask_price, size: row.first_ask_size }
              : null,
          first_bid_level:
            row.first_bid_price !== null && row.first_bid_size !== null
              ? { price: row.first_bid_price, size: row.first_bid_size }
              : null,
          ask_count: row.ask_count !== null ? parseInt(row.ask_count) : 0,
          bid_count: row.bid_count !== null ? parseInt(row.bid_count) : 0,
        };
      });
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

    const query = `
      WITH recent_orderbooks AS (
        SELECT 
          asset_id,
          timestamp,
          best_ask,
          best_bid,
          market_slug,
          market_id,
          asks_price,
          asks_size,
          bids_price,
          bids_size,
          length(asks_price) as asks_count,
          length(bids_price) as bids_count
        FROM ${this.orderbookTable}
        WHERE timestamp > now() - INTERVAL 1 HOUR
          AND isFinite(best_ask)
          AND isFinite(best_bid)
          AND market_id != ''
      ),
      asset_pairs AS (
        SELECT 
          a.asset_id as asset_id_a,
          b.asset_id as asset_id_b,
          a.best_ask as min_ask_a,
          b.best_ask as min_ask_b,
          a.best_bid as max_bid_a,
          b.best_bid as max_bid_b,
          (a.best_ask + b.best_ask) as total_cost,
          (a.best_bid + b.best_bid) as total_payout,
          a.timestamp,
          a.asks_count as asks_count_a,
          a.bids_count as bids_count_a,
          b.asks_count as asks_count_b,
          b.bids_count as bids_count_b,
          a.market_id,
          a.market_slug as slug_a,
          b.market_slug as slug_b
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
        asks_count_a,
        bids_count_a,
        asks_count_b,
        bids_count_b,
        market_id,
        slug_a,
        slug_b
      FROM asset_pairs
      WHERE (total_cost < 0.98 OR total_payout > 1.01)
      ORDER BY 
        (if(total_cost < 0.98, (0.98 - total_cost), 0)) +
        (if(total_payout > 1.01, (total_payout - 1.01), 0)) DESC
      LIMIT 50
    `;

    try {
      const results = await this.clickHouseService.query<any>(query);

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
            asksCount: row.asks_count_a !== null ? parseInt(row.asks_count_a) : 0,
            bidsCount: row.bids_count_a !== null ? parseInt(row.bids_count_a) : 0,
          },
          orderBookB: {
            timestamp: row.timestamp,
            minAsk: parseFloat(row.min_ask_b),
            maxBid: parseFloat(row.max_bid_b),
            asksCount: row.asks_count_b !== null ? parseInt(row.asks_count_b) : 0,
            bidsCount: row.bids_count_b !== null ? parseInt(row.bids_count_b) : 0,
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
        countDistinct(a.timestamp) as common_timestamps
      FROM (
        SELECT DISTINCT asset_id, timestamp
        FROM ${this.orderbookTable}
        WHERE timestamp > now() - INTERVAL 24 HOUR
      ) a
      INNER JOIN (
        SELECT DISTINCT asset_id, timestamp
        FROM ${this.orderbookTable}
        WHERE timestamp > now() - INTERVAL 24 HOUR
      ) b ON a.timestamp = b.timestamp AND a.asset_id < b.asset_id
      GROUP BY a.asset_id, b.asset_id
      HAVING common_timestamps > 10
      ORDER BY common_timestamps DESC
      LIMIT 50
    `;

    try {
      const results = await this.clickHouseService.query<any>(query);
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
