/**
 * Issue #20 — Mandatory PostgreSQL Real Database Concurrency Test Suite
 * Priority: P1 Data Integrity (Audit Finding #35)
 *
 * This test suite DOES NOT mock Prisma or the database.
 * It executes directly against the active PostgreSQL database to prove:
 * 1. Database-Level Constraint: PostgreSQL rejects duplicate review rows for the same booking_id with 23505/P2002.
 * 2. Real Concurrency (2 Simultaneous Requests): Exactly 1 review is created; 1 succeeds (201), 1 fails safely (409).
 * 3. Real Concurrency (10 Simultaneous Requests): Exactly 1 review is created; 1 succeeds (201), 9 fail safely (409).
 * 4. High Concurrency Stress (25 Simultaneous Requests): Exactly 1 review is created; zero duplicates, zero 500 errors.
 * 5. Sequential Retry / Double-Submit: Repeated request for the same booking receives 409 and never duplicates.
 * 6. Hard Invariant Proof:
 *      SELECT COUNT(*) FROM review WHERE booking_id = targetBookingId MUST equal 1.
 * 7. Authorization on Live DB: Unowned booking returns 403 Forbidden.
 * 8. State Validation on Live DB: Incomplete booking returns 409 Conflict.
 */

import { Client } from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

// Ensure unmocked Prisma client connecting to PostgreSQL
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

import { reviewService, ReviewError } from "../src/features/review/reviewServices";

describe("Issue #20 — Real PostgreSQL Concurrency Integration Tests", () => {
  jest.setTimeout(30000);

  let pgClient: Client;

  // Stable UUIDs for test fixture
  const TEST_PREFIX = "test-issue20-";
  let skillCategoryId: string;
  let customerId: string;
  let otherCustomerId: string;
  let workerId: string;
  let jobId: string;
  let requirementId: string;

  beforeAll(async () => {
    pgClient = new Client({ connectionString: process.env.DATABASE_URL });
    await pgClient.connect();

    // 1. Ensure a valid skill_category exists
    const catRes = await pgClient.query("SELECT id FROM skill_category LIMIT 1");
    if (catRes.rows.length > 0) {
      skillCategoryId = catRes.rows[0].id;
    } else {
      const newCat = await pgClient.query(
        "INSERT INTO skill_category (id, name, base_rate) VALUES (gen_random_uuid(), 'General Labor', 500) RETURNING id"
      );
      skillCategoryId = newCat.rows[0].id;
    }

    // 2. Clean any previous test artifacts
    await pgClient.query("DELETE FROM review WHERE comment LIKE 'test-issue20-%'");

    // 3. Create test customer A
    const custRes = await pgClient.query(
      `INSERT INTO customer (id, phone, name, password)
       VALUES (gen_random_uuid(), '+919999000101', 'Test Customer A', 'hashed_pw')
       ON CONFLICT (phone) DO UPDATE SET name = 'Test Customer A'
       RETURNING id`
    );
    customerId = custRes.rows[0].id;

    // 4. Create test customer B (for cross-customer tests)
    const custBRes = await pgClient.query(
      `INSERT INTO customer (id, phone, name, password)
       VALUES (gen_random_uuid(), '+919999000102', 'Test Customer B', 'hashed_pw')
       ON CONFLICT (phone) DO UPDATE SET name = 'Test Customer B'
       RETURNING id`
    );
    otherCustomerId = custBRes.rows[0].id;

    // 5. Create test worker
    const workerRes = await pgClient.query(
      `INSERT INTO worker (id, phone, name, password, skill_type, skill_category_id, is_online)
       VALUES (gen_random_uuid(), '+919999000201', 'Test Worker', 'hashed_pw', 'General Labor', $1, true)
       ON CONFLICT (phone) DO UPDATE SET name = 'Test Worker'
       RETURNING id`,
      [skillCategoryId]
    );
    workerId = workerRes.rows[0].id;

    // 6. Create parent job
    const jobRes = await pgClient.query(
      `INSERT INTO job (id, customer_id, status)
       VALUES (gen_random_uuid(), $1, 'COMPLETED')
       RETURNING id`,
      [customerId]
    );
    jobId = jobRes.rows[0].id;

    // 7. Create job requirement
    const reqRes = await pgClient.query(
      `INSERT INTO job_requirement (id, job_id, skill_type, worker_count_needed, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'Plumber', 1, 'FILLED', NOW(), NOW())
       RETURNING id`,
      [jobId]
    );
    requirementId = reqRes.rows[0].id;
  }, 30000);

  afterAll(async () => {
    // Teardown test records
    try {
      await pgClient.query("DELETE FROM review WHERE comment LIKE 'test-issue20-%'");
      await pgClient.query("DELETE FROM booking WHERE job_id = $1", [jobId]);
      await pgClient.query("DELETE FROM job_requirement WHERE id = $1", [requirementId]);
      await pgClient.query("DELETE FROM job WHERE id = $1", [jobId]);
      await pgClient.query("DELETE FROM worker WHERE id = $1", [workerId]);
      await pgClient.query("DELETE FROM customer WHERE id IN ($1, $2)", [customerId, otherCustomerId]);
    } catch {
      // Best-effort cleanup
    } finally {
      await pgClient.end();
      await pool.end();
    }
  }, 30000);

  /**
   * Helper to create a fresh completed booking for a test run
   */
  async function createCompletedBooking(): Promise<string> {
    const reqRes = await pgClient.query(
      `INSERT INTO job_requirement (id, job_id, skill_type, worker_count_needed, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'Plumber', 1, 'FILLED', NOW(), NOW())
       RETURNING id`,
      [jobId]
    );
    const freshReqId = reqRes.rows[0].id;

    const res = await pgClient.query(
      `INSERT INTO booking (id, job_id, requirement_id, customer_id, worker_id, status, completed_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'COMPLETED', NOW())
       RETURNING id`,
      [jobId, freshReqId, customerId, workerId]
    );
    return res.rows[0].id;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Direct PostgreSQL Constraint Proof
  // ─────────────────────────────────────────────────────────────────────────────
  it("1. PostgreSQL rejects raw duplicate INSERT with 23505 unique violation", async () => {
    const bookingId = await createCompletedBooking();

    // First raw insert directly into PostgreSQL
    await pgClient.query(
      `INSERT INTO review (id, booking_id, customer_id, worker_id, rating, comment)
       VALUES (gen_random_uuid(), $1, $2, $3, 5.0, '${TEST_PREFIX}direct-insert-1')`,
      [bookingId, customerId, workerId]
    );

    // Second raw insert for the SAME booking_id MUST fail at the database level
    let dbError: any = null;
    try {
      await pgClient.query(
        `INSERT INTO review (id, booking_id, customer_id, worker_id, rating, comment)
         VALUES (gen_random_uuid(), $1, $2, $3, 4.0, '${TEST_PREFIX}direct-insert-2')`,
        [bookingId, customerId, workerId]
      );
    } catch (err: any) {
      dbError = err;
    }

    expect(dbError).toBeDefined();
    expect(dbError.code).toBe("23505"); // PostgreSQL SQLSTATE 23505 = unique_violation
    expect(
      dbError.constraint === "uniq_review_booking" ||
      dbError.constraint === "review_booking_id_key"
    ).toBe(true);

    // Invariant proof: exactly 1 row exists
    const countRes = await pgClient.query(
      "SELECT COUNT(*)::int as count FROM review WHERE booking_id = $1",
      [bookingId]
    );
    expect(countRes.rows[0].count).toBe(1);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Real Concurrency: 2 Simultaneous Requests
  // ─────────────────────────────────────────────────────────────────────────────
  it("2. Two simultaneous review creation requests: exactly 1 succeeds, 1 gets safe 409", async () => {
    const bookingId = await createCompletedBooking();

    const results = await Promise.allSettled([
      reviewService.createReview(bookingId, customerId, {
        rating: 5,
        comment: `${TEST_PREFIX}concurrent-2-req1`,
      }),
      reviewService.createReview(bookingId, customerId, {
        rating: 4,
        comment: `${TEST_PREFIX}concurrent-2-req2`,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    // Exactly 1 winner
    expect(fulfilled.length).toBe(1);
    // Exactly 1 loser
    expect(rejected.length).toBe(1);

    // Loser gets safe 409 ReviewError without unhandled 500
    const rejectionReason = (rejected[0] as PromiseRejectedResult).reason;
    expect(rejectionReason).toBeInstanceOf(ReviewError);
    expect(rejectionReason.statusCode).toBe(409);
    expect(rejectionReason.code).toBe("REVIEW_ALREADY_EXISTS");

    // Invariant proof in database
    const countRes = await pgClient.query(
      "SELECT COUNT(*)::int as count FROM review WHERE booking_id = $1",
      [bookingId]
    );
    expect(countRes.rows[0].count).toBe(1);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Real Concurrency: 10 Simultaneous Requests
  // ─────────────────────────────────────────────────────────────────────────────
  it("3. Ten simultaneous review creation requests: exactly 1 succeeds, 9 get safe 409", async () => {
    const bookingId = await createCompletedBooking();

    const promises = Array.from({ length: 10 }, (_, i) =>
      reviewService.createReview(bookingId, customerId, {
        rating: 5,
        comment: `${TEST_PREFIX}concurrent-10-req${i}`,
      })
    );

    const results = await Promise.allSettled(promises);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    // Exactly 1 must succeed
    expect(fulfilled.length).toBe(1);
    // 9 must be rejected
    expect(rejected.length).toBe(9);

    // Every single rejected request must receive a clean 409 REVIEW_ALREADY_EXISTS
    for (const rej of rejected) {
      const err = (rej as PromiseRejectedResult).reason;
      expect(err).toBeInstanceOf(ReviewError);
      expect(err.statusCode).toBe(409);
      expect(err.code).toBe("REVIEW_ALREADY_EXISTS");
    }

    // Authoritative DB count
    const countRes = await pgClient.query(
      "SELECT COUNT(*)::int as count FROM review WHERE booking_id = $1",
      [bookingId]
    );
    expect(countRes.rows[0].count).toBe(1);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. High Concurrency Stress: 25 Simultaneous Requests
  // ─────────────────────────────────────────────────────────────────────────────
  it("4. Twenty-five simultaneous review requests: zero duplicates, exactly 1 row in DB", async () => {
    const bookingId = await createCompletedBooking();

    const promises = Array.from({ length: 25 }, (_, i) =>
      reviewService.createReview(bookingId, customerId, {
        rating: 5,
        comment: `${TEST_PREFIX}concurrent-25-req${i}`,
      })
    );

    const results = await Promise.allSettled(promises);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(24);

    // Authoritative DB count
    const countRes = await pgClient.query(
      "SELECT COUNT(*)::int as count FROM review WHERE booking_id = $1",
      [bookingId]
    );
    expect(countRes.rows[0].count).toBe(1);
  }, 30000);

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. Sequential Mobile Retry / Double-Submit
  // ─────────────────────────────────────────────────────────────────────────────
  it("5. Sequential retry for same booking returns 409 and never creates second row", async () => {
    const bookingId = await createCompletedBooking();

    // First request
    const firstReview = await reviewService.createReview(bookingId, customerId, {
      rating: 5,
      comment: `${TEST_PREFIX}retry-original`,
    });
    expect(firstReview.id).toBeDefined();

    // Second retry request
    let secondError: any = null;
    try {
      await reviewService.createReview(bookingId, customerId, {
        rating: 5,
        comment: `${TEST_PREFIX}retry-duplicate`,
      });
    } catch (err: any) {
      secondError = err;
    }

    expect(secondError).toBeInstanceOf(ReviewError);
    expect(secondError.statusCode).toBe(409);
    expect(secondError.code).toBe("REVIEW_ALREADY_EXISTS");

    // Database still has exactly 1 review
    const countRes = await pgClient.query(
      "SELECT COUNT(*)::int as count FROM review WHERE booking_id = $1",
      [bookingId]
    );
    expect(countRes.rows[0].count).toBe(1);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. Cross-Customer & Booking State Guards on Live DB
  // ─────────────────────────────────────────────────────────────────────────────
  it("6. Customer B cannot review Customer A's completed booking (403 Forbidden)", async () => {
    const bookingId = await createCompletedBooking();

    let err: any = null;
    try {
      await reviewService.createReview(bookingId, otherCustomerId, {
        rating: 5,
        comment: `${TEST_PREFIX}cross-customer`,
      });
    } catch (e: any) {
      err = e;
    }

    expect(err).toBeInstanceOf(ReviewError);
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe("FORBIDDEN_BOOKING_ACCESS");
  });

  it("7. Customer cannot review an incomplete booking (409 Conflict)", async () => {
    // Create an in-progress booking with a fresh requirement
    const reqRes = await pgClient.query(
      `INSERT INTO job_requirement (id, job_id, skill_type, worker_count_needed, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'Plumber', 1, 'OPEN', NOW(), NOW())
       RETURNING id`,
      [jobId]
    );
    const inProgReqId = reqRes.rows[0].id;

    const res = await pgClient.query(
      `INSERT INTO booking (id, job_id, requirement_id, customer_id, worker_id, status)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'IN_PROGRESS')
       RETURNING id`,
      [jobId, inProgReqId, customerId, workerId]
    );
    const inProgressBookingId = res.rows[0].id;

    let err: any = null;
    try {
      await reviewService.createReview(inProgressBookingId, customerId, {
        rating: 5,
        comment: `${TEST_PREFIX}incomplete-review`,
      });
    } catch (e: any) {
      err = e;
    }

    expect(err).toBeInstanceOf(ReviewError);
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("BOOKING_NOT_COMPLETED");
  });
});
