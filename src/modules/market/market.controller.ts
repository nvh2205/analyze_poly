import {
  Controller,
  Get,
  Post,
  Query,
  Delete,
  HttpCode,
  HttpStatus,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiQuery,
  ApiOkResponse,
} from '@nestjs/swagger';
import { MarketService } from './market.service';
import { RedisService } from '../../common/services/redis.service';
import { ArbitrageInsightService } from './arbitrage-insight.service';

@ApiTags('market')
@Controller('market')
export class MarketController {
  private readonly logger = new Logger(MarketController.name);

  constructor(
    private readonly marketService: MarketService,
    private readonly redisService: RedisService,
    private readonly arbitrageInsightService: ArbitrageInsightService,
  ) {}

  @Get('active-tokens')
  @ApiOperation({ summary: 'Get all active token IDs' })
  @ApiOkResponse({
    description: 'List of active token IDs',
    schema: {
      type: 'object',
      properties: {
        count: { type: 'number', example: 10 },
        tokens: {
          type: 'array',
          items: { type: 'string' },
          example: ['token1', 'token2', 'token3'],
        },
      },
    },
  })
  async getActiveTokens() {
    const tokens = await this.marketService.getActiveTokens();
    return {
      count: tokens.length,
      tokens,
    };
  }

  @Get('active-tokens-metadata')
  @ApiOperation({ summary: 'Get active tokens with metadata' })
  @ApiOkResponse({
    description: 'List of active tokens with discovery metadata',
    schema: {
      type: 'object',
      properties: {
        count: { type: 'number', example: 10 },
        tokens: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              tokenId: { type: 'string' },
              slug: { type: 'string' },
              crypto: { type: 'string' },
              interval: { type: 'string' },
              pattern: { type: 'string' },
              discoveredAt: { type: 'number' },
            },
          },
        },
      },
    },
  })
  async getActiveTokensWithMetadata() {
    const tokens = await this.marketService.getActiveTokensWithMetadata();
    return {
      count: tokens.length,
      tokens,
    };
  }

  @Get('current-slugs')
  @ApiOperation({ summary: 'Get all current slug patterns' })
  @ApiOkResponse({
    description: 'List of current slug patterns that would be generated',
    schema: {
      type: 'object',
      properties: {
        count: { type: 'number', example: 15 },
        slugs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              crypto: { type: 'string', example: 'btc' },
              interval: { type: 'string', example: '15m' },
              pattern: { type: 'string', example: 'timestamp' },
              slug: { type: 'string', example: 'btc-updown-15m-1764604800' },
            },
          },
        },
      },
    },
  })
  async getCurrentSlugs() {
    const slugs = await this.marketService.getAllCurrentSlugs();
    return {
      count: slugs.length,
      slugs,
    };
  }

  @Post('trigger-discovery')
  @ApiOperation({ summary: 'Trigger market discovery manually' })
  @ApiQuery({
    name: 'crypto',
    required: false,
    description: 'Cryptocurrency symbol (btc, eth, solana)',
    example: 'btc',
  })
  @ApiQuery({
    name: 'interval',
    required: false,
    description: 'Time interval (15m, 1h, 4h, daily)',
    example: '15m',
  })
  @ApiOkResponse({
    description: 'Market discovery triggered successfully',
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
      },
    },
  })
  async triggerDiscovery(
    @Query('crypto') crypto?: string,
    @Query('interval') interval?: string,
  ) {
    if (crypto && interval) {
      await this.marketService.triggerDiscoveryForConfig(crypto, interval);
      return {
        message: `Market discovery triggered for ${crypto} ${interval}`,
      };
    }

    await this.marketService.triggerDiscoveryManually();
    return {
      message: 'Market discovery triggered for all configurations',
    };
  }

  @Delete('redis/clear')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Clear all Redis data',
    description:
      'WARNING: This will delete ALL data in Redis including active tokens, market info, and token metadata',
  })
  @ApiOkResponse({
    description: 'All Redis data cleared successfully',
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string', example: 'All Redis data has been cleared' },
        keysDeleted: { type: 'number', example: 150 },
        timestamp: { type: 'string', example: '2024-01-01T00:00:00.000Z' },
      },
    },
  })
  async clearRedis() {
    const totalKeys = await this.redisService.getTotalKeys();
    await this.redisService.flushAll();
    return {
      message: 'All Redis data has been cleared',
      keysDeleted: totalKeys,
      timestamp: new Date().toISOString(),
    };
  }

  @Get('redis/stats')
  @ApiOperation({ summary: 'Get Redis statistics' })
  @ApiOkResponse({
    description: 'Redis statistics including key counts and active tokens',
    schema: {
      type: 'object',
      properties: {
        totalKeys: { type: 'number', example: 150 },
        activeTokens: {
          type: 'object',
          properties: {
            count: { type: 'number', example: 10 },
            tokens: {
              type: 'array',
              items: { type: 'string' },
            },
          },
        },
        marketInfo: {
          type: 'object',
          properties: {
            count: { type: 'number', example: 50 },
          },
        },
        tokenMetadata: {
          type: 'object',
          properties: {
            count: { type: 'number', example: 10 },
          },
        },
        timestamp: { type: 'string', example: '2024-01-01T00:00:00.000Z' },
      },
    },
  })
  async getRedisStats() {
    const totalKeys = await this.redisService.getTotalKeys();
    const activeTokens = await this.redisService.smembers('active_clob_tokens');

    // Get all keys matching common patterns
    const marketInfoKeys = await this.redisService.keys('market_info:*');
    const tokenMetadataKeys = await this.redisService.keys('token_metadata:*');

    return {
      totalKeys,
      activeTokens: {
        count: activeTokens.length,
        tokens: activeTokens,
      },
      marketInfo: {
        count: marketInfoKeys.length,
      },
      tokenMetadata: {
        count: tokenMetadataKeys.length,
      },
      timestamp: new Date().toISOString(),
    };
  }

  @Get('arbitrage/insights')
  @ApiOperation({
    summary: 'Get arbitrage insights between two assets',
    description:
      'Calculate arbitrage opportunities between two asset IDs or from a market slug. ' +
      'If marketSlug is provided, it will use the first two clob token IDs from that market. ' +
      'Otherwise, use assetIdA and assetIdB directly. ' +
      'Arbitrage under 0.98: min(asks_A) + min(asks_B) < 0.98. ' +
      'Arbitrage over 1.01: max(bids_A) + max(bids_B) > 1.01.',
  })
  @ApiQuery({
    name: 'marketSlug',
    required: false,
    description: 'Market slug to get asset IDs from',
    example: 'btc-price-at-1030-pm-dec-3-2025',
  })
  @ApiQuery({
    name: 'assetIdA',
    required: false,
    description: 'First asset ID (used if marketSlug not provided)',
    example: '12345',
  })
  @ApiQuery({
    name: 'assetIdB',
    required: false,
    description: 'Second asset ID (used if marketSlug not provided)',
    example: '67890',
  })
  @ApiQuery({
    name: 'startTime',
    required: false,
    description: 'Start timestamp (Unix)',
    example: 1700000000,
  })
  @ApiQuery({
    name: 'endTime',
    required: false,
    description: 'End timestamp (Unix)',
    example: 1700100000,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Maximum number of results',
    example: 100,
  })
  @ApiOkResponse({
    description: 'Arbitrage insights with profitable opportunities',
    schema: {
      type: 'object',
      properties: {
        summary: {
          type: 'object',
          properties: {
            totalOpportunities: { type: 'number', example: 50 },
            profitableUnder098: { type: 'number', example: 15 },
            profitableOver101: { type: 'number', example: 20 },
            timeRange: {
              type: 'object',
              properties: {
                start: { type: 'string', example: '1700000000' },
                end: { type: 'string', example: '1700100000' },
              },
            },
          },
        },
        opportunities: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              timestamp: { type: 'string', example: '1700050000' },
              assetIdA: { type: 'string', example: '12345' },
              assetIdB: { type: 'string', example: '67890' },
              arbitrageUnder1: {
                type: 'object',
                properties: {
                  value: { type: 'number', example: 0.985 },
                  minAskAssetA: { type: 'number', example: 0.485 },
                  minAskAssetB: { type: 'number', example: 0.5 },
                  profitable: { type: 'boolean', example: true },
                },
              },
              arbitrageOver101: {
                type: 'object',
                properties: {
                  value: { type: 'number', example: 1.025 },
                  maxBidAssetA: { type: 'number', example: 0.515 },
                  maxBidAssetB: { type: 'number', example: 0.51 },
                  profitable: { type: 'boolean', example: true },
                },
              },
            },
          },
        },
      },
    },
  })
  async getArbitrageInsights(
    @Query('marketSlug') marketSlug?: string,
    @Query('assetIdA') assetIdA?: string,
    @Query('assetIdB') assetIdB?: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('limit') limit?: string,
  ) {
    let resolvedAssetIdA: string;
    let resolvedAssetIdB: string;

    // If marketSlug is provided, resolve asset IDs from the market
    if (marketSlug) {
      const market = await this.marketService.getMarketBySlug(marketSlug);
      if (!market) {
        throw new BadRequestException(
          `Market not found for slug: ${marketSlug}`,
        );
      }
      if (!market.clobTokenIds || market.clobTokenIds.length < 2) {
        throw new BadRequestException(
          `Market ${marketSlug} does not have enough clob token IDs (need at least 2)`,
        );
      }
      resolvedAssetIdA = market.clobTokenIds[0];
      resolvedAssetIdB = market.clobTokenIds[1];
      this.logger.log(
        `Resolved market slug "${marketSlug}" to asset IDs: ${resolvedAssetIdA}, ${resolvedAssetIdB}`,
      );
    } else {
      // Otherwise use provided asset IDs
      if (!assetIdA || !assetIdB) {
        throw new BadRequestException(
          'Either marketSlug or both assetIdA and assetIdB are required',
        );
      }
      resolvedAssetIdA = assetIdA;
      resolvedAssetIdB = assetIdB;
    }

    const query = {
      assetIdA: resolvedAssetIdA,
      assetIdB: resolvedAssetIdB,
      startTime: startTime ? parseInt(startTime) : undefined,
      endTime: endTime ? parseInt(endTime) : undefined,
      limit: limit ? parseInt(limit) : 100,
    };

    return await this.arbitrageInsightService.getArbitrageInsights(query);
  }

  @Get('arbitrage/latest')
  @ApiOperation({
    summary: 'Get latest arbitrage opportunity',
    description:
      'Get the most recent arbitrage opportunity between two assets or from a market slug',
  })
  @ApiQuery({
    name: 'marketSlug',
    required: false,
    description: 'Market slug to get asset IDs from',
  })
  @ApiQuery({
    name: 'assetIdA',
    required: false,
    description: 'First asset ID (used if marketSlug not provided)',
  })
  @ApiQuery({
    name: 'assetIdB',
    required: false,
    description: 'Second asset ID (used if marketSlug not provided)',
  })
  @ApiOkResponse({
    description: 'Latest arbitrage opportunity or null if none found',
  })
  async getLatestArbitrageOpportunity(
    @Query('marketSlug') marketSlug?: string,
    @Query('assetIdA') assetIdA?: string,
    @Query('assetIdB') assetIdB?: string,
  ) {
    let resolvedAssetIdA: string;
    let resolvedAssetIdB: string;

    // If marketSlug is provided, resolve asset IDs from the market
    if (marketSlug) {
      const market = await this.marketService.getMarketBySlug(marketSlug);
      if (!market) {
        throw new BadRequestException(
          `Market not found for slug: ${marketSlug}`,
        );
      }
      if (!market.clobTokenIds || market.clobTokenIds.length < 2) {
        throw new BadRequestException(
          `Market ${marketSlug} does not have enough clob token IDs (need at least 2)`,
        );
      }
      resolvedAssetIdA = market.clobTokenIds[0];
      resolvedAssetIdB = market.clobTokenIds[1];
    } else {
      // Otherwise use provided asset IDs
      if (!assetIdA || !assetIdB) {
        throw new BadRequestException(
          'Either marketSlug or both assetIdA and assetIdB are required',
        );
      }
      resolvedAssetIdA = assetIdA;
      resolvedAssetIdB = assetIdB;
    }

    const opportunity =
      await this.arbitrageInsightService.getLatestArbitrageOpportunity(
        resolvedAssetIdA,
        resolvedAssetIdB,
      );

    return opportunity || { message: 'No arbitrage opportunity found' };
  }

  @Get('arbitrage/statistics')
  @ApiOperation({
    summary: 'Get arbitrage statistics over time period',
    description:
      'Get aggregated statistics for arbitrage opportunities over a specified time period. ' +
      'Can use either marketSlug or asset IDs directly.',
  })
  @ApiQuery({
    name: 'marketSlug',
    required: false,
    description: 'Market slug to get asset IDs from',
  })
  @ApiQuery({
    name: 'assetIdA',
    required: false,
    description: 'First asset ID (used if marketSlug not provided)',
  })
  @ApiQuery({
    name: 'assetIdB',
    required: false,
    description: 'Second asset ID (used if marketSlug not provided)',
  })
  @ApiQuery({
    name: 'startTime',
    required: true,
    description: 'Start timestamp (Unix)',
    example: 1700000000,
  })
  @ApiQuery({
    name: 'endTime',
    required: true,
    description: 'End timestamp (Unix)',
    example: 1700100000,
  })
  @ApiOkResponse({
    description: 'Aggregated arbitrage statistics',
    schema: {
      type: 'object',
      properties: {
        totalSamples: { type: 'number', example: 100 },
        profitableUnder098Count: { type: 'number', example: 30 },
        profitableOver101Count: { type: 'number', example: 40 },
        avgArbitrageUnder1: { type: 'number', example: 0.992 },
        avgArbitrageOver101: { type: 'number', example: 1.015 },
        maxArbitrageUnder1: { type: 'number', example: 0.985 },
        maxArbitrageOver101: { type: 'number', example: 1.032 },
        minArbitrageUnder1: { type: 'number', example: 1.005 },
        minArbitrageOver101: { type: 'number', example: 1.002 },
      },
    },
  })
  async getArbitrageStatistics(
    @Query('startTime') startTime: string,
    @Query('endTime') endTime: string,
    @Query('marketSlug') marketSlug?: string,
    @Query('assetIdA') assetIdA?: string,
    @Query('assetIdB') assetIdB?: string,
  ) {
    if (!startTime || !endTime) {
      throw new BadRequestException('startTime and endTime are required');
    }

    let resolvedAssetIdA: string;
    let resolvedAssetIdB: string;

    // If marketSlug is provided, resolve asset IDs from the market
    if (marketSlug) {
      const market = await this.marketService.getMarketBySlug(marketSlug);
      if (!market) {
        throw new BadRequestException(
          `Market not found for slug: ${marketSlug}`,
        );
      }
      if (!market.clobTokenIds || market.clobTokenIds.length < 2) {
        throw new BadRequestException(
          `Market ${marketSlug} does not have enough clob token IDs (need at least 2)`,
        );
      }
      resolvedAssetIdA = market.clobTokenIds[0];
      resolvedAssetIdB = market.clobTokenIds[1];
    } else {
      // Otherwise use provided asset IDs
      if (!assetIdA || !assetIdB) {
        throw new BadRequestException(
          'Either marketSlug or both assetIdA and assetIdB are required',
        );
      }
      resolvedAssetIdA = assetIdA;
      resolvedAssetIdB = assetIdB;
    }

    return await this.arbitrageInsightService.getArbitrageStatistics(
      resolvedAssetIdA,
      resolvedAssetIdB,
      parseInt(startTime),
      parseInt(endTime),
    );
  }

  @Get('arbitrage/debug')
  @ApiOperation({
    summary: '[DEBUG] Get raw orderbook data for two assets',
    description:
      'Debug endpoint to inspect raw orderbook data from database. Can use either marketSlug or asset IDs.',
  })
  @ApiQuery({
    name: 'marketSlug',
    required: false,
    description: 'Market slug to get asset IDs from',
  })
  @ApiQuery({
    name: 'assetIdA',
    required: false,
    description: 'First asset ID (used if marketSlug not provided)',
  })
  @ApiQuery({
    name: 'assetIdB',
    required: false,
    description: 'Second asset ID (used if marketSlug not provided)',
  })
  async getArbitrageDebug(
    @Query('marketSlug') marketSlug?: string,
    @Query('assetIdA') assetIdA?: string,
    @Query('assetIdB') assetIdB?: string,
  ) {
    let resolvedAssetIdA: string;
    let resolvedAssetIdB: string;

    // If marketSlug is provided, resolve asset IDs from the market
    if (marketSlug) {
      const market = await this.marketService.getMarketBySlug(marketSlug);
      if (!market) {
        throw new BadRequestException(
          `Market not found for slug: ${marketSlug}`,
        );
      }
      if (!market.clobTokenIds || market.clobTokenIds.length < 2) {
        throw new BadRequestException(
          `Market ${marketSlug} does not have enough clob token IDs (need at least 2)`,
        );
      }
      resolvedAssetIdA = market.clobTokenIds[0];
      resolvedAssetIdB = market.clobTokenIds[1];
    } else {
      // Otherwise use provided asset IDs
      if (!assetIdA || !assetIdB) {
        throw new BadRequestException(
          'Either marketSlug or both assetIdA and assetIdB are required',
        );
      }
      resolvedAssetIdA = assetIdA;
      resolvedAssetIdB = assetIdB;
    }

    const debugData = await this.arbitrageInsightService.getOrderbookDebug(
      resolvedAssetIdA,
      resolvedAssetIdB,
    );

    return {
      assetIdA: resolvedAssetIdA,
      assetIdB: resolvedAssetIdB,
      rawData: debugData,
    };
  }

  @Get('arbitrage/available-pairs')
  @ApiOperation({
    summary: 'Get available asset pairs for arbitrage',
    description:
      'Get list of asset pairs that have orderbook data at common timestamps (last 24 hours)',
  })
  @ApiOkResponse({
    description: 'List of asset pairs with common timestamps',
    schema: {
      type: 'object',
      properties: {
        count: { type: 'number', example: 10 },
        pairs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              assetIdA: { type: 'string', example: '12345' },
              assetIdB: { type: 'string', example: '67890' },
              commonTimestamps: { type: 'number', example: 150 },
            },
          },
        },
      },
    },
  })
  async getAvailableAssetPairs() {
    const pairs = await this.arbitrageInsightService.getAvailableAssetPairs();
    return {
      count: pairs.length,
      pairs,
    };
  }

  @Get('arbitrage/profitable')
  @ApiOperation({
    summary: 'Get all profitable arbitrage opportunities',
    description:
      'Scan all available asset pairs and return those with profitable arbitrage opportunities (either under 0.98 or over 1.01)',
  })
  @ApiOkResponse({
    description: 'List of profitable arbitrage opportunities',
    schema: {
      type: 'object',
      properties: {
        totalPairsChecked: { type: 'number', example: 50 },
        profitableOpportunities: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              assetIdA: { type: 'string' },
              assetIdB: { type: 'string' },
              latestOpportunity: { type: 'object' },
              profitableTypes: {
                type: 'array',
                items: { type: 'string' },
                example: ['under_0.98', 'over_1.01'],
              },
            },
          },
        },
      },
    },
  })
  async getProfitableArbitrage() {
    return await this.arbitrageInsightService.getProfitableArbitrageOpportunities();
  }

  @Get('arbitrage/profitable-with-markets')
  @ApiOperation({
    summary: 'Get profitable arbitrage opportunities with market details',
    description:
      'Returns profitable opportunities with complete market information, orderbook data, and profit calculations. ' +
      'IMPORTANT: Only returns pairs from the SAME MARKET (same market_id) at the SAME TIMESTAMP. ' +
      'This ensures both assets are outcomes of the same event. ' +
      'Optimized query that scans recent orderbooks (last hour) and returns top 50 most profitable opportunities.',
  })
  @ApiOkResponse({
    description: 'Profitable opportunities with market and orderbook details',
    schema: {
      type: 'object',
      properties: {
        totalPairsChecked: { type: 'number', example: 50 },
        profitableCount: { type: 'number', example: 10 },
        opportunities: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              assetIdA: { type: 'string' },
              assetIdB: { type: 'string' },
              market: {
                type: 'object',
                properties: {
                  marketId: {
                    type: 'string',
                    description: 'Same market for both assets',
                  },
                  slugA: { type: 'string', description: 'Slug for outcome A' },
                  slugB: { type: 'string', description: 'Slug for outcome B' },
                },
              },
              orderBookA: {
                type: 'object',
                properties: {
                  timestamp: {
                    type: 'string',
                    description: 'Same timestamp for both assets',
                  },
                  minAsk: { type: 'number', example: 0.06 },
                  maxBid: { type: 'number', example: 0.04 },
                  lastTradePrice: { type: 'string' },
                  asksCount: { type: 'number' },
                  bidsCount: { type: 'number' },
                },
              },
              orderBookB: {
                type: 'object',
                properties: {
                  timestamp: {
                    type: 'string',
                    description: 'Same timestamp as orderBookA',
                  },
                  minAsk: { type: 'number', example: 0.96 },
                  maxBid: { type: 'number', example: 0.94 },
                  lastTradePrice: { type: 'string' },
                  asksCount: { type: 'number' },
                  bidsCount: { type: 'number' },
                },
              },
              arbitrage: {
                type: 'object',
                properties: {
                  arbitrageUnder1: {
                    type: 'object',
                    properties: {
                      value: { type: 'number', example: 0.97 },
                      profitable: { type: 'boolean', example: true },
                    },
                  },
                  arbitrageOver101: {
                    type: 'object',
                    properties: {
                      value: { type: 'number', example: 1.02 },
                      profitable: { type: 'boolean', example: true },
                    },
                  },
                },
              },
              profitableTypes: {
                type: 'array',
                items: { type: 'string' },
                example: ['under_0.98', 'over_1.01'],
              },
              profitAmount: {
                type: 'object',
                properties: {
                  under098: { type: 'number', example: 0.01 },
                  over101: { type: 'number', example: 0.01 },
                },
              },
            },
          },
        },
      },
    },
  })
  async getProfitableArbitrageWithMarkets() {
    return await this.arbitrageInsightService.getProfitableArbitrageWithMarketDetails();
  }
}
