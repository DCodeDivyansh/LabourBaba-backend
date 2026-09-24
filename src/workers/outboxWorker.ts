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

    // Deterministic Canonical Metadata (P7 Issue 09)
    const eventId = id;
    const aggregateId = record.aggregate_id;
    const aggregateType = record.aggregate_type;
    const aggregateVersion = record.aggregate_version ?? 1;
    const occurredAt = record.created_at ? new Date(record.created_at).toISOString() : new Date().toISOString();
    const socketDeliveryId = `${eventId}:${recipient_id}:socket`;
    const fcmDeliveryId = `${eventId}:${recipient_id}:fcm`;

    logger.info(`[OUTBOX_PROCESSING] Delivering outbox event ${id} (${event_type}) to ${recipient_type} ${recipient_id}`, {
      outboxId: id,
      eventId,
      eventType: event_type,
      recipientId: recipient_id,
      correlationId: correlation_id,
      socketStatus: record.socket_status,
      fcmStatus: record.fcm_status,
    });

    try {
      // ──────────────────────────────────────────────────────────────────────────
      // 1. Socket.IO Real-time Delivery (Channel-Specific Idempotency)
      // ──────────────────────────────────────────────────────────────────────────
      let socketDelivered = record.socket_status === 'SENT';
      let socketError: string | null = null;

      if (socketDelivered) {
        logger.info(`[OUTBOX_SOCKET_SKIPPED] Outbox event ${id} Socket.IO already delivered. Suppressing replay.`, {
          outboxId: id,
          deliveryId: socketDeliveryId,
        });
      } else {
        const roomName = `${recipient_type}:${recipient_id}`;
        const socketIo = this.getSocketIo();
        if (socketIo && typeof socketIo.to === 'function') {
          try {
            metricsService.recordNotificationAttempt('socket');
            const roomSockets = (socketIo as any).sockets?.adapter?.rooms?.get(roomName);
            const hasOnlineSockets = Boolean(roomSockets && roomSockets.size > 0);

            // Canonical Contract: Top-level data preserved with deterministic event identity
            const socketPayload = {
              ...payload,
              eventId,
              deliveryId: socketDeliveryId,
              outboxId: id, // backwards compatibility
              eventType: event_type,
              aggregateId,
              aggregateType,
              aggregateVersion,
              occurredAt,
              correlationId: correlation_id,
            };

            socketIo.to(roomName).emit(`notification:${event_type}`, socketPayload);

            metricsService.recordNotificationSuccess('socket');
            socketDelivered = true;
            await outboxService.recordChannelSuccess(id, recipient_id, 'socket');

            if (!hasOnlineSockets) {
              logger.info(`[OUTBOX_SOCKET] Recipient ${recipient_type} ${recipient_id} has no active socket listeners. Real-time emit dispatched to room; push & durable recovery authoritative.`, { outboxId: id });
            }
          } catch (socketErr: any) {
            socketError = socketErr.message || 'Socket emission failed';
            metricsService.recordNotificationFailure('socket', 'transient');
            logger.warn(`[OUTBOX_SOCKET_WARN] Failed socket delivery for outbox ${id}:`, { error: socketError });
            await outboxService.recordChannelFailure(id, recipient_id, 'socket', socketError || 'Socket emission failed', false);
          }
        } else {
          // Socket.IO server unavailable in this test/worker environment
          socketDelivered = true;
          await outboxService.recordChannelSuccess(id, recipient_id, 'socket');
        }
      }

      // ──────────────────────────────────────────────────────────────────────────
      // 2. Push Notification Delivery (FCM) (Channel-Specific Idempotency)
      // ──────────────────────────────────────────────────────────────────────────
      let fcmDelivered = record.fcm_status === 'SENT';
      let fcmTransientError = false;
      let fcmPermanentError = false;
      let fcmErrorMessage = '';

      if (fcmDelivered) {
        logger.info(`[OUTBOX_FCM_SKIPPED] Outbox event ${id} FCM push already delivered. Suppressing replay.`, {
          outboxId: id,
          deliveryId: fcmDeliveryId,
        });
      } else {
        if (recipient_type === 'worker' || recipient_type === 'customer') {
          const fcmData = {
            ...payload,
            eventId,
            deliveryId: fcmDeliveryId,
            outboxId: id,
            eventType: event_type,
            aggregateId,
            aggregateType,
            aggregateVersion: String(aggregateVersion),
            occurredAt,
            correlationId: correlation_id || '',
          };

          const results = await sendFCMToRecipient(recipient_type, recipient_id, {
            title: payload.title || 'LabourBaba Notification',
            body: payload.body || '',
            data: fcmData,
          });

          if (results.length === 0) {
            // Recipient has no registered active push devices; socket delivery dispatched or recoverable via PostgreSQL.
            fcmDelivered = true;
            await outboxService.recordChannelSuccess(id, recipient_id, 'fcm');
          } else {
            const anySuccess = results.some((r) => r.success);
            const hasTransient = results.some((r) => !r.success && !r.isInvalidToken);
            const allInvalid = results.every((r) => !r.success && r.isInvalidToken);

            if (anySuccess) {
              fcmDelivered = true;
              await outboxService.recordChannelSuccess(id, recipient_id, 'fcm');
            } else if (hasTransient) {
              fcmTransientError = true;
              fcmErrorMessage = results.find((r) => !r.success && !r.isInvalidToken)?.error?.message || 'FCM delivery failed';
              await outboxService.recordChannelFailure(id, recipient_id, 'fcm', fcmErrorMessage, false);
            } else if (allInvalid) {
              fcmPermanentError = true;
              fcmErrorMessage = 'All recipient device tokens were permanently invalid/unregistered';
              await outboxService.recordChannelFailure(id, recipient_id, 'fcm', fcmErrorMessage, true);
            }
          }
        } else {
          // Non-worker/customer recipients (system/admin)
          fcmDelivered = true;
          await outboxService.recordChannelSuccess(id, recipient_id, 'fcm');
        }
      }

      // ──────────────────────────────────────────────────────────────────────────
      // 3. Reconcile Overall Outbox Event Lifecycle (Durable Channel Invariant)
      // ──────────────────────────────────────────────────────────────────────────
      if (socketDelivered && fcmDelivered) {
        // Both channels succeeded!
        await outboxService.markEventSuccess(id);
      } else if (fcmTransientError || (!socketDelivered && socketError)) {
        // At least one channel failed transiently -> schedule retry with backoff.
        // CRITICAL INVARIANT: The successful channel is already marked SENT in DB.
        // On retry, the successful channel WILL NOT be replayed!
        try {
          if (fcmTransientError) metricsService.recordFcmRetry();
        } catch {}
        const retryReason = [
          socketError ? `Socket error: ${socketError}` : null,
          fcmTransientError ? `FCM error: ${fcmErrorMessage}` : null,
        ].filter(Boolean).join('; ');
        await outboxService.markEventFailure(id, retryReason, false);
      } else {
        // Permanent failure on unfulfilled channel(s)
        const failureReason = [
          socketError ? `Socket error: ${socketError}` : null,
          fcmPermanentError ? `FCM error: ${fcmErrorMessage}` : null,
        ].filter(Boolean).join('; ');
        await outboxService.markEventFailure(id, failureReason, true);
      }
    } catch (err: any) {
      const isPermanent = isPermanentInvalidTokenError(err);
      try {
        metricsService.recordNotificationFailure('fcm', isPermanent ? 'permanent' : 'transient');
      } catch {}
      await outboxService.markEventFailure(id, err.message || 'Outbox processing failed', isPermanent);
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
