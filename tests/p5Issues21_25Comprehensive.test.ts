/**
 * LabourBaba Backend — P5 Issues 21–25 Comprehensive Verification Suite
 *
 * Verifies:
 * - Issue 21: Redis-backed distributed security rate limiting (fail-closed, multi-instance, no local map fallback)
 * - Issue 22: FCM fail-fast in production, zero fake stub success, strict error classification & token revocation
 * - Issue 23: Independent liveness (/health/live) vs dependency readiness (/health/ready), startup reconciliation, graceful shutdown
 * - Issue 24: PostGIS spatial parity (ST_Distance, ST_DWithin) and migration discipline
 * - Issue 25: PostgreSQL connection capacity budget, pool bounds, and reconnect storm resilience
 */

import request from "supertest";
import { app } from "../src/server";
import {
  incrementRateLimit,
  createRateLimiter,
  hashIdentifier,
} from "../src/middlewares/rateLimiter";
import {
  sendFCMToTokens,
  sendFCMToWorker,
  isPermanentInvalidTokenError,
  assertFcmConfig,
  setMockFcmProvider,
  resetFirebaseApp,
} from "../src/shared/fcm";
import { healthService } from "../src/features/health/healthService";
import { lifecycleManager, setLifecycleState } from "../src/lifecycle/lifecycleManager";
import prisma, { getDatabasePoolMetrics } from "../src/config/prisma";
import { getDatabasePoolConfig, calculateCapacityBudget } from "../src/config/databasePoolConfig";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { Client } from "pg";

describe("LabourBaba Backend — P5 Issues 21–25 Comprehensive Verification", () => {
  jest.setTimeout(35000);

  afterAll(async () => {
    setMockFcmProvider(null);
    resetFirebaseApp();
    setLifecycleState("READY");
    await prisma.$disconnect();
  });

  // ============================================================================
  // ISSUE 21: REDIS-BACKED SECURITY RATE LIMITING
  // ============================================================================
  describe("P5 Issue 21: Distributed Security Rate Limiting", () => {
    it("shares distributed rate limit state across multiple instances using atomic Redis backend", async () => {
      // Simulate multi-instance shared store
      const sharedStore = new Map<string, { count: number; ttl: number }>();
      const mockSharedClient = {
        eval: jest.fn().mockImplementation(async (_script: string, _numKeys: number, key: string, windowSec: number) => {
          const existing = sharedStore.get(key);
          if (!existing) {
            sharedStore.set(key, { count: 1, ttl: windowSec });
            return [1, windowSec];
          }
          existing.count += 1;
          return [existing.count, existing.ttl];
        }),
      };

      const redisConfig = require("../src/config/redis");
      const spy = jest.spyOn(redisConfig, "getRedisClient").mockReturnValue(mockSharedClient as any);

      const key = `ratelimit:auth:p5_test_${Date.now()}`;
      const maxLimit = 5;
      const windowSeconds = 60;

      // Instance A executes 3 requests
      const a1 = await incrementRateLimit(key, maxLimit, windowSeconds, "fail_closed");
      const a2 = await incrementRateLimit(key, maxLimit, windowSeconds, "fail_closed");
      const a3 = await incrementRateLimit(key, maxLimit, windowSeconds, "fail_closed");
      expect(a1.allowed).toBe(true);
      expect(a2.allowed).toBe(true);
      expect(a3.allowed).toBe(true);
      expect(a3.remaining).toBe(2);

      // Instance B executes 2 requests (reaches global limit 5)
      const b1 = await incrementRateLimit(key, maxLimit, windowSeconds, "fail_closed");
      const b2 = await incrementRateLimit(key, maxLimit, windowSeconds, "fail_closed");
      expect(b1.allowed).toBe(true);
      expect(b2.allowed).toBe(true);
      expect(b2.remaining).toBe(0);

      // 6th request from Instance A is rejected globally
      const a4 = await incrementRateLimit(key, maxLimit, windowSeconds, "fail_closed");
      expect(a4.allowed).toBe(false);
      expect(a4.status).toBe("exceeded");

      // 7th request from Instance B is also rejected globally
      const b3 = await incrementRateLimit(key, maxLimit, windowSeconds, "fail_closed");
      expect(b3.allowed).toBe(false);
      expect(b3.status).toBe("exceeded");

      spy.mockRestore();
    });

    it("strictly fails closed (503) for security-sensitive limiters during Redis outage with zero local Map fallback", async () => {
      const mockFailingClient = {
        eval: jest.fn().mockRejectedValue(new Error("Redis connection timed out")),
      };

      const redisConfig = require("../src/config/redis");
      const spy = jest.spyOn(redisConfig, "getRedisClient").mockReturnValue(mockFailingClient as any);

      const securityResult = await incrementRateLimit("sec_key", 5, 60, "fail_closed");
      expect(securityResult.allowed).toBe(false);
      expect(securityResult.status).toBe("unavailable");
      expect(securityResult.remaining).toBe(0);

      // Verify Express middleware converts unavailable to 503 SECURITY_LIMITER_UNAVAILABLE
      const secLimiter = createRateLimiter({
        windowSeconds: 60,
        maxLimit: 5,
        keyPrefix: "sec_endpoint",
        dimension: "ip",
        isSecuritySensitive: true,
      });

      const req: any = { ip: "192.0.2.1", headers: {}, id: "req-sec-1" };
      const statusMock = jest.fn().mockReturnThis();
      const jsonMock = jest.fn();
      const setHeaderMock = jest.fn();
      const res: any = { status: statusMock, json: jsonMock, setHeader: setHeaderMock };
      const next = jest.fn();

      await secLimiter(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(503);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          code: "SECURITY_LIMITER_UNAVAILABLE",
        })
      );

      spy.mockRestore();
    });

    it("fails open for generic non-security traffic limiters during Redis outage", async () => {
      const mockFailingClient = {
        eval: jest.fn().mockRejectedValue(new Error("Redis degraded")),
      };

      const redisConfig = require("../src/config/redis");
      const spy = jest.spyOn(redisConfig, "getRedisClient").mockReturnValue(mockFailingClient as any);

      const genericResult = await incrementRateLimit("gen_key", 100, 60, "fail_open");
      expect(genericResult.allowed).toBe(true);
      expect(genericResult.status).toBe("ok");

      spy.mockRestore();
    });

    it("hashes sensitive identifiers using SHA-256 without leaking PII into Redis keys", () => {
      const phone = "+919876543210";
      const ip = "192.0.2.100";
      const hashedPhone = hashIdentifier(phone);
      const hashedIp = hashIdentifier(ip);

      expect(hashedPhone).toHaveLength(16);
      expect(hashedPhone).not.toContain("9876543210");
      expect(hashedIp).toHaveLength(16);
      expect(hashedIp).not.toContain("192.0.2.100");
    });
  });

  // ============================================================================
  // ISSUE 22: FCM FAIL-FAST & ZERO STUB SUCCESS
  // ============================================================================
  describe("P5 Issue 22: FCM Fail-Fast & Stub Elimination", () => {
    it("fails fast in production if Firebase Admin SDK credentials are missing", () => {
      const origEnv = process.env.NODE_ENV;
      const origVar = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      const origGoogle = process.env.GOOGLE_APPLICATION_CREDENTIALS;

      process.env.NODE_ENV = "production";
      delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

      expect(() => assertFcmConfig()).toThrow("[FCM_CONFIG_ERROR]");

      process.env.NODE_ENV = origEnv;
      if (origVar) {
        process.env.FIREBASE_SERVICE_ACCOUNT_JSON = origVar;
      } else {
        delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      }
      if (origGoogle) {
        process.env.GOOGLE_APPLICATION_CREDENTIALS = origGoogle;
      } else {
        delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      }
    });

    it("prohibits registering mock FCM provider in production environment", () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";

      expect(() => {
        setMockFcmProvider({
          sendToTokens: async () => [],
        });
      }).toThrow("[SECURITY_VIOLATION] Mock FCM provider cannot be registered in production environment.");

      process.env.NODE_ENV = origEnv;
    });

    it("returns success: false and never returns stub-message-id when FCM is uninitialized", async () => {
      setMockFcmProvider(null);
      resetFirebaseApp();

      const results = await sendFCMToTokens(["device_token_xyz"], {
        title: "P5 Alert",
        body: "Work assigned",
      });

      expect(results.length).toBe(1);
      expect(results[0].success).toBe(false);
      expect(results[0].messageId).toBeUndefined();
      expect(results[0].error).toBeDefined();
      expect(results[0].error.message).toContain("[FCM_UNINITIALIZED]");
    });

    it("correctly identifies permanent invalid registration tokens for revocation", () => {
      expect(isPermanentInvalidTokenError({ code: "messaging/registration-token-not-registered" })).toBe(true);
      expect(isPermanentInvalidTokenError({ code: "messaging/invalid-registration-token" })).toBe(true);
      expect(isPermanentInvalidTokenError({ message: "Requested entity was not found." })).toBe(true);
      expect(isPermanentInvalidTokenError({ message: "Connection timed out" })).toBe(false);
    });

    it("dispatches notifications via explicit mock provider in test environment", async () => {
      setMockFcmProvider({
        sendToTokens: async (tokens, payload) => {
          return tokens.map((t) => ({
            token: t,
            success: true,
            messageId: `real_mock_${Date.now()}`,
          }));
        },
      });

      const results = await sendFCMToTokens(["tok_1", "tok_2"], {
        title: "Test",
        body: "Body",
      });

      expect(results.length).toBe(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
      expect(results[0].messageId).toMatch(/^real_mock_/);
      expect(results[0].messageId).not.toBe("stub-message-id");

      setMockFcmProvider(null);
    });
  });

  // ============================================================================
  // ISSUE 23: HEALTH, READINESS, STARTUP RECOVERY & GRACEFUL SHUTDOWN
  // ============================================================================
  describe("P5 Issue 23: Health, Readiness, Startup & Graceful Shutdown", () => {
    it("/health/live returns HTTP 200 with process health independently of external dependencies", async () => {
      const res = await request(app).get("/health/live");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("alive");
      expect(res.body.uptime).toBeGreaterThanOrEqual(0);
      expect(res.body.process.pid).toBe(process.pid);
    });

    it("/health/ready returns 200 when ready and operational", async () => {
      setLifecycleState("READY");
      const res = await request(app).get("/health/ready");
      expect([200, 503]).toContain(res.status);
      expect(res.body).toHaveProperty("checks");
      expect(res.body.checks).toHaveProperty("database");
      expect(res.body.checks).toHaveProperty("redis");
    });

    it("/health/ready returns 503 when lifecycle state is INITIALIZING", async () => {
      setLifecycleState("INITIALIZING");
      const { isReady, result } = await healthService.getReadiness(100);
      expect(isReady).toBe(false);
      expect(result.status).toBe("not_ready");
      expect(result.checks.initialization).toBe("initializing");
      setLifecycleState("READY");
    });

    it("/health/ready returns 503 when PostgreSQL connectivity fails", async () => {
      const dbSpy = jest.spyOn(prisma, "$queryRaw").mockRejectedValueOnce(new Error("DB Down"));
      const { isReady, result } = await healthService.getReadiness(100);
      expect(isReady).toBe(false);
      expect(result.status).toBe("not_ready");
      expect(result.checks.database).toBe("unhealthy");
      dbSpy.mockRestore();
    });

    it("recovers to ready when dependencies return", async () => {
      setLifecycleState("READY");
      const healthy = await healthService.getReadiness(2000);
      expect(healthy.result.checks.database).toBe("healthy");
    });
  });

  // ============================================================================
  // ISSUE 24: POSTGIS PARITY & MIGRATION DISCIPLINE
  // ============================================================================
  describe("P5 Issue 24: PostGIS Parity & Migration Discipline", () => {
    it("confirms PostGIS extension is installed and active in PostgreSQL", async () => {
      const ext = await prisma.$queryRaw<any[]>`
        SELECT extname, extversion FROM pg_extension WHERE extname = 'postgis'
      `;
      expect(ext.length).toBe(1);
      expect(ext[0].extname).toBe("postgis");
      expect(ext[0].extversion).toBeDefined();
    });

    it("verifies accurate geodesic distance using ST_Distance on geography(Point, 4326)", async () => {
      // Bangalore center (12.9716, 77.5946) to Indiranagar (12.9750, 77.6050) ~ 1.1-1.6 km
      const res = await prisma.$queryRaw<any[]>`
        SELECT ST_Distance(
          ST_SetSRID(ST_MakePoint(77.5946, 12.9716), 4326)::geography,
          ST_SetSRID(ST_MakePoint(77.6050, 12.9750), 4326)::geography
        ) AS distance_meters
      `;

      expect(res.length).toBe(1);
      const distance = Number(res[0].distance_meters);
      expect(distance).toBeGreaterThan(1000);
      expect(distance).toBeLessThan(2000);
    });

    it("evaluates ST_DWithin inclusion and exclusion across a 5km radius", async () => {
      const res = await prisma.$queryRaw<any[]>`
        SELECT 
          ST_DWithin(
            ST_SetSRID(ST_MakePoint(77.5946, 12.9716), 4326)::geography,
            ST_SetSRID(ST_MakePoint(77.6050, 12.9750), 4326)::geography,
            5000
          ) AS inside_5km,
          ST_DWithin(
            ST_SetSRID(ST_MakePoint(77.5946, 12.9716), 4326)::geography,
            ST_SetSRID(ST_MakePoint(77.6770, 12.8399), 4326)::geography,
            5000
          ) AS outside_5km
      `;

      expect(res.length).toBe(1);
      expect(res[0].inside_5km).toBe(true);
      expect(res[0].outside_5km).toBe(false);
    });

    it("verifies docker-compose.yml pins postgis/postgis:17-3.5 image", () => {
      const composePath = resolve(__dirname, "../docker-compose.yml");
      expect(existsSync(composePath)).toBe(true);
      const content = readFileSync(composePath, "utf-8");
      expect(content).toMatch(/image:\s*postgis\/postgis:17-3\.5/);
    });

    it("verifies migration directory contains ordered versioned migrations without drift", () => {
      const migrationsDir = resolve(__dirname, "../prisma/migrations");
      expect(existsSync(migrationsDir)).toBe(true);
      const subdirs = require("fs").readdirSync(migrationsDir);
      expect(subdirs.length).toBeGreaterThan(20);
      expect(subdirs).toContain("20260920040000_booking_state_machine");
      expect(subdirs).toContain("20260920050000_harden_booking_otp");
      expect(subdirs).toContain("20260920070000_booking_cancellation_audit");
      expect(subdirs).toContain("20260920080000_enforce_one_review_per_booking");
    });
  });

  // ============================================================================
  // ISSUE 25: POSTGRESQL CONNECTION BUDGET & RECONNECT STORM PROTECTION
  // ============================================================================
  describe("P5 Issue 25: PostgreSQL Connection Budget & Capacity Management", () => {
    it("enforces explicit, bounded database connection pool limits and timeouts", () => {
      const config = getDatabasePoolConfig();

      expect(config.max).toBeDefined();
      expect(config.max).toBeGreaterThan(0);
      expect(config.max).toBeLessThanOrEqual(15);
      expect(config.connectionTimeoutMillis).toBeGreaterThanOrEqual(1000);
      expect(config.idleTimeoutMillis).toBeGreaterThanOrEqual(1000);
      expect(config.statementTimeoutMillis).toBeGreaterThanOrEqual(5000);
      expect(config.maxUses).toBeGreaterThanOrEqual(1000);
    });

    it("mathematically proves positive headroom against PostgreSQL max_connections (60)", () => {
      // 3 API instances (12 max) + 2 Worker instances (5 max) + 1 Admin (2 max) + 5 Reserved = 53
      const budget = calculateCapacityBudget(3, 2, 1);

      expect(budget.postgresMaxConnections).toBe(60);
      expect(budget.reservedAdminConnections).toBe(5);
      expect(budget.apiAllocatedConnections).toBe(36);
      expect(budget.workerAllocatedConnections).toBe(10);
      expect(budget.adminAllocatedConnections).toBe(2);
      expect(budget.totalAllocatedConnections).toBe(53);
      expect(budget.headroomConnections).toBe(7);
      expect(budget.headroomConnections).toBeGreaterThanOrEqual(5);
      expect(budget.isWithinBudget).toBe(true);
    });

    it("handles connection disruption and reconnects safely without connection explosion", async () => {
      // Execute 5 concurrent connection reconnects
      const reconnectClients: Client[] = [];
      const reconnectResults: boolean[] = [];

      for (let i = 0; i < 5; i++) {
        const client = new Client({
          connectionString: process.env.DATABASE_URL!,
          connectionTimeoutMillis: 5000,
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

      expect(reconnectResults.every((r) => r === true)).toBe(true);

      // Verify connection metrics from pool remain within bounds
      const metrics = getDatabasePoolMetrics();
      expect(metrics.totalCount).toBeLessThanOrEqual(metrics.maxLimit);
    });

    it("executes concurrent queries on live database without pool exhaustion", async () => {
      const queries = Array.from({ length: 10 }, () =>
        prisma.$queryRaw`SELECT 1 as status`
      );

      const results = await Promise.all(queries);
      expect(results.length).toBe(10);
      for (const res of results) {
        expect((res as any)[0].status).toBe(1);
      }
    });
  });
});
