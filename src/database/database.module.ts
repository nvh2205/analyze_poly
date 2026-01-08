import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Market, WatchlistActivity } from './entities';

/**
 * Database Module
 * Centralized database entities and repository management
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Market,
      WatchlistActivity,
    ]),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
