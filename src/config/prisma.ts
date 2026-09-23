import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { getDatabasePoolConfig } from "./databasePoolConfig";

import { logger } from "../utils/logger";

const poolConfig = getDatabasePoolConfig();

export const pool = new pg.Pool({
  connectionString: poolConfig.connectionString,
  max: poolConfig.max,
  connectionTimeoutMillis: poolConfig.connectionTimeoutMillis,
  idleTimeoutMillis: poolConfig.idleTimeoutMillis,
  statement_timeout: poolConfig.statementTimeoutMillis,
  maxUses: poolConfig.maxUses,
});

// Attach pool error listener to prevent uncaught process crashes
pool.on("error", (err) => {
  try {
    const { metricsService } = require("../metrics/metrics.service");
    metricsService.setDatabaseHealth(false);
    metricsService.recordDatabaseError("pool");
  } catch {}
  if (process.env.NODE_ENV !== "test") {
    logger.error("[POSTGRES_POOL_ERROR]", { error: err.message });
  }
});

const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

/**
 * Returns current runtime metrics from the underlying PostgreSQL connection pool.
 */
export function getDatabasePoolMetrics() {
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
    maxLimit: poolConfig.max,
  };
}

/**
 * Cleanly drains and terminates the PostgreSQL connection pool.
 */
export async function closeDatabaseConnections(): Promise<void> {
  try {
    await prisma.$disconnect();
    await pool.end();
  } catch (err: any) {
    if (process.env.NODE_ENV !== "test") {
      logger.error("[POSTGRES_POOL_CLOSE_ERROR]", { error: err.message || String(err) });
    }
  }
}

export default prisma;
