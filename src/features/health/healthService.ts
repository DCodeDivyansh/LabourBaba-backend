import prisma from '../../config/prisma';
import { getRedisClient } from '../../config/redis';
import { lifecycleManager } from '../../lifecycle/lifecycleManager';
import { logger } from '../../utils/logger';
import { metricsService } from '../../metrics/metrics.service';

export interface HealthCheckResult {
  status: 'ready' | 'not_ready';
  timestamp: string;
  uptimeSeconds: number;
  checks: {
    database: 'healthy' | 'unhealthy';
    redis: 'healthy' | 'unhealthy';
    initialization: 'ready' | 'initializing' | 'shutting_down';
  };
}

/**
 * Executes a promise with a hard timeout.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, name: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`[HEALTHCHECK_TIMEOUT] ${name} check timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timer!);
    return result;
  } catch (err) {
    clearTimeout(timer!);
    throw err;
  }
}

export const healthService = {
  /**
   * Liveness Probe: Fast process health. Does not depend on external services.
   */
  getLiveness() {
    return {
      status: 'alive',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      process: {
        pid: process.pid,
        memoryUsage: process.memoryUsage(),
      },
    };
  },

  /**
   * Readiness Probe: Verifies critical infrastructure dependencies.
   */
  async getReadiness(timeoutMs = 2000): Promise<{ isReady: boolean; result: HealthCheckResult }> {
    const lifecycleState = lifecycleManager.getState();
    const isAppInitialized = lifecycleState === 'READY';

    let dbStatus: 'healthy' | 'unhealthy' = 'unhealthy';
    let redisStatus: 'healthy' | 'unhealthy' = 'unhealthy';

    // 1. Check PostgreSQL Database Connectivity
    try {
      await withTimeout(prisma.$queryRaw`SELECT 1`, timeoutMs, 'database');
      dbStatus = 'healthy';
    } catch (err: any) {
      logger.error('[HEALTHCHECK_DB_FAILURE]', { error: err.message });
      dbStatus = 'unhealthy';
    }

    // 2. Check Redis Connectivity
    try {
      const pong = await withTimeout(getRedisClient().ping(), timeoutMs, 'redis');
      if (pong === 'PONG') {
        redisStatus = 'healthy';
      }
    } catch (err: any) {
      logger.error('[HEALTHCHECK_REDIS_FAILURE]', { error: err.message });
      redisStatus = 'unhealthy';
    }

    const isReady = isAppInitialized && dbStatus === 'healthy' && redisStatus === 'healthy';

    // Update Prometheus health telemetry gauges for alert evaluation
    metricsService.setDatabaseHealth(dbStatus === 'healthy');
    metricsService.setRedisHealth(redisStatus === 'healthy');
    metricsService.setApplicationReady(isReady);

    const result: HealthCheckResult = {
      status: isReady ? 'ready' : 'not_ready',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      checks: {
        database: dbStatus,
        redis: redisStatus,
        initialization: isAppInitialized
          ? 'ready'
          : lifecycleState === 'INITIALIZING'
            ? 'initializing'
            : 'shutting_down',
      },
    };

    return { isReady, result };
  },
};
