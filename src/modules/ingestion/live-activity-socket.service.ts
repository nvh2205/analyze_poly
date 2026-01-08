import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as WebSocket from 'ws';
import { APP_CONSTANTS } from '../../common/constants/app.constants';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WatchlistActivity } from '../../database/entities/watchlist-activity.entity';

const WATCHLIST = [
  { username: '0x8dxd', wallet: '0x589222a5124a96765443b97a3498d89ffd824ad2' },
  { username: 'Account88888', wallet: '0x7f69983eb28245bba0d5083502a78744a8f66162' },
  {
    username: 'PurpleThunderBicycleMountain',
    wallet: '0x589222a5124a96765443b97a3498d89ffd824ad2',
  },
  { username: 'CRYINGLITTLEBABY', wallet: '0x961afce6bd9aec79c5cf09d2d4dac2b434b23361' },
  { username: 'updateupdate', wallet: '0xd0d6053c3c37e727402d84c14069780d360993aa' },
];

const WATCHLIST_WALLETS = new Set(
  WATCHLIST.map((item) => item.wallet.toLowerCase()),
);
const WATCHLIST_USERNAMES = new Set(
  WATCHLIST.map((item) => item.username.toLowerCase()),
);

interface ActivityConnection {
  ws: WebSocket;
  slug: string;
  reconnectAttempts: number;
  shouldReconnect: boolean;
  endTimeMs?: number;
  pingInterval?: NodeJS.Timeout;
  endTimeout?: NodeJS.Timeout;
}

@Injectable()
export class LiveActivitySocketService implements OnModuleDestroy {
  private readonly logger = new Logger(LiveActivitySocketService.name);
  private readonly connections: Map<string, ActivityConnection> = new Map();
  private readonly wsUrl: string = APP_CONSTANTS.POLYMARKET_LIVE_DATA_WS_URL;
  private readonly pingIntervalMs: number = APP_CONSTANTS.PING_INTERVAL_MS;
  private readonly maxReconnectAttempts = 5;
  private readonly watchlistLogEnabled =
    process.env.WATCHLIST_LOG_ENABLED === 'true';

  constructor(
    @InjectRepository(WatchlistActivity)
    private readonly watchlistActivityRepo: Repository<WatchlistActivity>,
  ) {}

  /**
   * Ensure a live activity connection exists for a slug
   */
  async ensureConnection(slug: string, endTime?: Date | null): Promise<void> {
    if (!slug) return;

    const existing = this.connections.get(slug);
    const endTimeMs = endTime ? endTime.getTime() : undefined;

    if (existing) {
      this.scheduleEndTimeout(existing, endTimeMs);
      return;
    }

    await this.createConnection(slug, endTimeMs);
  }

  /**
   * Close connection for a slug
   */
  async closeConnection(slug: string, reason?: string): Promise<void> {
    const connection = this.connections.get(slug);
    if (!connection) return;

    connection.shouldReconnect = false;
    this.cleanupConnection(connection);
    if (connection.ws.readyState === WebSocket.WebSocket.OPEN) {
      connection.ws.close();
    } else {
      try {
        connection.ws.terminate();
      } catch {
        // ignore
      }
    }
    this.connections.delete(slug);
    this.logger.log(
      `Closed live activity socket for ${slug}${reason ? ` (${reason})` : ''}`,
    );
  }

  /**
   * Close all connections
   */
  async closeAllConnections(): Promise<void> {
    for (const slug of Array.from(this.connections.keys())) {
      await this.closeConnection(slug, 'shutdown');
    }
  }

  /**
   * On application shutdown
   */
  async onModuleDestroy() {
    await this.closeAllConnections();
  }

  /**
   * Get connection status
   */
  getConnectionStatus() {
    const status = [];
    for (const [slug, connection] of this.connections.entries()) {
      status.push({
        slug,
        state: this.getReadyStateString(connection.ws.readyState),
        reconnectAttempts: connection.reconnectAttempts,
        endTimeMs: connection.endTimeMs,
      });
    }
    return status;
  }

  /**
   * Internal: create connection
   */
  private async createConnection(
    slug: string,
    endTimeMs?: number,
  ): Promise<void> {
    try {
      this.logger.log(`Creating live activity socket for slug ${slug}`);
      const ws = new WebSocket.WebSocket(this.wsUrl);
      const connection: ActivityConnection = {
        ws,
        slug,
        endTimeMs,
        reconnectAttempts: 0,
        shouldReconnect: true,
      };

      this.scheduleEndTimeout(connection, endTimeMs);

      ws.on('open', () => this.handleOpen(connection));
      ws.on('message', (data: WebSocket.RawData) =>
        this.handleMessage(connection, data),
      );
      ws.on('error', (error: Error) => {
        this.logger.error(
          `Live activity socket error for ${slug}: ${error.message}`,
        );
      });
      ws.on('close', (code: number, reason: Buffer) =>
        this.handleClose(connection, code, reason),
      );
      ws.on('pong', () => {
        // noop
      });

      this.connections.set(slug, connection);
    } catch (error) {
      this.logger.error(
        `Failed to create live activity socket for ${slug}: ${error.message}`,
      );
    }
  }

  /**
   * Handle open
   */
  private handleOpen(connection: ActivityConnection): void {
    const { ws, slug } = connection;

    const subscribeMessage = {
      action: 'subscribe',
      subscriptions: [
        {
          topic: 'activity',
          type: 'orders_matched',
          filters: JSON.stringify({ event_slug: slug }),
        },
      ],
    };

    ws.send(JSON.stringify(subscribeMessage));
    connection.reconnectAttempts = 0;

    connection.pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.WebSocket.OPEN) {
        ws.ping();
      }
    }, this.pingIntervalMs);

    this.logger.log(`Subscribed live activity socket for slug ${slug}`);
  }

  /**
   * Handle incoming message
   */
  private handleMessage(
    connection: ActivityConnection,
    data: WebSocket.RawData,
  ): void {
    try {
      const raw = data.toString();
      if (!raw) return;

      const parsed = JSON.parse(raw);
      const payload = (parsed as any).payload ?? parsed;

      const walletCandidates: string[] = [
        payload?.proxyWallet,
        payload?.wallet,
        payload?.address,
        payload?.sender,
      ].filter(Boolean);

      const usernameCandidates: string[] = [
        payload?.name,
        payload?.pseudonym,
        payload?.username,
      ].filter(Boolean);

      const walletMatch = walletCandidates
        .map((w) => String(w).toLowerCase())
        .find((w) => WATCHLIST_WALLETS.has(w));

      const usernameMatch = usernameCandidates
        .map((u) => String(u).toLowerCase())
        .find((u) => WATCHLIST_USERNAMES.has(u));

      if (walletMatch || usernameMatch) {
        const matchedEntries = WATCHLIST.filter(
          (entry) =>
            entry.wallet.toLowerCase() === walletMatch ||
            entry.username.toLowerCase() === usernameMatch,
        );

        // if (this.watchlistLogEnabled) {
        //   this.logger.warn(
        //     `[LIVE-ACTIVITY][WATCHLIST] slug=${connection.slug} wallet=${walletMatch || 'n/a'} username=${usernameMatch || 'n/a'} matches=${matchedEntries
        //       .map((m) => `${m.username}:${m.wallet}`)
        //       .join(', ')} payload=${raw.substring(0, 300)}...`,
        //   );
        // }

        this.persistWatchlistHit({
          payload,
          raw,
          connectionSlug: connection.slug,
          walletMatch,
          usernameMatch,
          matchedEntries,
          outerTimestamp: (parsed as any)?.timestamp,
        }).catch((err) =>
          this.logger.debug(
            `Failed to persist watchlist activity for ${connection.slug}: ${err?.message}`,
          ),
        );
      }

      // TODO: persist or forward payloads when downstream consumers are ready
    } catch (error) {
      this.logger.debug(
        `Failed to parse live activity message for ${connection.slug}: ${error.message}`,
      );
    }
  }

  /**
   * Persist matched watchlist events into Postgres
   */
  private async persistWatchlistHit(params: {
    payload: any;
    raw: string;
    connectionSlug: string;
    walletMatch?: string;
    usernameMatch?: string;
    matchedEntries: { username: string; wallet: string }[];
    outerTimestamp?: any;
  }): Promise<void> {
    const {
      payload,
      raw,
      connectionSlug,
      walletMatch,
      usernameMatch,
      matchedEntries,
      outerTimestamp,
    } = params;

    const eventSlug = payload?.eventSlug || payload?.slug || connectionSlug;
    const marketName = payload?.title || payload?.question || null;
    const tokenAddress = payload?.asset || payload?.tokenAddress || null;
    const tokenOutcome = payload?.outcome || null;
    const tokenOutcomeIndex =
      payload?.outcomeIndex !== undefined
        ? Number(payload.outcomeIndex)
        : null;
    const side = payload?.side || null;
    const price =
      payload?.price !== undefined && payload?.price !== null
        ? String(payload.price)
        : null;
    const size =
      payload?.size !== undefined && payload?.size !== null
        ? String(payload.size)
        : null;
    const proxyWallet =
      payload?.proxyWallet ||
      payload?.wallet ||
      payload?.address ||
      payload?.sender ||
      null;
    const username = payload?.name || payload?.pseudonym || payload?.username || null;
    const transactionHash = payload?.transactionHash || null;
    const conditionId = payload?.conditionId || null;
    const profileImage = payload?.profileImage || null;
    const icon = payload?.icon || null;

    const normalizeMs = (value: any): string | null => {
      if (value === null || value === undefined) return null;
      const num = Number(value);
      if (!Number.isFinite(num)) return null;
      const ms = num >= 1e12 ? num : Math.floor(num * 1000);
      return String(Math.floor(ms));
    };

    const eventTimestampMs =
      normalizeMs(payload?.timestamp) ||
      normalizeMs(payload?.ts) ||
      normalizeMs(payload?.time) ||
      null;
    const receivedTimestampMs = normalizeMs(outerTimestamp);

    const lowerOutcome = (tokenOutcome || '').toString().toLowerCase();
    const tokenYesNo =
      lowerOutcome === 'yes'
        ? 'yes'
        : lowerOutcome === 'no'
          ? 'no'
          : null;

    const matchedUsername =
      usernameMatch ||
      matchedEntries.find((m) => m.username?.toLowerCase() === usernameMatch)
        ?.username ||
      null;
    const matchedWallet =
      walletMatch ||
      matchedEntries.find((m) => m.wallet?.toLowerCase() === walletMatch)
        ?.wallet ||
      null;

    await this.watchlistActivityRepo.save({
      eventSlug,
      marketName,
      connectionSlug,
      conditionId,
      tokenAddress,
      tokenOutcome,
      tokenOutcomeIndex,
      tokenYesNo,
      side,
      price,
      size,
      proxyWallet,
      username,
      matchedUsername,
      matchedWallet,
      transactionHash,
      profileImage,
      icon,
      eventTimestampMs,
      receivedTimestampMs,
      payload,
    });
  }

  /**
   * Handle close
   */
  private handleClose(
    connection: ActivityConnection,
    code: number,
    reason: Buffer,
  ): void {
    const now = Date.now();
    const endReached =
      typeof connection.endTimeMs === 'number' && now >= connection.endTimeMs;

    this.cleanupConnection(connection);
    this.connections.delete(connection.slug);

    if (!connection.shouldReconnect || endReached) {
      this.logger.log(
        `Live activity socket for ${connection.slug} closed (${code} - ${reason?.toString() || 'unknown'}), not reconnecting`,
      );
      return;
    }

    if (connection.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error(
        `Max reconnect attempts reached for live socket ${connection.slug}, giving up`,
      );
      return;
    }

    connection.reconnectAttempts += 1;
    const delay = Math.min(
      1000 * Math.pow(2, connection.reconnectAttempts),
      30000,
    );
    this.logger.log(
      `Reconnecting live socket for ${connection.slug} in ${delay}ms (attempt ${connection.reconnectAttempts}/${this.maxReconnectAttempts})`,
    );

    setTimeout(() => {
      this.createConnection(connection.slug, connection.endTimeMs);
    }, delay);
  }

  /**
   * Cleanup helper
   */
  private cleanupConnection(connection: ActivityConnection): void {
    if (connection.pingInterval) {
      clearInterval(connection.pingInterval);
    }
    if (connection.endTimeout) {
      clearTimeout(connection.endTimeout);
    }
  }

  /**
   * Schedule auto-close when end time reached
   */
  private scheduleEndTimeout(
    connection: ActivityConnection,
    endTimeMs?: number,
  ): void {
    if (connection.endTimeout) {
      clearTimeout(connection.endTimeout);
      connection.endTimeout = undefined;
    }

    connection.endTimeMs = endTimeMs;

    if (typeof endTimeMs === 'number' && endTimeMs > Date.now()) {
      const delay = endTimeMs - Date.now();
      connection.endTimeout = setTimeout(() => {
        this.closeConnection(connection.slug, 'market ended');
      }, delay);
    }
  }

  /**
   * Ready state helper
   */
  private getReadyStateString(state: number): string {
    switch (state) {
      case WebSocket.WebSocket.CONNECTING:
        return 'CONNECTING';
      case WebSocket.WebSocket.OPEN:
        return 'OPEN';
      case WebSocket.WebSocket.CLOSING:
        return 'CLOSING';
      case WebSocket.WebSocket.CLOSED:
        return 'CLOSED';
      default:
        return 'UNKNOWN';
    }
  }
}
