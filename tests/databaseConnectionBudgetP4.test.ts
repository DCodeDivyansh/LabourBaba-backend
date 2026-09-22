import prisma, { pool, getDatabasePoolMetrics } from '../src/config/prisma';
import { getDatabasePoolConfig, calculateCapacityBudget } from '../src/config/databasePoolConfig';

describe('P4 Issue 22: PostgreSQL Connection-Pool Policy & Capacity Budget', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('Explicit connection pool parameters are configured and bounded', () => {
    const config = getDatabasePoolConfig();
    expect(config.max).toBeGreaterThanOrEqual(2);
    expect(config.max).toBeLessThanOrEqual(30);
    expect(config.connectionTimeoutMillis).toBeGreaterThanOrEqual(1000);
    expect(config.idleTimeoutMillis).toBeGreaterThanOrEqual(1000);
    expect(config.statementTimeoutMillis).toBeGreaterThanOrEqual(1000);
    expect(config.maxUses).toBeGreaterThanOrEqual(100);
  });

  it('Capacity budget guarantees mathematically proven positive headroom against PostgreSQL max_connections', () => {
    const budget = calculateCapacityBudget(3, 2, 1);
    expect(budget.postgresMaxConnections).toBe(60);
    expect(budget.reservedAdminConnections).toBe(5);
    expect(budget.apiInstancePoolMax).toBe(12);
    expect(budget.workerInstancePoolMax).toBe(5);
    expect(budget.adminInstancePoolMax).toBe(2);

    expect(budget.apiAllocatedConnections).toBe(36);
    expect(budget.workerAllocatedConnections).toBe(10);
    expect(budget.adminAllocatedConnections).toBe(2);

    // Total allocated = 5 (reserved) + 36 (API) + 10 (Worker) + 2 (Admin) = 53
    expect(budget.totalAllocatedConnections).toBe(53);

    // Guaranteed headroom: 60 - 53 = 7 connections (> 0)
    expect(budget.headroomConnections).toBe(7);
    expect(budget.headroomConnections).toBeGreaterThan(0);
    expect(budget.isWithinBudget).toBe(true);
    expect(budget.maxApiInstancesSupported).toBeGreaterThanOrEqual(3);
  });

  it('Underlying pg.Pool exposes runtime connection metrics', () => {
    const metrics = getDatabasePoolMetrics();
    expect(metrics).toHaveProperty('totalCount');
    expect(metrics).toHaveProperty('idleCount');
    expect(metrics).toHaveProperty('waitingCount');
    expect(metrics).toHaveProperty('maxLimit');
    expect(metrics.maxLimit).toBe(pool.options.max);
  });

  it('Active PostgreSQL pg_stat_activity connections remain strictly within server bounds', async () => {
    const result: any = await prisma.$queryRawUnsafe('SELECT count(*) as total_connections FROM pg_stat_activity;');
    const totalConnections = Number(result[0].total_connections);

    const maxConnResult: any = await prisma.$queryRawUnsafe('SHOW max_connections;');
    const maxConnections = Number(maxConnResult[0].max_connections);

    expect(totalConnections).toBeGreaterThan(0);
    expect(totalConnections).toBeLessThan(maxConnections);
  });

  it('Burst concurrent queries execute safely without exceeding pool maximum', async () => {
    const concurrentTasks = Array.from({ length: 20 }, (_, idx) =>
      prisma.$queryRawUnsafe(`SELECT ${idx} AS query_idx, pg_backend_pid() AS pid;`)
    );

    const results = await Promise.all(concurrentTasks);
    expect(results).toHaveLength(20);

    const metrics = getDatabasePoolMetrics();
    expect(metrics.totalCount).toBeLessThanOrEqual(pool.options.max as number);
  });
});
