/**
 * Worker Lifecycle Coordinator (Issue #38)
 */
import { Worker } from 'bullmq';
import { logger } from '../utils/logger';

const registeredWorkers = new Set<Worker>();

export function registerWorker(worker: Worker): void {
  registeredWorkers.add(worker);
}

export function unregisterWorker(worker: Worker): void {
  registeredWorkers.delete(worker);
}

export function getRegisteredWorkersCount(): number {
  return registeredWorkers.size;
}

export async function closeAllWorkers(): Promise<void> {
  logger.info(`[WORKER_LIFECYCLE] Closing ${registeredWorkers.size} registered BullMQ workers...`);
  const promises: Promise<void>[] = [];

  for (const worker of registeredWorkers) {
    promises.push(
      (async () => {
        try {
          await worker.close();
        } catch (err: any) {
          logger.error(`[WORKER_LIFECYCLE] Error closing worker ${worker.name}:`, { error: err.message });
        }
      })(),
    );
  }

  await Promise.allSettled(promises);
  registeredWorkers.clear();
  logger.info('[WORKER_LIFECYCLE] All registered workers closed.');
}

