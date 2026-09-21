/**
 * notificationWorker.ts
 *
 * Issue #22 — Persist Dispatch Before Notifications
 *
 * This worker processes durable notification delivery jobs from the
 * `notificationQueue`. Notifications (FCM push + Socket.IO events) are
 * enqueued as BullMQ jobs ONLY AFTER the PostgreSQL dispatch transaction
 * has committed, enforcing the invariant:
 *
 *   PostgreSQL COMMIT → notificationQueue.add → [this worker] → FCM / Socket.IO
 *
 * Invariants:
 * - DB failure in dispatchWorker: notificationQueue.add is never called → no notification.
 * - Notification delivery failure here: BullMQ retries the notification job.
 *   Persisted dispatch state is NEVER rolled back due to notification failure.
 * - Process crash after DB commit: BullMQ re-delivers the notification job on restart.
 * - Per-worker delivery is independently caught and logged so one failed FCM
 *   does not abort delivery to other workers in the same wave.
 */

import { Worker, Job } from 'bullmq';
import { redisConnectionOptions, NOTIFICATION_QUEUE_NAME } from '../config/bullmq';
import { sendFCMToWorker } from '../shared/fcm';
import { io } from '../server';
import { registerWorker } from './workerLifecycle';

// ── Data Shape ───────────────────────────────────────────────────────────────

export interface DispatchNotifyJobData {
  type: 'dispatch-notify';
  requirementId: string;
  jobId: string;
  waveNumber: number;
  expiresAt: string; // ISO 8601 — serialisable across BullMQ job boundary
  workers: Array<{ id: string }>;
  skillType: string | null;
  ratePerDay: number | null;
  location: string | null;
  customerName: string;
}

// ── Core processor ───────────────────────────────────────────────────────────

export async function processNotificationJob(data: DispatchNotifyJobData): Promise<void> {
  const {
    requirementId,
    jobId,
    waveNumber,
    expiresAt,
    workers,
    skillType,
    ratePerDay,
    location,
    customerName,
  } = data;

  console.log(
    `[notificationWorker] Delivering wave=${waveNumber} notifications for requirement=${requirementId} to ${workers.length} worker(s)`,
  );

  const expiresAtDate = new Date(expiresAt);

  // Deliver notifications independently per worker.
  // A failure for one worker must not prevent delivery to others.
  await Promise.allSettled(
    workers.map(async (w) => {
      // ── FCM push notification ────────────────────────────────────────────
      try {
        await sendFCMToWorker(w.id, {
          title: 'New Job',
          body: skillType ?? 'New Job',
          data: {
            type: 'incoming_job',
            jobId,
            requirementId,
            title: 'New Job',
            body: skillType ?? '',
            ratePerDay: String(ratePerDay ?? 0),
            customerName,
            location: location ?? '',
            expiresAt,
          },
        });
      } catch (err) {
        // Log but do NOT rethrow: FCM failure must not roll back persisted state
        // or prevent other workers from receiving their notifications.
        console.error(
          `[notificationWorker] FCM delivery failed for worker=${w.id} (requirement=${requirementId} wave=${waveNumber}):`,
          err,
        );
      }

      // ── Socket.IO real-time event ────────────────────────────────────────
      try {
        if (io && typeof io.to === 'function') {
          const room = io.to(`worker:${w.id}`);
          if (room && typeof room.emit === 'function') {
            room.emit('job:incoming', {
              requirementId,
              jobId,
              skillType,
              ratePerDay,
              expiresAt: expiresAtDate,
            });
          }
        }
      } catch (err) {
        // Log but do NOT rethrow: socket failure must not affect persisted state.
        console.error(
          `[notificationWorker] Socket.IO delivery failed for worker=${w.id} (requirement=${requirementId} wave=${waveNumber}):`,
          err,
        );
      }
    }),
  );

  console.log(
    `[notificationWorker] Wave=${waveNumber} notifications delivered for requirement=${requirementId}`,
  );
}

// ── Worker factory ───────────────────────────────────────────────────────────

let notificationWorkerInstance: Worker<DispatchNotifyJobData> | null = null;

export function getNotificationWorker(): Worker<DispatchNotifyJobData> {
  if (!notificationWorkerInstance) {
    notificationWorkerInstance = new Worker<DispatchNotifyJobData>(
      NOTIFICATION_QUEUE_NAME,
      async (job: Job<DispatchNotifyJobData>) => {
        await processNotificationJob(job.data);
      },
      {
        connection: redisConnectionOptions,
        concurrency: 20,
      },
    );

    registerWorker(notificationWorkerInstance);

    notificationWorkerInstance.on('failed', (job, err) => {
      console.error(
        `[notificationWorker] Job ${job?.id} failed (attempt ${job?.attemptsMade ?? '?'}):`,
        err.message,
      );
    });

    notificationWorkerInstance.on('stalled', (jobId) => {
      console.warn(`[notificationWorker] Job ${jobId} stalled — worker may have crashed`);
    });

    notificationWorkerInstance.on('error', (err) => {
      console.error('[notificationWorker] Worker error:', err.message);
    });

    notificationWorkerInstance.on('ready', () => {
      console.log('[notificationWorker] ✅ Connected to Redis and ready to process notification jobs');
    });

    notificationWorkerInstance.on('completed', (job) => {
      console.log(
        `[notificationWorker] ✅ Job ${job?.id} completed for requirement=${job?.data?.requirementId}`,
      );
    });
  }
  return notificationWorkerInstance;
}

// Lazy start unless in test mode
if (process.env.NODE_ENV !== 'test') {
  getNotificationWorker();
}

// ── Graceful shutdown ────────────────────────────────────────────────────────

const shutdown = async () => {
  if (notificationWorkerInstance) {
    console.log('[notificationWorker] Shutting down gracefully...');
    await notificationWorkerInstance.close();
    console.log('[notificationWorker] Closed.');
  }
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export default notificationWorkerInstance;
