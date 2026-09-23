/**
 * Application Lifecycle & Graceful Shutdown Manager (Issue #38)
 *
 * Guarantees:
 * - Deterministic, validated startup sequence (config -> DB/Redis -> reconciliation -> ready -> workers -> traffic).
 * - Idempotent, ordered graceful shutdown (unready -> stop HTTP -> drain sockets -> close workers -> close Redis/DB).
 * - Bounded shutdown timer preventing process hangs on stuck connections.
 */

import { Server as HttpServer } from 'http';
import { Server as SocketIoServer } from 'socket.io';
import prisma from '../config/prisma';
import { getRedisClient, closeRedisConnections, assertRedisConfig } from '../config/redis';
import { dispatchQueue, timeoutQueue, notificationQueue } from '../config/bullmq';
import { closeAllWorkers } from '../workers/workerLifecycle';
import { assertJwtConfig, assertProductionAuthConfig } from '../config/authConfig';
import { assertProductionPaymentConfig } from '../config/paymentConfig';
import { assertProductionStorageConfig } from '../config/storageConfig';
import { assertOutboxConfig } from '../config/outboxConfig';
import { assertFcmConfig } from '../shared/fcm';
import { reconcileDispatchState } from '../features/dispatch/dispatchReconciliationService';
import { outboxService } from '../services/outboxService';
import { outboxWorker } from '../workers/outboxWorker';
import { paymentReconciliationWorker } from '../workers/paymentReconciliationWorker';
import { authService } from '../features/auth/auth.services';
import { setupSocketRedisAdapter, closeSocketRedisAdapter } from '../socket/socketRedisAdapter';
import { logger } from '../utils/logger';

export type LifecycleState = 'INITIALIZING' | 'READY' | 'SHUTTING_DOWN' | 'TERMINATED';

export class LifecycleManager {
  private state: LifecycleState = 'INITIALIZING';
  private isShuttingDown = false;
  private httpServer: HttpServer | null = null;
  private io: SocketIoServer | null = null;
  private otpCleanupTimer: NodeJS.Timeout | null = null;
  private dispatchReconciliationTimer: NodeJS.Timeout | null = null;

  public getState(): LifecycleState {
    return this.state;
  }

  public isReady(): boolean {
    return this.state === 'READY';
  }

  public registerServers(httpServer: HttpServer, io: SocketIoServer): void {
    this.httpServer = httpServer;
    this.io = io;
  }

  /**
   * Authoritative, ordered startup initialization.
   */
  public async startup(): Promise<void> {
    this.state = 'INITIALIZING';
    logger.info('[LIFECYCLE] Starting LabourBaba Backend bootstrap sequence...');

    // 1. Fail-fast configuration gatekeepers
    assertJwtConfig();
    assertProductionAuthConfig();
    assertProductionPaymentConfig();
    assertProductionStorageConfig();
    assertRedisConfig();
    assertFcmConfig();
    assertOutboxConfig();
    logger.info('[LIFECYCLE] Configuration successfully validated.');

    // 2. Initialize and verify PostgreSQL connectivity
    await prisma.$connect();
    logger.info('[LIFECYCLE] PostgreSQL connection established.');

    // 3. Verify Redis connectivity
    const pong = await getRedisClient().ping();
    if (pong !== 'PONG') {
      throw new Error(`[LIFECYCLE] Redis ping failed with response: ${pong}`);
    }
    logger.info('[LIFECYCLE] Redis connectivity confirmed.');

    // 3b. Initialize Socket.IO Redis Adapter for horizontal scaling (Issue #11)
    if (this.io) {
      await setupSocketRedisAdapter(this.io);
    }

    // 4. Authoritative startup reconciliation: reconstruct orphaned dispatch wave states & recover stale outbox
    try {
      await reconcileDispatchState();
      await outboxService.reconcileStaleEvents();
      logger.info('[LIFECYCLE] Dispatch state and notification outbox reconciliation completed.');
    } catch (err: any) {
      logger.error('[LIFECYCLE] Startup reconciliation failed:', { error: err.message });
      if (process.env.NODE_ENV === 'production') {
        throw err;
      }
    }

    // 5. Start background hygiene maintenance (OTP + Location History retention)
    const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
    this.otpCleanupTimer = setInterval(async () => {
      try {
        await authService.cleanupExpiredOtpChallenges();
      } catch (err: any) {
        logger.error('[LIFECYCLE] Periodic OTP cleanup failed:', { error: err.message });
      }
      try {
        const { locationRetentionService } = await import('../services/locationRetentionService');
        await locationRetentionService.cleanupExpiredLocationHistory();
      } catch (err: any) {
        logger.error('[LIFECYCLE] Periodic location history cleanup failed:', { error: err.message });
      }
    }, CLEANUP_INTERVAL_MS);
    this.otpCleanupTimer.unref();

    authService.cleanupExpiredOtpChallenges().catch((err) => {
      logger.warn('[LIFECYCLE] Initial OTP cleanup skipped on startup:', { error: err.message });
    });

    // 6. Initialize background consumers & schedulers AFTER dependencies and reconciliation
    const processType = (process.env.PROCESS_TYPE || "all").toLowerCase();
    const enableWorkers = process.env.ENABLE_WORKERS !== "false" && processType !== "api";

    if (process.env.NODE_ENV !== 'test' && enableWorkers) {
      try {
        const { getNotificationWorker } = await import('../workers/notificationWorker');
        const { getDispatchWorker } = await import('../workers/dispatchWorker');
        const { getTimeoutWorker } = await import('../workers/timeoutWorker');
        getNotificationWorker();
        getDispatchWorker();
        getTimeoutWorker();
        outboxWorker.start();
        paymentReconciliationWorker.start();
        logger.info('[LIFECYCLE] Background workers and queues initialized successfully.', { processType });

        // Start periodic dispatch reconciliation (every 30 seconds) to heal dual-write crash windows at runtime
        const RECONCILIATION_INTERVAL_MS = 30_000;
        this.dispatchReconciliationTimer = setInterval(async () => {
          try {
            await reconcileDispatchState();
          } catch (err: any) {
            logger.error('[LIFECYCLE] Periodic dispatch reconciliation error:', { error: err.message });
          }
        }, RECONCILIATION_INTERVAL_MS);
        this.dispatchReconciliationTimer.unref();
      } catch (workerErr: any) {
        logger.error('[LIFECYCLE] Failed to start background workers:', { error: workerErr.message });
        if (process.env.NODE_ENV === 'production') {
          throw workerErr;
        }
      }
    } else if (process.env.NODE_ENV !== 'test' && !enableWorkers) {
      logger.info('[LIFECYCLE] Background workers disabled for this instance.', { processType, enableWorkers });
    }

    // 7. Mark application state as READY
    this.state = 'READY';
    logger.info('[LIFECYCLE] Application is now READY to process traffic.');
  }

  /**
   * Idempotent, ordered graceful shutdown.
   */
  public async shutdown(signal = 'SIGTERM', exitProcess = true): Promise<void> {
    if (this.isShuttingDown) {
      logger.warn(`[LIFECYCLE] Shutdown already in progress. Ignoring duplicate signal: ${signal}`);
      return;
    }

    this.isShuttingDown = true;
    this.state = 'SHUTTING_DOWN';
    logger.info(`[LIFECYCLE] Initiating graceful shutdown via ${signal}...`);

    // Safety timeout: force exit if resources fail to close within 10 seconds
    let forceExitTimer: NodeJS.Timeout | null = null;
    if (exitProcess) {
      forceExitTimer = setTimeout(() => {
        logger.error('[LIFECYCLE] Graceful shutdown timed out (10s). Forcing process exit.');
        process.exit(1);
      }, 10000);
      forceExitTimer.unref();
    }

    try {
      // 1. Clear scheduled background timers & stop outbox worker & reconciliation worker
      if (this.otpCleanupTimer) {
        clearInterval(this.otpCleanupTimer);
        this.otpCleanupTimer = null;
      }
      if (this.dispatchReconciliationTimer) {
        clearInterval(this.dispatchReconciliationTimer);
        this.dispatchReconciliationTimer = null;
      }
      await outboxWorker.stop();
      paymentReconciliationWorker.stop();

      // 2. Stop accepting new HTTP requests
      if (this.httpServer && this.httpServer.listening) {
        await new Promise<void>((resolve) => {
          this.httpServer!.close((err) => {
            if (err) {
              logger.warn('[LIFECYCLE] HTTP server close error:', { error: err.message });
            } else {
              logger.info('[LIFECYCLE] HTTP server stopped accepting new requests.');
            }
            resolve();
          });
        });
      }

      // 3. Disconnect Socket.IO clients
      if (this.io) {
        try {
          this.io.disconnectSockets(true);
          await new Promise<void>((resolve) => {
            this.io!.close(() => {
              logger.info('[LIFECYCLE] Socket.IO server closed.');
              resolve();
            });
          });
        } catch (err: any) {
          logger.warn('[LIFECYCLE] Error closing Socket.IO:', { error: err.message });
        } finally {
          await closeSocketRedisAdapter();
        }
      }

      // 4. Close all active BullMQ workers
      await closeAllWorkers();

      // 5. Close BullMQ queue clients
      await Promise.allSettled([
        dispatchQueue.close(),
        timeoutQueue.close(),
        notificationQueue.close(),
      ]);
      logger.info('[LIFECYCLE] BullMQ queues closed.');

      // 6. Close shared Redis connections
      await closeRedisConnections();
      logger.info('[LIFECYCLE] Redis connections closed.');

      // 7. Disconnect Prisma PostgreSQL client
      await prisma.$disconnect();
      logger.info('[LIFECYCLE] PostgreSQL connection closed.');

      this.state = 'TERMINATED';
      logger.info('[LIFECYCLE] Graceful shutdown completed successfully.');

      if (forceExitTimer) {
        clearTimeout(forceExitTimer);
      }

      if (exitProcess && process.env.NODE_ENV !== 'test') {
        process.exit(0);
      }
    } catch (err: any) {
      logger.error('[LIFECYCLE] Error during graceful shutdown:', { error: err.message });
      if (exitProcess && process.env.NODE_ENV !== 'test') {
        process.exit(1);
      }
    }
  }
}

export const lifecycleManager = new LifecycleManager();

export const getLifecycleState = () => lifecycleManager.getState();
export const isReady = () => lifecycleManager.isReady();
export const isShuttingDown = () => lifecycleManager.getState() === 'SHUTTING_DOWN';
export const setLifecycleState = (state: LifecycleState) => {
  (lifecycleManager as any).state = state;
  if (state === 'INITIALIZING') {
    (lifecycleManager as any).isShuttingDown = false;
  } else if (state === 'SHUTTING_DOWN') {
    (lifecycleManager as any).isShuttingDown = true;
  }
};
export const startApplication = () => lifecycleManager.startup();
export const gracefulShutdown = (server?: any, signal?: string) => {
  if (server && !lifecycleManager['httpServer']) {
    lifecycleManager.registerServers(server, (lifecycleManager as any).io || null);
  }
  return lifecycleManager.shutdown(signal || 'SIGTERM', false);
};
export const reconcileStartupState = () => reconcileDispatchState();

