import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MarketService } from './market.service';
import { MarketController } from './market.controller';
import { ArbitrageInsightService } from './arbitrage-insight.service';
import { UtilService } from '../../common/services/util.service';
import { IngestionModule } from '../ingestion/ingestion.module';
import { MarketOrderbook } from '../../database/entities/market-orderbook.entity';

@Module({
  imports: [TypeOrmModule.forFeature([MarketOrderbook]), IngestionModule],
  controllers: [MarketController],
  providers: [MarketService, ArbitrageInsightService, UtilService],
  exports: [MarketService, ArbitrageInsightService],
})
export class MarketModule {}
