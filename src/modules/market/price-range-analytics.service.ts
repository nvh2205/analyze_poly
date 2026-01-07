import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../common/services/redis.service';

export interface PriceRangeAnalyticsQuery {
  type: string;
  tokenSide?: 'yes' | 'no';
  startTime?: number; // Unix timestamp
  endTime?: number; // Unix timestamp
  refresh?: boolean;
}

export interface PriceRange {
  idx: number;
  lo: number;
  hi: number;
  center: number;
  width: number;
}

export interface RangeStats {
  range: { lo: number; hi: number };
  entries: number;
  total_dwell_secs: number;
  avg_dwell_secs: number;
  hold_count: number;
  hold_percentage: number;
  breakout_up_count: number;
  breakout_down_count: number;
  breakout_up_pct: number;
  breakout_down_pct: number;
  next_range_after_breakout_up: Record<number, number>;
  next_range_after_breakout_down: Record<number, number>;
}

export interface EdgeSetup {
  range_idx: number;
  range: { lo: number; hi: number };
  direction: string;
  p_target: number;
  n_samples: number;
  ci_lower: number;
  ci_upper: number;
  ci_width: number;
  target_range_idx: number;
  stop_range_idx: number;
  reward_cents: number;
  risk_cents: number;
  expected_value: number;
  reward_risk_ratio: number;
  sharpe_like: number;
  avg_time_to_target: number;
  avg_time_to_stop: number;
  edge_score: number;
}

export interface AnalyticsPayload {
  metadata: {
    market_type: string;
    token_side: string;
    analysis_start: string;
    analysis_end: string;
    generated_at: string;
    version: string;
    total_markets: number;
    total_samples: number;
    config: Record<string, any>;
  };
  ranges: PriceRange[];
  range_stats: RangeStats[];
  first_passage: any[];
  top_edges: EdgeSetup[];
  edge_summary: {
    total_edges: number;
    avg_p_target: number;
    avg_ev: number;
    avg_reward_risk: number;
    avg_samples: number;
    max_ev?: number;
    max_p_target?: number;
  };
}

@Injectable()
export class PriceRangeAnalyticsService {
  private readonly logger = new Logger(PriceRangeAnalyticsService.name);
  private readonly redisKeyPrefix = 'analytics:range';

  constructor(private readonly redisService: RedisService) {}

  /**
   * Get price range analytics from Redis cache
   */
  async getAnalytics(
    query: PriceRangeAnalyticsQuery,
  ): Promise<AnalyticsPayload | null> {
    const { type, tokenSide = 'yes', startTime, endTime } = query;

    this.logger.log(
      `Fetching analytics for type=${type}, side=${tokenSide}, start=${startTime}, end=${endTime}`,
    );

    try {
      // Try specific time window first if provided
      if (startTime && endTime) {
        const key = `${this.redisKeyPrefix}:${type}:${tokenSide}:${startTime}:${endTime}`;
        const cached = await this.redisService.get(key);

        if (cached) {
          this.logger.log(`Cache hit: ${key}`);
          return JSON.parse(cached);
        }
      }

      // Fall back to latest
      const latestKey = `${this.redisKeyPrefix}:${type}:${tokenSide}:latest`;
      const latestCached = await this.redisService.get(latestKey);

      if (latestCached) {
        this.logger.log(`Cache hit (latest): ${latestKey}`);
        return JSON.parse(latestCached);
      }

      this.logger.warn(`No cached analytics found for ${type}:${tokenSide}`);
      return null;
    } catch (error) {
      this.logger.error('Error fetching analytics from Redis:', error);
      throw error;
    }
  }



  /**
   * Get range statistics for a market type
   */
  // async getRangeStats(
  //   type: string,
  //   tokenSide: string = 'yes',
  // ): Promise<{ ranges: PriceRange[]; stats: RangeStats[] } | null> {
  //   const analytics = await this.getAnalytics({ type, tokenSide });

  //   if (!analytics) {
  //     return null;
  //   }

  //   return {
  //     ranges: analytics.ranges,
  //     stats: analytics.range_stats,
  //   };
  // }

  /**
   * Get edge summary for a market type
   */
  // async getEdgeSummary(
  //   type: string,
  //   tokenSide: string = 'yes',
  // ): Promise<AnalyticsPayload['edge_summary'] | null> {
  //   const analytics = await this.getAnalytics({ type, tokenSide });

  //   if (!analytics) {
  //     return null;
  //   }

  //   return analytics.edge_summary;
  // }

  /**
   * Check if analytics exist for a market type
   */
  async hasAnalytics(type: string, tokenSide: string = 'yes'): Promise<boolean> {
    const latestKey = `${this.redisKeyPrefix}:${type}:${tokenSide}:latest`;
    const exists = await this.redisService.exists(latestKey);
    return exists > 0;
  }

  /**
   * List available market types with analytics
   */
  async listAvailableTypes(): Promise<string[]> {
    try {
      const pattern = `${this.redisKeyPrefix}:*:*:latest`;
      const keys = await this.redisService.keys(pattern);

      // Extract market types from keys
      const types = new Set<string>();
      for (const key of keys) {
        const parts = key.split(':');
        if (parts.length >= 4) {
          const marketType = parts[2]; // analytics:range:{type}:{side}:latest
          types.add(marketType);
        }
      }

      return Array.from(types);
    } catch (error) {
      this.logger.error('Error listing available types:', error);
      return [];
    }
  }
}

