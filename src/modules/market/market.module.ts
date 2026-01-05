import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MarketService } from './market.service';
import { MarketController } from './market.controller';
import { ArbitrageInsightService } from './arbitrage-insight.service';
import { PriceRangeAnalyticsService } from './price-range-analytics.service';
import { UtilService } from '../../common/services/util.service';
import { IngestionModule } from '../ingestion/ingestion.module';
import { Market } from '../../database/entities/market.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Market]), IngestionModule],
  controllers: [MarketController],
  providers: [
    MarketService,
    ArbitrageInsightService,
    PriceRangeAnalyticsService,
    UtilService,
  ],
  exports: [MarketService, ArbitrageInsightService],
})
export class MarketModule {}
