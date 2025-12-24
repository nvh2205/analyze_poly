import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Market } from './market.entity';

@Entity('market_orderbooks')
@Index(['assetId', 'timestamp'])
@Index(['marketHash', 'timestamp'])
@Index(['slug', 'timestamp'])
@Index(['marketSlug', 'timestamp'])
@Index(['marketId', 'timestamp'])
@Index(['createdAt'])
export class MarketOrderbook extends BaseEntity {
  @Column({ name: 'market_hash', type: 'varchar', length: 66 })
  marketHash: string;

  @Column({ name: 'asset_id', type: 'varchar', length: 255 })
  assetId: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  slug: string;

  @Column({ name: 'market_slug', type: 'varchar', length: 500, nullable: true })
  marketSlug: string;

  @Column({ name: 'market_id', type: 'bigint', nullable: true })
  marketId: string;

  @ManyToOne(() => Market, { nullable: true })
  @JoinColumn({ name: 'market_id' })
  market: Market;

  @Column({ type: 'bigint' })
  timestamp: string;

  @Column({ type: 'jsonb', nullable: true })
  bids: any;

  @Column({ type: 'jsonb', nullable: true })
  asks: any;

  @Column({
    name: 'best_bid',
    type: 'decimal',
    precision: 20,
    scale: 10,
    nullable: true,
  })
  bestBid: string;

  @Column({
    name: 'best_ask',
    type: 'decimal',
    precision: 20,
    scale: 10,
    nullable: true,
  })
  bestAsk: string;

  @Column({
    name: 'last_trade_price',
    type: 'decimal',
    precision: 20,
    scale: 10,
    nullable: true,
  })
  lastTradePrice: string;

  @Column({
    type: 'decimal',
    precision: 20,
    scale: 10,
    nullable: true,
  })
  spread: string;

  @Column({ name: 'type', type: 'varchar', length: 255, nullable: true })
  type: string; // baseSlug from config (e.g., 'btc-updown-15m')
}
