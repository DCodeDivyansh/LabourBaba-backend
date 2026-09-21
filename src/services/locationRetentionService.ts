import prisma from "../config/prisma";
import { logger } from "../utils/logger";
import { metricsService } from "../metrics/metrics.service";

export interface CleanupResult {
  totalDeleted: number;
  batchesProcessed: number;
  durationMs: number;
  cutoffDate: Date;
}

export interface CleanupOptions {
  batchSize?: number;
  retentionDays?: number;
}

export class LocationRetentionService {
  /**
   * Retrieves the configured retention window in days.
   * Default: 30 days. Bounds: [1, 365].
   */
  getRetentionDays(): number {
    const raw = process.env.LOCATION_HISTORY_RETENTION_DAYS;
    if (!raw) return 30;

    const parsed = parseInt(raw, 10);
    if (isNaN(parsed) || parsed < 1) return 30;
    if (parsed > 365) return 365;

    return parsed;
  }

  /**
   * Calculates the cutoff timestamp before which historical location records are considered expired.
   */
  getExpirationCutoffDate(retentionDays?: number): Date {
    const days = retentionDays !== undefined ? retentionDays : this.getRetentionDays();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    return cutoff;
  }

  /**
   * Performs bounded batch deletion of expired worker location history records.
   * Uses subquery with LIMIT to prevent long-running table locks on the high-write worker_location table.
   */
  async cleanupExpiredLocationHistory(options?: CleanupOptions): Promise<CleanupResult> {
    const batchSize = Math.max(1, Math.min(options?.batchSize || 1000, 5000));
    const cutoffDate = this.getExpirationCutoffDate(options?.retentionDays);
    const startTime = Date.now();

    let totalDeleted = 0;
    let batchesProcessed = 0;

    logger.info("[LOCATION_RETENTION] Starting location history cleanup", {
      retentionDays: options?.retentionDays || this.getRetentionDays(),
      cutoffDate: cutoffDate.toISOString(),
      batchSize,
    });

    try {
      while (true) {
        batchesProcessed++;

        // Delete bounded batch using subquery
        const result = await prisma.$executeRaw`
          DELETE FROM worker_location
          WHERE id IN (
            SELECT id FROM worker_location
            WHERE updated_at < ${cutoffDate}
            LIMIT ${batchSize}
          );
        `;

        totalDeleted += Number(result);

        // If batch returned fewer items than batchSize, we've exhausted all expired rows
        if (Number(result) < batchSize) {
          break;
        }

        // Bounded throttle between batches to allow concurrent writes to proceed smoothly
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      const durationMs = Date.now() - startTime;

      // Record metrics
      metricsService.recordLocationCleanup(totalDeleted, durationMs);

      logger.info("[LOCATION_RETENTION] Completed location history cleanup successfully", {
        totalDeleted,
        batchesProcessed,
        durationMs,
      });

      return {
        totalDeleted,
        batchesProcessed,
        durationMs,
        cutoffDate,
      };
    } catch (error: any) {
      const durationMs = Date.now() - startTime;
      logger.error("[LOCATION_RETENTION] Error executing location history cleanup:", {
        error: error.message,
        durationMs,
        batchesProcessed,
        totalDeleted,
      });
      throw error;
    }
  }
}

export const locationRetentionService = new LocationRetentionService();
