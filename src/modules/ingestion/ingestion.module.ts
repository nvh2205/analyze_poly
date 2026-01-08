import { Module } from '@nestjs/common';
import { IngestionService } from './ingestion.service';
import { IngestionController } from './ingestion.controller';
import { SocketManagerService } from './socket-manager.service';
import { BufferService } from './buffer.service';
import { UtilService } from '../../common/services/util.service';
import { RedisModule } from '../../common/services/redis.module';
import { LiveActivitySocketService } from './live-activity-socket.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WatchlistActivity } from '../../database/entities/watchlist-activity.entity';

@Module({
  imports: [RedisModule, TypeOrmModule.forFeature([WatchlistActivity])],
  controllers: [IngestionController],
  providers: [
    IngestionService,
    SocketManagerService,
    BufferService,
    UtilService,
    LiveActivitySocketService,
  ],
  exports: [IngestionService, LiveActivitySocketService],
})
export class IngestionModule {}
