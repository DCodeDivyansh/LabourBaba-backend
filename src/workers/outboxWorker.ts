import { outboxService, OutboxRecord } from '../services/outboxService';
import { sendFCMToRecipient, isPermanentInvalidTokenError } from '../shared/fcm';
import { getSocketServer } from '../socket/socketLifecycle';
import { metricsService } from '../metrics/metrics.service';
import { outboxConfig } from '../config/outboxConfig';
import { logger } from '../utils/logger';
import { Server } from 'socket.io';

export type OutboxWorkerState = 'IDLE' | 'RUNNING' | 'STOPPING' | 'STOPPED';

export class OutboxWorker {
  private state: OutboxWorkerState = 'IDLE';
  private pollTimer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private customIo?: Server | null;
  private activeOperations = new Set<Promise<unknown>>();
  private shutdownPromise: Promise<void> | null = null;

  constructor(customIo?: Server) {
    this.customIo = customIo;
  }

  public getState(): OutboxWorkerState {
    return this.state;
  }

  public getActiveOperationsCount(): number {
    return this.activeOperations.size;
  }

  public isRunningState(): boolean {
    return this.state === 'RUNNING';
  }

  public isStoppingState(): boolean {
    return this.state === 'STOPPING';
  }

  private getSocketIo(): Server | null {
    return this.customIo || getSocketServer() || null;
  }

  /**
   * Tracks an active promise in activeOperations, cleaning up when settled
   * and suppressing internal tracking rejections to prevent unhandled rejection warnings.
   */
  private trackOperation<T>(promise: Promise<T>): Promise<T> {
    this.activeOperations.add(promise);
    promise
      .finally(() => {
        this.activeOperations.delete(promise);
      })
      .catch(() => {
        // Internal tracking branch handler to avoid unhandled promise rejection warnings.
        // Callers of `promise` still receive their expected result/rejection.
      });
    return promise;
  }

  /**
   * Processes a single outbox record.
   */
  public async processRecord(record: OutboxRecord): Promise<void> {
    if (this.state === 'STOPPED') {
      logger.warn(`[OUTBOX_WORKER] Cannot process record ${record.id}: worker is STOPPED`);
      return;
    }

    const deliveryPromise = this.executeRecordDelivery(record);
    return this.trackOperation(deliveryPromise);
  }

  private async executeRecordDelivery(record: OutboxRecord): Promise<void> {
    const { id, recipient_type, recipient_id, event_type, payload, correlation_id } = record;

    logger.info(`[OUTBOX_PROCESSING] Delivering outbox event ${id} (${event_type}) to ${recipient_type} ${recipient_id}`, {
      outboxId: id,
      eventType: event_type,
      recipientId: recipient_id,
      correlationId: correlation_id,
    });

    try {
      // 1. Socket.IO Real-time Delivery
      const roomName = `${recipient_type}:${recipient_id}`;
      const socketIo = this.getSocketIo();
      if (socketIo && typeof socketIo.to === 'function') {
        try {
          metricsService.recordNotificationAttempt('socket');
          const roomSockets = (socketIo as any).sockets?.adapter?.rooms?.get(roomName);
          const hasOnlineSockets = Boolean(roomSockets && roomSockets.size > 0);

          socketIo.to(roomName).emit(`notification:${event_type}`, {
            ...payload,
            outboxId: id,
            correlationId: correlation_id,
          });

          metricsService.recordNotificationSuccess('socket');

          if (!hasOnlineSockets) {
            logger.info(`[OUTBOX_SOCKET] Recipient ${recipient_type} ${recipient_id} has no active socket listeners. Real-time emit dispatched to room; push & durable recovery authoritative.`, { outboxId: id });
          }
        } catch (socketErr: any) {
          metricsService.recordNotificationFailure('socket', 'transient');
          logger.warn(`[OUTBOX_SOCKET_WARN] Failed socket delivery for outbox ${id}:`, { error: socketErr.message });
        }
      }

      // 2. Push Notification Delivery (FCM)
      let fcmSuccess = false;
      let hasTransientError = false;
      let lastErrorMessage = '';

      if (recipient_type === 'worker' || recipient_type === 'customer') {
        const results = await sendFCMToRecipient(recipient_type, recipient_id, {
          title: payload.title || 'LabourBaba Notification',
          body: payload.body || '',
          data: {
            ...payload,
            outboxId: id,
            correlationId: correlation_id || '',
          },
        });

        if (results.length === 0) {
          // Recipient has no registered active push devices; socket delivery dispatched or recoverable via PostgreSQL.
          fcmSuccess = true;
        } else {
          for (const res of results) {
            if (res.success) {
              fcmSuccess = true;
            } else if (!res.isInvalidToken) {
              hasTransientError = true;
              lastErrorMessage = res.error?.message || 'FCM delivery failed';
            }
          }
        }
      } else {
        // Non-worker/customer recipients
        fcmSuccess = true;
      }

      if (fcmSuccess) {
        await outboxService.markEventSuccess(id, record.updated_at);
      } else if (hasTransientError) {
        try {
          metricsService.recordFcmRetry();
        } catch {}
        await outboxService.markEventFailure(id, lastErrorMessage || 'Transient push delivery failure', false, record.updated_at);
      } else {
        // All recipient device tokens were permanently invalid/unregistered.
        // Mark terminal failure so worker does not retry indefinitely.
        await outboxService.markEventFailure(id, lastErrorMessage || 'Permanent push delivery failure: all device tokens invalid or unregistered', true, record.updated_at);
      }
    } catch (err: any) {
      const isPermanent = isPermanentInvalidTokenError(err);
      try {
        metricsService.recordNotificationFailure('fcm', isPermanent ? 'permanent' : 'transient');
      } catch {}
      await outboxService.markEventFailure(id, err.message || 'Outbox processing failed', isPermanent, record.updated_at);
    }
  }

  /**
   * Claims and processes a batch of outbox records.
   * Fast-rejects if worker is not in RUNNING state to prevent new claims during shutdown.
   */
  public async processBatch(batchSize = outboxConfig.batchSize): Promise<number> {
    if (this.state === 'STOPPING' || this.state === 'STOPPED') {
      return 0;
    }
    if (this.isProcessing) return 0;
    this.isProcessing = true;

    const batchPromise = (async (): Promise<number> => {
      try {
        // Double-check state before atomic database claim
        if (this.state === 'STOPPING' || this.state === 'STOPPED') {
          return 0;
        }

        const records = await outboxService.claimPendingEvents(batchSize, outboxConfig.staleThresholdMinutes);
        if (!records || records.length === 0) {
          return 0;
        }

        await Promise.allSettled(records.map((r) => this.processRecord(r)));
        return records.length;
      } catch (err: any) {
        logger.error('[OUTBOX_BATCH_ERROR] Error processing outbox batch:', { error: err.message });
        return 0;
      } finally {
        this.isProcessing = false;
      }
    })();

    this.trackOperation(batchPromise);
    return batchPromise;
  }

  /**
   * Starts periodic polling for pending outbox records.
   */
  public start(pollIntervalMs = outboxConfig.pollIntervalMs): void {
    if (this.state === 'RUNNING' || this.state === 'STOPPING') return;
    this.state = 'RUNNING';

    this.pollTimer = setInterval(async () => {
      if (this.state !== 'RUNNING') return;
      await this.processBatch();
    }, pollIntervalMs);
    this.pollTimer.unref();

    logger.info('[OUTBOX_WORKER] ✅ Outbox worker started polling.', { pollIntervalMs });
  }

  /**
   * Stops polling cleanly and drains all active operations with a bounded timeout.
   * Fully idempotent and concurrent-safe: concurrent stop() calls await the same drain sequence.
   */
  public async stop(customDrainTimeoutMs?: number): Promise<void> {
    if (this.state === 'STOPPED') {
      return;
    }

    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.state = 'STOPPING';

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.shutdownPromise = this.drainActiveOperations(customDrainTimeoutMs)
      .finally(() => {
        this.state = 'STOPPED';
        this.shutdownPromise = null;
        logger.info('[OUTBOX_WORKER] Outbox worker stopped.');
      });

    return this.shutdownPromise;
  }

  /**
   * Bounded graceful drain: awaits all active operations or times out safely.
   */
  private async drainActiveOperations(customDrainTimeoutMs?: number): Promise<void> {
    const drainTimeoutMs =
      customDrainTimeoutMs ?? outboxConfig.shutdownDrainTimeoutMs;

    const initialCount = this.activeOperations.size;
    if (initialCount === 0) {
      logger.info('[OUTBOX_WORKER] No active operations to drain. Stopped immediately.');
      try {
        metricsService.recordOutboxShutdown('immediate');
      } catch {}
      return;
    }

    logger.info(`[OUTBOX_WORKER] Draining ${initialCount} active outbox operation(s) with ${drainTimeoutMs}ms timeout...`, {
      activeOperations: initialCount,
      timeoutMs: drainTimeoutMs,
    });

    const startTime = Date.now();
    let timer: NodeJS.Timeout | null = null;

    const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), drainTimeoutMs);
      timer.unref();
    });

    const drainPromise = (async (): Promise<{ timedOut: false }> => {
      while (this.activeOperations.size > 0) {
        await Promise.allSettled(Array.from(this.activeOperations));
        // Flush event loop microtasks/macrotasks so finally() callbacks clean up
        await new Promise((r) => setImmediate(r));
      }
      return { timedOut: false };
    })();

    try {
      const result = await Promise.race([drainPromise, timeoutPromise]);
      const durationMs = Date.now() - startTime;

      if (result.timedOut) {
        const remainingCount = this.activeOperations.size;
        logger.warn(
          `[OUTBOX_WORKER] Graceful drain timed out after ${drainTimeoutMs}ms with ${remainingCount} operation(s) still in flight. Unfinished events will be recovered via lease expiry.`,
          { remainingOperations: remainingCount, durationMs }
        );
        try {
          metricsService.recordOutboxShutdown('timed_out');
        } catch {}
      } else {
        logger.info(`[OUTBOX_WORKER] Successfully drained all active outbox operations in ${durationMs}ms.`, {
          durationMs,
        });
        try {
          metricsService.recordOutboxShutdown('drained');
        } catch {}
      }
    } finally {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }
  }
}

export const outboxWorker = new OutboxWorker();

// Outbox worker is started explicitly via lifecycleManager.startup()
