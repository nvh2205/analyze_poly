import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from './base.entity';

@Entity('watchlist_activity')
@Index(['eventSlug'])
@Index(['matchedWallet'])
@Index(['matchedUsername'])
export class WatchlistActivity extends BaseEntity {
  @Column({ name: 'event_slug', type: 'varchar', length: 255 })
  eventSlug: string;

  @Column({ name: 'market_name', type: 'text', nullable: true })
  marketName?: string | null;

  @Column({ name: 'connection_slug', type: 'varchar', length: 255 })
  connectionSlug: string;

  @Column({ name: 'condition_id', type: 'varchar', length: 255, nullable: true })
  conditionId?: string | null;

  @Column({ name: 'token_address', type: 'varchar', length: 255, nullable: true })
  tokenAddress?: string | null;

  @Column({ name: 'token_outcome', type: 'varchar', length: 128, nullable: true })
  tokenOutcome?: string | null;

  @Column({ name: 'token_outcome_index', type: 'int', nullable: true })
  tokenOutcomeIndex?: number | null;

  @Column({ name: 'token_yesno', type: 'varchar', length: 10, nullable: true })
  tokenYesNo?: string | null;

  @Column({ name: 'side', type: 'varchar', length: 32, nullable: true })
  side?: string | null;

  @Column({ name: 'price', type: 'numeric', precision: 20, scale: 10, nullable: true })
  price?: string | null;

  @Column({ name: 'size', type: 'numeric', precision: 20, scale: 10, nullable: true })
  size?: string | null;

  @Column({ name: 'proxy_wallet', type: 'varchar', length: 255, nullable: true })
  proxyWallet?: string | null;

  @Column({ name: 'username', type: 'varchar', length: 255, nullable: true })
  username?: string | null;

  @Column({ name: 'matched_username', type: 'varchar', length: 255, nullable: true })
  matchedUsername?: string | null;

  @Column({ name: 'matched_wallet', type: 'varchar', length: 255, nullable: true })
  matchedWallet?: string | null;

  @Column({ name: 'transaction_hash', type: 'varchar', length: 255, nullable: true })
  transactionHash?: string | null;

  @Column({ name: 'profile_image', type: 'text', nullable: true })
  profileImage?: string | null;

  @Column({ name: 'icon', type: 'text', nullable: true })
  icon?: string | null;

  @Column({ name: 'event_timestamp_ms', type: 'bigint', nullable: true })
  eventTimestampMs?: string | null;

  @Column({ name: 'received_timestamp_ms', type: 'bigint', nullable: true })
  receivedTimestampMs?: string | null;

  @Column({ name: 'payload', type: 'jsonb', nullable: true })
  payload?: any;
}
