import { outboxService, OutboxRecord } from '../services/outboxService';
import { sendFCMToWorker, sendFCMToCustomer, sendFCMToRecipient, sendFCMToTokens, isPermanentInvalidTokenError } from '../shared/fcm';
import { io as defaultIo } from '../server';
import { getSocketServer } from '../socket/socketLifecycle';
import { metricsService } from '../metrics/metrics.service';
import { logger } from '../utils/logger';
import { Server } from 'socket.io';

export class OutboxWorker {
  private isRunning = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private customIo?: Server | null;

  constructor(customIo?: Server) {
    this.customIo = customIo;
  }

  private getSocketIo(): Server | null {
    return this.customIo || getSocketServer() || defaultIo || null;
  }

  /**
   * Processes a single outbox record.
   */
  public async processRecord(record: OutboxRecord): Promise<void> {
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
        try {
          metricsService.recordNotificationAttempt('fcm');
        } catch {}

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
          try {
            metricsService.recordNotificationSuccess('fcm');
          } catch {}
        } else {
          for (const res of results) {
            if (res.success) {
              fcmSuccess = true;
            } else if (!res.isInvalidToken) {
              hasTransientError = true;
              lastErrorMessage = res.error?.message || 'FCM delivery failed';
            }
          }
          if (fcmSuccess) {
            try {
              metricsService.recordNotificationSuccess('fcm');
            } catch {}
          } else {
            try {
              metricsService.recordNotificationFailure('fcm', hasTransientError ? 'transient' : 'permanent');
            } catch {}
          }
        }
      } else {
        // Non-worker/customer recipients
        fcmSuccess = true;
      }

      if (fcmSuccess || !hasTransientError) {
        await outboxService.markEventSuccess(id, record.updated_at);
      } else {
        await outboxService.markEventFailure(id, lastErrorMessage || 'Transient push delivery failure', false, record.updated_at);
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
   */
  public async processBatch(batchSize = 20): Promise<number> {
    if (this.isProcessing) return 0;
    this.isProcessing = true;

    try {
      const records = await outboxService.claimPendingEvents(batchSize);
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
  }

  /**
   * Starts periodic polling for pending outbox records.
   */
  public start(pollIntervalMs = 5000): void {
    if (this.isRunning) return;
    this.isRunning = true;

    this.pollTimer = setInterval(async () => {
      await this.processBatch();
    }, pollIntervalMs);
    this.pollTimer.unref();

    logger.info('[OUTBOX_WORKER] ✅ Outbox worker started polling.');
  }

  /**
   * Stops polling cleanly during graceful shutdown.
   */
  public async stop(): Promise<void> {
    this.isRunning = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info('[OUTBOX_WORKER] Outbox worker stopped.');
  }
}

export const outboxWorker = new OutboxWorker();

// Outbox worker is started explicitly via lifecycleManager.startup()
