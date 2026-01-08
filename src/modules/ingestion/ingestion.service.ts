import { Injectable, Logger } from '@nestjs/common';
import { SocketManagerService } from './socket-manager.service';
import { BufferService } from './buffer.service';
import { LiveActivitySocketService } from './live-activity-socket.service';

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    private readonly socketManager: SocketManagerService,
    private readonly bufferService: BufferService,
    private readonly liveActivitySocketService: LiveActivitySocketService,
  ) {}

  /**
   * Subscribe to new token IDs
   */
  async subscribeToTokens(tokenIds: string[]): Promise<void> {
    this.logger.log(
      `Ingestion service subscribing to ${tokenIds.length} tokens`,
    );
    await this.socketManager.subscribeToTokens(tokenIds);
  }

  /**
   * Get ingestion statistics
   */
  getStats(): any {
    return {
      bufferSize: this.bufferService.getBufferSize(),
      connections: this.socketManager.getConnectionStatus(),
      liveActivityConnections:
        this.liveActivitySocketService.getConnectionStatus(),
    };
  }

  /**
   * Force flush buffer (for testing or maintenance)
   */
  async forceFlush(): Promise<void> {
    await this.bufferService.forceFlush();
  }

  /**
   * Unsubscribe from token IDs
   */
  async unsubscribeFromTokens(tokenIds: string[]): Promise<void> {
    this.logger.log(
      `Ingestion service unsubscribing from ${tokenIds.length} tokens`,
    );
    await this.socketManager.unsubscribeFromTokens(tokenIds);
  }
}
