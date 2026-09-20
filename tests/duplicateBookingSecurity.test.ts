import request from "supertest";
import { app } from "../src/server";
import prisma from "../src/config/prisma";
import { generateToken } from "../src/utils/authUtils";
import { UserRole } from "../src/middlewares/authMiddleware";
import { Prisma } from "@prisma/client";

// Mock dependencies
jest.mock("../src/config/prisma", () => ({
  __esModule: true,
  default: {
    $queryRaw: jest.fn().mockResolvedValue([{ latitude: 26.85, longitude: 80.95 }]),
    $transaction: jest.fn(),
    worker: {
      findUnique: jest.fn().mockResolvedValue({
        id: "worker-id",
        name: "Test Worker",
        phone: "+919876543211",
        skill_type: "Plumber",
        worker_score: 95,
      }),
    },
    job_requirement: {
      findUnique: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    job_dispatch: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    booking: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    job: {
      update: jest.fn(),
    },
  },
}));

jest.mock("../src/server", () => {
  const actualServer = jest.requireActual("../src/server");
  return {
    ...actualServer,
    io: {
      to: jest.fn().mockReturnValue({
        emit: jest.fn(),
      }),
    },
  };
});

describe("P0 Finding #10 Security & Concurrency Suite: Database-Level Duplicate Booking Prevention", () => {
  const JOB_ID = "55555555-5555-4555-a555-555555555555";
  const REQ_ID = "77777777-7777-4777-a777-777777777777";
  const CUSTOMER_ID = "33333333-3333-4333-a333-333333333333";
  const WORKER_A_ID = "11111111-1111-4111-a111-111111111111";

  let workerAToken: string;
  let customerToken: string;

  // In-memory simulated database state
  interface RequirementState {
    id: string;
    job_id: string;
    skill_type: string;
    worker_count_needed: number;
    worker_count_filled: number;
    status: string;
    job: { id: string; customer_id: string; dispatch_status: string };
  }

  interface DispatchState {
    id: string;
    requirement_id: string;
    worker_id: string;
    status: string;
    expires_at: Date | null;
    responded_at?: Date | null;
  }

  interface BookingState {
    id: string;
    job_id: string;
    requirement_id: string;
    worker_id: string;
    customer_id: string;
    status: string;
    otp_hash: string;
  }

  let db: {
    requirements: Map<string, RequirementState>;
    dispatches: DispatchState[];
    bookings: BookingState[];
  };

  // Mutex simulation for row-level locking (SELECT ... FOR UPDATE)
  const requirementLocks = new Map<string, Promise<void>>();

  const acquireRowLock = async (reqId: string): Promise<() => void> => {
    while (requirementLocks.has(reqId)) {
      await requirementLocks.get(reqId);
    }
    let release!: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      release = () => {
        requirementLocks.delete(reqId);
        resolve();
      };
    });
    requirementLocks.set(reqId, lockPromise);
    return release;
  };

  beforeAll(() => {
    workerAToken = generateToken({ id: WORKER_A_ID, phone: "+919876543211", role: UserRole.WORKER });
    customerToken = generateToken({ id: CUSTOMER_ID, phone: "+919876543213", role: UserRole.CUSTOMER });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    requirementLocks.clear();

    db = {
      requirements: new Map([
        [
          REQ_ID,
          {
            id: REQ_ID,
            job_id: JOB_ID,
            skill_type: "Plumber",
            worker_count_needed: 1,
            worker_count_filled: 0,
            status: "dispatching",
            job: { id: JOB_ID, customer_id: CUSTOMER_ID, dispatch_status: "dispatching" },
          },
        ],
      ]),
      dispatches: [
        {
          id: "disp-worker-a",
          requirement_id: REQ_ID,
          worker_id: WORKER_A_ID,
          status: "pending",
          expires_at: new Date(Date.now() + 60_000),
        },
      ],
      bookings: [],
    };

    // Setup transaction mock with row lock simulation and DB unique constraint enforcement
    (prisma.$transaction as jest.Mock).mockImplementation(async (callback: any) => {
      let snapshotDispatches: any = null;
      let snapshotBookings: any = null;
      let snapshotRequirements: any = null;
      let releaseLock: (() => void) | null = null;

      const takeSnapshot = () => {
        snapshotDispatches = db.dispatches.map((d) => ({
          ...d,
          expires_at: d.expires_at ? new Date(d.expires_at) : null,
          responded_at: d.responded_at ? new Date(d.responded_at) : null,
        }));
        snapshotBookings = JSON.parse(JSON.stringify(db.bookings));
        snapshotRequirements = new Map(
          Array.from(db.requirements.entries()).map(([k, v]) => [k, { ...v, job: { ...v.job } }])
        );
      };

      const txMock: any = {
        $queryRaw: jest.fn().mockImplementation(async (strings: TemplateStringsArray, ...values: any[]) => {
          const query = strings.join("?");
          if (query.includes("FOR UPDATE")) {
            const reqId = values[0];
            releaseLock = await acquireRowLock(reqId);
            takeSnapshot();
          }
          return [];
        }),

        job_requirement: {
          findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
            const r = db.requirements.get(where.id);
            return r ? JSON.parse(JSON.stringify(r)) : null;
          }),
          update: jest.fn().mockImplementation(async ({ where, data }: any) => {
            const r = db.requirements.get(where.id);
            if (r) {
              if (data.worker_count_filled !== undefined) r.worker_count_filled = data.worker_count_filled;
              if (data.status !== undefined) r.status = data.status;
            }
            return r;
          }),
          count: jest.fn().mockImplementation(async ({ where }: any) => {
            let count = 0;
            for (const r of db.requirements.values()) {
              if (r.job_id === where.job_id && r.status !== where.status?.not) {
                count++;
              }
            }
            return count;
          }),
        },

        booking: {
          findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
            return (
              db.bookings.find(
                (b) => b.requirement_id === where.requirement_id && b.worker_id === where.worker_id
              ) || null
            );
          }),
          create: jest.fn().mockImplementation(async ({ data }: any) => {
            // DATABASE-LEVEL UNIQUE CONSTRAINT ENFORCEMENT
            // Matches: @@unique([requirement_id, worker_id], map: "uniq_booking_requirement_worker")
            const isDuplicate = db.bookings.some(
              (b) => b.requirement_id === data.requirement_id && b.worker_id === data.worker_id
            );
            if (isDuplicate) {
              const p2002Err: any = new Error(
                "Unique constraint failed on the fields: (`requirement_id`,`worker_id`)"
              );
              p2002Err.code = "P2002";
              p2002Err.meta = { target: ["requirement_id", "worker_id"] };
              throw p2002Err;
            }

            const newBooking: BookingState = {
              id: "booking-" + Math.random().toString(36).substring(2, 9),
              job_id: data.job_id,
              requirement_id: data.requirement_id,
              worker_id: data.worker_id,
              customer_id: data.customer_id,
              status: data.status,
              otp_hash: data.otp_hash,
            };
            db.bookings.push(newBooking);
            return {
              id: newBooking.id,
              job_id: newBooking.job_id,
              requirement_id: newBooking.requirement_id,
              worker_id: newBooking.worker_id,
              customer_id: newBooking.customer_id,
              status: newBooking.status,
              start_time: null,
              end_time: null,
              created_at: new Date(),
              updated_at: new Date(),
            };
          }),
        },

        job_dispatch: {
          findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
            const match = db.dispatches.find(
              (d) => d.requirement_id === where.requirement_id && d.worker_id === where.worker_id
            );
            return match || null;
          }),
          findMany: jest.fn().mockImplementation(async ({ where }: any) => {
            return db.dispatches.filter((d) => {
              if (where.requirement_id && d.requirement_id !== where.requirement_id) return false;
              if (where.status && d.status !== where.status) return false;
              return true;
            });
          }),
          updateMany: jest.fn().mockImplementation(async ({ where, data }: any) => {
            let count = 0;
            const now = new Date();
            for (const d of db.dispatches) {
              if (where.requirement_id && d.requirement_id !== where.requirement_id) continue;
              if (where.worker_id && d.worker_id !== where.worker_id) continue;
              if (where.status && d.status !== where.status) continue;
              if (where.expires_at?.gt) {
                const dTime = d.expires_at ? new Date(d.expires_at).getTime() : 0;
                const gtTime = new Date(where.expires_at.gt).getTime();
                if (dTime <= gtTime) continue;
              }

              d.status = data.status;
              d.responded_at = data.responded_at || now;
              count++;
            }
            return { count };
          }),
        },

        job: {
          update: jest.fn().mockImplementation(async ({ where, data }: any) => {
            for (const r of db.requirements.values()) {
              if (r.job_id === where.id) {
                r.job.dispatch_status = data.dispatch_status;
              }
            }
            return {};
          }),
        },
      };

      try {
        if (!snapshotDispatches) {
          takeSnapshot();
        }
        const result = await callback(txMock);
        return result;
      } catch (err) {
        if (snapshotDispatches) {
          db.dispatches = snapshotDispatches;
          db.bookings = snapshotBookings;
          db.requirements = snapshotRequirements;
        }
        throw err;
      } finally {
        if (typeof releaseLock === "function") {
          (releaseLock as () => void)();
        }
      }
    });
  });

  // ── Scenario A: Same worker, same requirement (50 concurrent attempts) ──────
  describe("Scenario A: High Concurrency — 50 Simultaneous Requests From Same Worker", () => {
    it("MUST produce exactly 1 successful booking and exactly 1 database booking across 50 concurrent requests", async () => {
      const attempts = 50;
      const requests = Array.from({ length: attempts }, () =>
        request(app)
          .post(`/api/dispatch/${REQ_ID}/accept`)
          .set("Authorization", `Bearer ${workerAToken}`)
          .send()
      );

      const results = await Promise.all(requests);

      const successes = results.filter((r) => r.status === 200);
      const conflicts = results.filter((r) => r.status === 409);

      expect(successes.length).toBe(1);
      expect(conflicts.length).toBe(attempts - 1);
      expect(db.bookings.length).toBe(1);
      expect(db.bookings[0].worker_id).toBe(WORKER_A_ID);
      expect(db.bookings[0].requirement_id).toBe(REQ_ID);
      expect(db.requirements.get(REQ_ID)?.worker_count_filled).toBe(1);

      // Verify no internal Prisma error leaked to client
      conflicts.forEach((res) => {
        expect(res.body.message).not.toMatch(/P2002|Unique constraint failed/i);
        expect(res.body.code).toMatch(/SLOTS_FULL|BOOKING_ALREADY_EXISTS|DISPATCH_ALREADY_ACCEPTED/);
      });
    });
  });

  // ── Scenario B: Sequential Retry Behavior ──────────────────────────────────
  describe("Scenario B: Sequential Retry After Successful Booking", () => {
    it("MUST reject consecutive retries with 409 and never create a duplicate booking", async () => {
      // First attempt
      const res1 = await request(app)
        .post(`/api/dispatch/${REQ_ID}/accept`)
        .set("Authorization", `Bearer ${workerAToken}`)
        .send();

      expect(res1.status).toBe(200);
      expect(db.bookings.length).toBe(1);

      // Retry 1
      const res2 = await request(app)
        .post(`/api/dispatch/${REQ_ID}/accept`)
        .set("Authorization", `Bearer ${workerAToken}`)
        .send();

      expect(res2.status).toBe(409);
      expect(res2.body.code).toMatch(/SLOTS_FULL|BOOKING_ALREADY_EXISTS|DISPATCH_ALREADY_ACCEPTED/);
      expect(db.bookings.length).toBe(1);

      // Retry 2
      const res3 = await request(app)
        .post(`/api/dispatch/${REQ_ID}/accept`)
        .set("Authorization", `Bearer ${workerAToken}`)
        .send();

      expect(res3.status).toBe(409);
      expect(db.bookings.length).toBe(1);
    });
  });

  // ── Scenario C: Competing Workers Exceeding Capacity ───────────────────────
  describe("Scenario C: 20 Competing Workers for a 2-Slot Requirement", () => {
    it("MUST allow at most 2 successful bookings and reject all remaining competing workers with 409", async () => {
      const SLOTS_NEEDED = 2;
      const TOTAL_WORKERS = 20;

      // Update requirement to need 2 workers
      const req = db.requirements.get(REQ_ID)!;
      req.worker_count_needed = SLOTS_NEEDED;
      req.worker_count_filled = 0;
      req.status = "dispatching";

      // Register 20 workers and their corresponding valid dispatches
      const workerTokens: { id: string; token: string }[] = [];
      db.dispatches = [];

      for (let i = 1; i <= TOTAL_WORKERS; i++) {
        const wId = `10000000-0000-4000-a000-${String(i).padStart(12, "0")}`;
        const token = generateToken({ id: wId, phone: `+9198000000${String(i).padStart(2, "0")}`, role: UserRole.WORKER });
        workerTokens.push({ id: wId, token });

        db.dispatches.push({
          id: `disp-worker-${i}`,
          requirement_id: REQ_ID,
          worker_id: wId,
          status: "pending",
          expires_at: new Date(Date.now() + 60_000),
        });
      }

      // Launch all 20 workers simultaneously
      const requests = workerTokens.map(({ token }) =>
        request(app)
          .post(`/api/dispatch/${REQ_ID}/accept`)
          .set("Authorization", `Bearer ${token}`)
          .send()
      );

      const responses = await Promise.all(requests);

      const successes = responses.filter((r) => r.status === 200);
      const rejected = responses.filter((r) => r.status === 409);

      expect(successes.length).toBe(SLOTS_NEEDED);
      expect(rejected.length).toBe(TOTAL_WORKERS - SLOTS_NEEDED);
      expect(db.bookings.length).toBe(SLOTS_NEEDED);
      expect(db.requirements.get(REQ_ID)?.worker_count_filled).toBe(SLOTS_NEEDED);
      expect(db.requirements.get(REQ_ID)?.status?.toUpperCase()).toBe("FILLED");

      // Verify each booked worker has unique worker_id
      const bookedWorkerIds = new Set(db.bookings.map((b) => b.worker_id));
      expect(bookedWorkerIds.size).toBe(SLOTS_NEEDED);
    });
  });

  // ── Scenario D: Same Dispatch Row Concurrency ──────────────────────────────
  describe("Scenario D: Same Dispatch Row Concurrent Acceptance", () => {
    it("MUST allow exactly one request to transition the dispatch row out of pending", async () => {
      const requests = Array.from({ length: 20 }, () =>
        request(app)
          .post(`/api/dispatch/${REQ_ID}/accept`)
          .set("Authorization", `Bearer ${workerAToken}`)
          .send()
      );

      const responses = await Promise.all(requests);
      const successes = responses.filter((r) => r.status === 200);

      expect(successes.length).toBe(1);
      const dispatch = db.dispatches.find((d) => d.worker_id === WORKER_A_ID);
      expect(dispatch?.status).toBe("accepted");
      expect(db.bookings.length).toBe(1);
    });
  });

  // ── Scenario E: Expired Dispatch Concurrency ───────────────────────────────
  describe("Scenario E: Expired Dispatch Concurrent Acceptance", () => {
    it("MUST reject all 20 concurrent requests with 410 when dispatch is expired and create 0 bookings", async () => {
      db.dispatches[0].expires_at = new Date(Date.now() - 10_000); // expired 10s ago

      const requests = Array.from({ length: 20 }, () =>
        request(app)
          .post(`/api/dispatch/${REQ_ID}/accept`)
          .set("Authorization", `Bearer ${workerAToken}`)
          .send()
      );

      const responses = await Promise.all(requests);

      const expiredResponses = responses.filter((r) => r.status === 410);
      expect(expiredResponses.length).toBe(20);
      expect(db.bookings.length).toBe(0);
      expect(db.requirements.get(REQ_ID)?.worker_count_filled).toBe(0);
    });
  });

  // ── Scenario F: Already Accepted Dispatch Concurrency ──────────────────────
  describe("Scenario F: Already Accepted Dispatch Concurrency", () => {
    it("MUST reject all 20 concurrent requests when dispatch is already accepted and create no new bookings", async () => {
      // First accept
      const firstRes = await request(app)
        .post(`/api/dispatch/${REQ_ID}/accept`)
        .set("Authorization", `Bearer ${workerAToken}`)
        .send();

      expect(firstRes.status).toBe(200);
      expect(db.bookings.length).toBe(1);

      // 20 concurrent requests after acceptance
      const requests = Array.from({ length: 20 }, () =>
        request(app)
          .post(`/api/dispatch/${REQ_ID}/accept`)
          .set("Authorization", `Bearer ${workerAToken}`)
          .send()
      );

      const responses = await Promise.all(requests);
      responses.forEach((res) => {
        expect(res.status).toBe(409);
      });
      expect(db.bookings.length).toBe(1);
    });
  });

  // ── Scenario G: Database-Level Unique Constraint P2002 Race Handling ───────
  describe("Scenario G: Database-Level Unique Constraint (P2002) Direct Enforcement", () => {
    it("MUST catch Prisma P2002 unique constraint violation, roll back, and return safe 409 without leaking database internals", async () => {
      // Inject existing booking directly into database to simulate race where application pre-check is bypassed
      db.bookings.push({
        id: "booking-pre-existing",
        job_id: JOB_ID,
        requirement_id: REQ_ID,
        worker_id: WORKER_A_ID,
        customer_id: CUSTOMER_ID,
        status: "confirmed",
        otp_hash: "hash",
      });

      const res = await request(app)
        .post(`/api/dispatch/${REQ_ID}/accept`)
        .set("Authorization", `Bearer ${workerAToken}`)
        .send();

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("BOOKING_ALREADY_EXISTS");
      expect(res.body.message).toMatch(/Worker already has an active booking for this requirement/i);
      // Guarantee raw database error is NOT leaked
      expect(res.body.message).not.toMatch(/P2002|Unique constraint|SQL/i);

      // Verify no second booking was created
      expect(db.bookings.length).toBe(1);
    });
  });

  // ── Scenario H: Transaction Rollback on Booking Creation Failure ───────────
  describe("Scenario H: Complete Transaction Rollback on Booking Failure", () => {
    it("MUST roll back dispatch mutation and leave dispatch pending if booking creation fails", async () => {
      (prisma.$transaction as jest.Mock).mockImplementationOnce(async (callback: any) => {
        const snapshotDispatches = JSON.parse(JSON.stringify(db.dispatches));
        const snapshotBookings = JSON.parse(JSON.stringify(db.bookings));

        const txMock: any = {
          $queryRaw: jest.fn().mockResolvedValue([]),
          job_requirement: {
            findUnique: jest.fn().mockResolvedValue(db.requirements.get(REQ_ID)),
            update: jest.fn(),
            count: jest.fn().mockResolvedValue(0),
          },
          booking: {
            findFirst: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockRejectedValue(new Error("Connection reset by peer")),
          },
          job_dispatch: {
            findFirst: jest.fn(),
            findMany: jest.fn().mockResolvedValue([]),
            updateMany: jest.fn().mockImplementation(async () => {
              db.dispatches[0].status = "accepted";
              return { count: 1 };
            }),
          },
          job: {
            update: jest.fn(),
          },
        };

        try {
          return await callback(txMock);
        } catch (err) {
          db.dispatches = snapshotDispatches;
          db.bookings = snapshotBookings;
          throw err;
        }
      });

      const res = await request(app)
        .post(`/api/dispatch/${REQ_ID}/accept`)
        .set("Authorization", `Bearer ${workerAToken}`)
        .send();

      expect(res.status).toBe(500);
      expect(db.dispatches[0].status).toBe("pending");
      expect(db.bookings.length).toBe(0);
      expect(db.requirements.get(REQ_ID)?.worker_count_filled).toBe(0);
    });
  });

  // ── Scenario I: RBAC & Client Identity Protection ──────────────────────────
  describe("Scenario I: RBAC & Identity Protection", () => {
    it("Customer role attempt must be rejected with 403 Forbidden without database mutations", async () => {
      const res = await request(app)
        .post(`/api/dispatch/${REQ_ID}/accept`)
        .set("Authorization", `Bearer ${customerToken}`)
        .send();

      expect(res.status).toBe(403);
      expect(db.bookings.length).toBe(0);
      expect(db.dispatches[0].status).toBe("pending");
    });

    it("Worker attempting to supply worker_id in body must be rejected with 400 Bad Request", async () => {
      const res = await request(app)
        .post(`/api/dispatch/${REQ_ID}/accept`)
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({ worker_id: "22222222-2222-4222-a222-222222222222" });

      expect(res.status).toBe(400);
      expect(db.bookings.length).toBe(0);
    });
  });
});
