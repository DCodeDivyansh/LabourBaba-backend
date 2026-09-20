import request from "supertest";
import { app } from "../src/server";
import prisma from "../src/config/prisma";
import { generateToken } from "../src/utils/authUtils";
import { UserRole } from "../src/middlewares/authMiddleware";

// Mock dependencies
jest.mock("../src/config/prisma", () => ({
  __esModule: true,
  default: {
    $queryRaw: jest.fn().mockResolvedValue([
      { latitude: 26.85, longitude: 80.95 },
    ]),
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

describe("P0 Finding #9 Security Regression Suite: Dispatch Acceptance Invariants", () => {
  const WORKER_A_ID = "11111111-1111-4111-a111-111111111111";
  const WORKER_B_ID = "22222222-2222-4222-a222-222222222222";
  const CUSTOMER_ID = "33333333-3333-4333-a333-333333333333";
  const JOB_ID = "55555555-5555-4555-a555-555555555555";
  const REQ_ID = "77777777-7777-4777-a777-777777777777";

  let workerAToken: string;
  let workerBToken: string;
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
    workerBToken = generateToken({ id: WORKER_B_ID, phone: "+919876543212", role: UserRole.WORKER });
    customerToken = generateToken({ id: CUSTOMER_ID, phone: "+919876543213", role: UserRole.CUSTOMER });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    requirementLocks.clear();

    // Default pristine state
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
          expires_at: new Date(Date.now() + 60_000), // 60s in future
        },
      ],
      bookings: [],
    };

    // Setup transaction mock with row lock simulation and rollback capability
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
        // Rollback state on error
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

  // ── Test 1: Unauthenticated request ──────────────────────────────────────────
  describe("Test 1: Unauthenticated Acceptance", () => {
    it("POST /api/dispatch/:requirementId/accept without token must return 401 and not create a booking", async () => {
      const res = await request(app).post(`/api/dispatch/${REQ_ID}/accept`).send();

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(db.bookings.length).toBe(0);
      expect(db.dispatches[0].status).toBe("pending");
    });
  });

  // ── Test 2: Customer cannot accept ──────────────────────────────────────────
  describe("Test 2: Customer Role Acceptance Attempt", () => {
    it("Customer attempting to accept dispatch must return 403 Forbidden with no database mutations", async () => {
      const res = await request(app)
        .post(`/api/dispatch/${REQ_ID}/accept`)
        .set("Authorization", `Bearer ${customerToken}`)
        .send();

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/Forbidden|insufficient permissions|Worker role required/i);
      expect(db.bookings.length).toBe(0);
      expect(db.dispatches[0].status).toBe("pending");
      expect(db.requirements.get(REQ_ID)?.worker_count_filled).toBe(0);
    });
  });

  // ── Test 3: Another worker's dispatch ───────────────────────────────────────
  describe("Test 3: Another Worker's Dispatch", () => {
    it("Worker A attempting to accept Requirement with dispatch assigned solely to Worker B must fail with 404", async () => {
      // Reassign dispatch to Worker B
      db.dispatches = [
        {
          id: "disp-worker-b",
          requirement_id: REQ_ID,
          worker_id: WORKER_B_ID,
          status: "pending",
          expires_at: new Date(Date.now() + 60_000),
        },
      ];

      const res = await request(app)
        .post(`/api/dispatch/${REQ_ID}/accept`)
        .set("Authorization", `Bearer ${workerAToken}`)
        .send();

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("NO_VALID_DISPATCH");

      // Verify Worker B's dispatch remains pending and Worker A gets no booking
      expect(db.dispatches[0].status).toBe("pending");
      expect(db.bookings.length).toBe(0);
      expect(db.requirements.get(REQ_ID)?.worker_count_filled).toBe(0);
    });
  });

  // ── Test 4: Valid own dispatch ─────────────────────────────────────────────
  describe("Test 4: Valid Own Dispatch Acceptance", () => {
    it("Worker A accepting their own valid pending dispatch must succeed with 200, update status to accepted, and create booking with hashed OTP", async () => {
      const res = await request(app)
        .post(`/api/dispatch/${REQ_ID}/accept`)
        .set("Authorization", `Bearer ${workerAToken}`)
        .send();

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.booking).toBeDefined();
      expect(res.body.data.booking.worker_id).toBe(WORKER_A_ID);
      expect(res.body.data.booking.status?.toUpperCase()).toBe("CONFIRMED");
      expect(res.body.data.otp).toBeDefined();

      // Verify database state mutations
      const dispatch = db.dispatches.find((d) => d.worker_id === WORKER_A_ID);
      expect(dispatch?.status).toBe("accepted");
      expect(db.bookings.length).toBe(1);
      expect(db.bookings[0].worker_id).toBe(WORKER_A_ID);
      expect(db.bookings[0].otp_hash).toBeDefined();
      expect(db.requirements.get(REQ_ID)?.worker_count_filled).toBe(1);
      expect(db.requirements.get(REQ_ID)?.status?.toUpperCase()).toBe("FILLED");
    });
  });

  // ── Test 5: Requirement ID alone without dispatch row ──────────────────────
  describe("Test 5: Requirement ID Alone (Finding #9 Core Regression)", () => {
    it("Worker A knowing valid requirementId but having no dispatch row must be rejected with 404 NO_VALID_DISPATCH", async () => {
      // Clear dispatches entirely
      db.dispatches = [];

      const res = await request(app)
        .post(`/api/dispatch/${REQ_ID}/accept`)
        .set("Authorization", `Bearer ${workerAToken}`)
        .send();

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("NO_VALID_DISPATCH");
      expect(db.bookings.length).toBe(0);
      expect(db.requirements.get(REQ_ID)?.worker_count_filled).toBe(0);
    });
  });

  // ── Test 6: Expired dispatch ───────────────────────────────────────────────
  describe("Test 6: Expired Dispatch Rejection", () => {
    it("Worker A with an expired dispatch (expires_at < now) must be rejected with 410 DISPATCH_EXPIRED", async () => {
      db.dispatches = [
        {
          id: "disp-worker-a-expired",
          requirement_id: REQ_ID,
          worker_id: WORKER_A_ID,
          status: "pending",
          expires_at: new Date(Date.now() - 5_000), // expired 5 seconds ago
        },
      ];

      const res = await request(app)
        .post(`/api/dispatch/${REQ_ID}/accept`)
        .set("Authorization", `Bearer ${workerAToken}`)
        .send();

      expect(res.status).toBe(410);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("DISPATCH_EXPIRED");
      expect(db.bookings.length).toBe(0);
      expect(db.dispatches[0].status).toBe("pending"); // Not modified by acceptance
    });
  });

  // ── Test 7: Already accepted ───────────────────────────────────────────────
  describe("Test 7: Double Acceptance / Replay Protection", () => {
    it("Accepting an already accepted dispatch must be rejected with 409 DISPATCH_ALREADY_ACCEPTED and yield exactly one booking", async () => {
      // First acceptance
      const firstRes = await request(app)
        .post(`/api/dispatch/${REQ_ID}/accept`)
        .set("Authorization", `Bearer ${workerAToken}`)
        .send();

      expect(firstRes.status).toBe(200);
      expect(db.bookings.length).toBe(1);

      // Second acceptance attempt
      const secondRes = await request(app)
        .post(`/api/dispatch/${REQ_ID}/accept`)
        .set("Authorization", `Bearer ${workerAToken}`)
        .send();

      expect(secondRes.status).toBe(409);
      expect(secondRes.body.success).toBe(false);
      expect(secondRes.body.code).toMatch(/SLOTS_FULL|BOOKING_ALREADY_EXISTS|DISPATCH_ALREADY_ACCEPTED/);
      expect(db.bookings.length).toBe(1);
    });
  });

  // ── Test 8: Terminal states rejection ──────────────────────────────────────
  describe("Test 8: Terminal State Dispatches Cannot Be Accepted", () => {
    const terminalStates = ["timeout", "declined", "expired"];

    terminalStates.forEach((state) => {
      it(`Dispatch in terminal status '${state}' must be rejected with 409 DISPATCH_NOT_ACTIONABLE`, async () => {
        db.dispatches = [
          {
            id: `disp-worker-a-${state}`,
            requirement_id: REQ_ID,
            worker_id: WORKER_A_ID,
            status: state,
            expires_at: new Date(Date.now() + 60_000),
          },
        ];

        const res = await request(app)
          .post(`/api/dispatch/${REQ_ID}/accept`)
          .set("Authorization", `Bearer ${workerAToken}`)
          .send();

        expect(res.status).toBe(409);
        expect(res.body.success).toBe(false);
        expect(res.body.code).toBe("DISPATCH_NOT_ACTIONABLE");
        expect(db.bookings.length).toBe(0);
        expect(db.dispatches[0].status).toBe(state);
      });
    });
  });

  // ── Test 9: Booking transaction rollback ───────────────────────────────────
  describe("Test 9: Transaction Rollback on Booking Failure", () => {
    it("If booking creation fails inside transaction, dispatch status must remain pending and no booking committed", async () => {
      // Configure booking create mock to throw an unexpected database error
      const originalTx = prisma.$transaction;
      (prisma.$transaction as jest.Mock).mockImplementationOnce(async (callback: any) => {
        const snapshotDispatches = JSON.parse(JSON.stringify(db.dispatches));
        const snapshotBookings = JSON.parse(JSON.stringify(db.bookings));
        const snapshotRequirements = new Map(
          Array.from(db.requirements.entries()).map(([k, v]) => [k, { ...v, job: { ...v.job } }])
        );

        const txMock: any = {
          $queryRaw: jest.fn().mockResolvedValue([]),
          job_requirement: {
            findUnique: jest.fn().mockResolvedValue(db.requirements.get(REQ_ID)),
            update: jest.fn(),
            count: jest.fn().mockResolvedValue(0),
          },
          booking: {
            findFirst: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockRejectedValue(new Error("Database connection dropped during booking.create")),
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
          db.requirements = snapshotRequirements;
          throw err;
        }
      });

      const res = await request(app)
        .post(`/api/dispatch/${REQ_ID}/accept`)
        .set("Authorization", `Bearer ${workerAToken}`)
        .send();

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);

      // Verify transaction rollback: dispatch must remain 'pending', bookings empty
      expect(db.dispatches[0].status).toBe("pending");
      expect(db.bookings.length).toBe(0);
      expect(db.requirements.get(REQ_ID)?.worker_count_filled).toBe(0);
    });
  });

  // ── Test 10: Client identity spoofing rejection ────────────────────────────
  describe("Test 10: Client Identity Spoofing Rejection", () => {
    it("Worker A attempting to supply worker_id or workerId in request body must be rejected with 400", async () => {
      const res = await request(app)
        .post(`/api/dispatch/${REQ_ID}/accept`)
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({ worker_id: WORKER_B_ID });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/Client-controlled worker identity is not permitted/i);
      expect(db.bookings.length).toBe(0);
    });

    it("Worker A attempting to supply worker_id in query string must be rejected with 400", async () => {
      const res = await request(app)
        .post(`/api/dispatch/${REQ_ID}/accept?worker_id=${WORKER_B_ID}`)
        .set("Authorization", `Bearer ${workerAToken}`)
        .send();

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/Client-controlled worker identity is not permitted/i);
      expect(db.bookings.length).toBe(0);
    });

    it("POST /api/dispatch/:requirementId/decline must also reject client-supplied worker identity with 400", async () => {
      const res = await request(app)
        .post(`/api/dispatch/${REQ_ID}/decline`)
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({ workerId: WORKER_B_ID });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/Client-controlled worker identity is not permitted/i);
    });
  });

  // ── Test 11: Same-worker concurrency ───────────────────────────────────────
  describe("Test 11: Same-Worker Concurrent Acceptance", () => {
    it("Multiple concurrent acceptance requests from Worker A must result in exactly 1 success and exactly 1 booking", async () => {
      const concurrentRequests = Array.from({ length: 10 }).map(() =>
        request(app)
          .post(`/api/dispatch/${REQ_ID}/accept`)
          .set("Authorization", `Bearer ${workerAToken}`)
          .send()
      );

      const responses = await Promise.all(concurrentRequests);

      const successful = responses.filter((r) => r.status === 200);
      const rejected = responses.filter((r) => r.status === 409);

      expect(successful.length).toBe(1);
      expect(rejected.length).toBe(9);
      expect(db.bookings.length).toBe(1);
      expect(db.bookings[0].worker_id).toBe(WORKER_A_ID);
      expect(db.requirements.get(REQ_ID)?.worker_count_filled).toBe(1);
    });
  });

  // ── Test 12: Multiple workers competing for final slot ─────────────────────
  describe("Test 12: Multiple Workers Competing for Final Slot", () => {
    it("When 1 slot is available, concurrent acceptance from Worker A and Worker B must serialize: exactly 1 wins, 1 rejected, 1 booking created", async () => {
      // Register valid pending dispatches for BOTH Worker A and Worker B
      db.dispatches = [
        {
          id: "disp-a",
          requirement_id: REQ_ID,
          worker_id: WORKER_A_ID,
          status: "pending",
          expires_at: new Date(Date.now() + 60_000),
        },
        {
          id: "disp-b",
          requirement_id: REQ_ID,
          worker_id: WORKER_B_ID,
          status: "pending",
          expires_at: new Date(Date.now() + 60_000),
        },
      ];

      const reqA = request(app)
        .post(`/api/dispatch/${REQ_ID}/accept`)
        .set("Authorization", `Bearer ${workerAToken}`)
        .send();

      const reqB = request(app)
        .post(`/api/dispatch/${REQ_ID}/accept`)
        .set("Authorization", `Bearer ${workerBToken}`)
        .send();

      const [resA, resB] = await Promise.all([reqA, reqB]);

      const statuses = [resA.status, resB.status];
      expect(statuses).toContain(200);
      expect(statuses).toContain(409);

      // Verify exactly one booking exists in DB
      expect(db.bookings.length).toBe(1);
      // Verify worker_count_filled equals worker_count_needed (1)
      expect(db.requirements.get(REQ_ID)?.worker_count_filled).toBe(1);
      expect(db.requirements.get(REQ_ID)?.status?.toUpperCase()).toBe("FILLED");
    });
  });

  // ── Test 13: Filled requirement rejection ──────────────────────────────────
  describe("Test 13: Filled Requirement Rejection", () => {
    it("Acceptance attempt on a requirement with status='filled' or filled >= needed must be rejected with 409 SLOTS_FULL", async () => {
      const reqState = db.requirements.get(REQ_ID)!;
      reqState.status = "filled";
      reqState.worker_count_filled = 1;

      const res = await request(app)
        .post(`/api/dispatch/${REQ_ID}/accept`)
        .set("Authorization", `Bearer ${workerAToken}`)
        .send();

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("SLOTS_FULL");
      expect(db.bookings.length).toBe(0);
      expect(db.dispatches[0].status).toBe("pending");
    });
  });
});