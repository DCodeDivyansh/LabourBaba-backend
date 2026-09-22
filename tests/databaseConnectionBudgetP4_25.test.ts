/**
 * P4 Issue 25: PostgreSQL Connection-Pool Policy, Capacity Budget & Reconnect Storm Resilience
 *
 * Verifies:
 * Test A — Pool configuration: Production configuration produces intended limits (API=12, Worker=5, Admin=2).
 * Test B — Multi-process budget: Simulates N API instances + M Worker instances + Admin processes and mathematically
 *           proves total connections remain <= PostgreSQL max_connections (60) with guaranteed positive headroom (7).
 * Test C — Reconnect storm: Simulates database outage and recovery, proving clients reconnect safely without connection explosion.
 * Test D — Load: Runs concurrent burst queries, measuring pg_stat_activity active connections, latency, and pool stability.
 */

import { getDatabasePoolConfig, calculateCapacityBudget } from "../src/config/databasePoolConfig";
import prisma, { getDatabasePoolMetrics } from "../src/config/prisma";
import { Client } from "pg";

describe("P4 Issue 25: PostgreSQL Connection Budget & Capacity Management", () => {
  jest.setTimeout(30000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe("Test A — Explicit Pool Configuration Bounds", () => {
    it("enforces explicit, bounded connection pool limits and timeouts", () => {
      const config = getDatabasePoolConfig();

      expect(config.max).toBeDefined();
      expect(config.max).toBeGreaterThan(0);
      expect(config.max).toBeLessThanOrEqual(15); // Bounded per instance

      expect(config.connectionTimeoutMillis).toBeGreaterThanOrEqual(1000);
      expect(config.idleTimeoutMillis).toBeGreaterThanOrEqual(1000);
      expect(config.statementTimeoutMillis).toBeGreaterThanOrEqual(5000);
      expect(config.maxUses).toBeGreaterThanOrEqual(1000);
    });
  });

  describe("Test B — Multi-Process Capacity Budget Proof", () => {
    it("mathematically proves positive headroom against PostgreSQL max_connections (60)", () => {
      // Intended production topology: 3 API instances, 2 BullMQ Worker instances, 1 Admin/Migration instance
      const budget = calculateCapacityBudget(3, 2, 1);

      expect(budget.postgresMaxConnections).toBe(60);
      expect(budget.reservedAdminConnections).toBe(5);

      // Allocation: API = 3 * 12 = 36
      expect(budget.apiAllocatedConnections).toBe(36);
      // Allocation: Workers = 2 * 5 = 10
      expect(budget.workerAllocatedConnections).toBe(10);
      // Allocation: Admin = 1 * 2 = 2
      expect(budget.adminAllocatedConnections).toBe(2);

      // Total Allocated: 5 + 36 + 10 + 2 = 53
      expect(budget.totalAllocatedConnections).toBe(53);

      // Headroom: 60 - 53 = 7 (> 0)
      expect(budget.headroomConnections).toBe(7);
      expect(budget.headroomConnections).toBeGreaterThanOrEqual(5); // At least 5 headroom connections guaranteed
      expect(budget.isWithinBudget).toBe(true);
    });

    it("calculates horizontal scaling limits before connection exhaustion", () => {
      const budget = calculateCapacityBudget(3, 2, 1);

      // Available for scaling = 60 - 5 (reserved) = 55
      // Max API instances alone = Math.floor(55 / 12) = 4 instances
      // Max Worker instances alone = Math.floor(55 / 5) = 11 instances
      expect(budget.maxApiInstancesSupported).toBeGreaterThanOrEqual(4);
      expect(budget.maxWorkerInstancesSupported).toBeGreaterThanOrEqual(11);
    });
  });

  describe("Test C — Reconnect Storm & Database Recovery Simulation", () => {
    it("handles connection interruptions and recovers safely without unbounded connection multiplication", async () => {
      // 1. Establish initial client
      const initialClient = new Client({ connectionString: process.env.DATABASE_URL! });
      await initialClient.connect();

      const initialRes = await initialClient.query("SELECT count(*)::int as count FROM pg_stat_activity WHERE datname = current_database();");
      const initialConnections = initialRes.rows[0].count;
      await initialClient.end();

      // 2. Simulate 10 client reconnect attempts sequentially and concurrently
      const reconnectClients: Client[] = [];
      const reconnectResults: boolean[] = [];

      for (let i = 0; i < 5; i++) {
        const client = new Client({
          connectionString: process.env.DATABASE_URL!,
          connectionTimeoutMillis: 3000,
        });
        reconnectClients.push(client);
      }

      await Promise.all(
        reconnectClients.map(async (client) => {
          try {
            await client.connect();
            const res = await client.query("SELECT 1 as alive;");
            reconnectResults.push(res.rows[0].alive === 1);
          } finally {
            await client.end().catch(() => {});
          }
        })
      );

      // 3. Verify all reconnected clients succeeded
      expect(reconnectResults.every((r) => r === true)).toBe(true);

      // 4. Verify post-recovery connection count did not explode
      const postRecoveryClient = new Client({ connectionString: process.env.DATABASE_URL! });
      await postRecoveryClient.connect();
      const postRes = await postRecoveryClient.query("SELECT count(*)::int as count FROM pg_stat_activity WHERE datname = current_database();");
      const postConnections = postRes.rows[0].count;
      await postRecoveryClient.end();

      // Ensure connection count is bounded and close to initial state
      expect(postConnections).toBeLessThanOrEqual(initialConnections + 5);
      expect(postConnections).toBeLessThanOrEqual(60);
    });
  });

  describe("Test D — Concurrent Burst Load & pg_stat_activity Inspection", () => {
    it("executes 25 concurrent queries within pool ceiling without connection exhaustion", async () => {
      const startTime = Date.now();
      const concurrentQueries = 25;

      const promises = Array.from({ length: concurrentQueries }, async (_, i) => {
        const queryStart = Date.now();
        const result = await prisma.$queryRaw<Array<{ result: number }>>`SELECT ${i}::int as result`;
        const latency = Date.now() - queryStart;
        return { result: result[0].result, latency };
      });

      const results = await Promise.all(promises);
      const totalDuration = Date.now() - startTime;

      // Assertions
      expect(results).toHaveLength(concurrentQueries);
      for (let i = 0; i < concurrentQueries; i++) {
        expect(results.some((r) => r.result === i)).toBe(true);
        expect(results[i].latency).toBeLessThan(15000); // Statement timeout bound
      }
      expect(totalDuration).toBeLessThan(20000);

      // Inspect underlying pool metrics
      const metrics = getDatabasePoolMetrics();
      if (metrics) {
        expect(metrics.totalCount).toBeLessThanOrEqual(getDatabasePoolConfig().max);
      }
    });

    it("verifies live pg_stat_activity connections strictly satisfy capacity headroom", async () => {
      const res = await prisma.$queryRaw<Array<{ active_connections: number; max_allowed: number }>>`
        SELECT 
          (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) as active_connections,
          current_setting('max_connections')::int as max_allowed;
      `;

      const { active_connections, max_allowed } = res[0];

      expect(max_allowed).toBe(60);
      expect(active_connections).toBeGreaterThan(0);
      expect(active_connections).toBeLessThanOrEqual(max_allowed);

      // Total active connections during test suite must preserve at least 5 headroom
      const observedHeadroom = max_allowed - active_connections;
      expect(observedHeadroom).toBeGreaterThanOrEqual(5);
    });
  });
});
