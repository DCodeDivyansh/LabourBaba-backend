import request from "supertest";
import { Prisma } from "@prisma/client";

// Mock Bull Board & BullMQ
jest.mock("@bull-board/api", () => ({ createBullBoard: jest.fn().mockReturnValue({}) }));
jest.mock("@bull-board/api/bullMQAdapter", () => ({ BullMQAdapter: jest.fn().mockImplementation(() => ({})) }));
jest.mock("@bull-board/express", () => ({
  ExpressAdapter: jest.fn().mockImplementation(() => ({
    setBasePath: jest.fn(),
    getRouter: jest.fn().mockReturnValue((req: any, res: any, next: any) => next()),
  })),
}));

jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({ add: jest.fn().mockResolvedValue({}) })),
  Worker: jest.fn().mockImplementation(() => ({ on: jest.fn(), close: jest.fn() })),
}));

jest.mock("../src/config/bullmq", () => ({
  dispatchQueue: { add: jest.fn() },
  timeoutQueue: { add: jest.fn() },
  connection: {},
}));

jest.mock("../src/config/prisma", () => ({
  __esModule: true,
  default: {
    booking: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    job: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    job_requirement: {
      findUnique: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    review: {
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    booking_transition: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
    job_transition: {
      create: jest.fn(),
    },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  },
}));

import { app } from "../src/server";
import prisma from "../src/config/prisma";
import { generateToken } from "../src/utils/authUtils";
import { UserRole } from "../src/type/userRole";
import {
  BookingStatus,
  BookingAction,
  bookingStateService,
  BookingStateError,
  BookingInvalidTransitionError,
  BookingAuthorizationError,
  BookingStateConflictError,
  BookingNotFoundError,
  TERMINAL_BOOKING_STATES,
  BOOKING_TRANSITION_TABLE,
} from "../src/features/booking/bookingStateMachine";
import { bookingService } from "../src/features/booking/bookingServices";

describe("Issue #16 — Booking State Machine Remediation", () => {
  const CUSTOMER_A_ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const CUSTOMER_B_ID = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
  const WORKER_A_ID = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
  const WORKER_B_ID = "dddddddd-dddd-4ddd-dddd-dddddddddddd";
  const ADMIN_ID = "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee";

  const BOOKING_ID = "11111111-1111-4111-a111-111111111111";
  const JOB_ID = "22222222-2222-4222-a222-222222222222";
  const REQUIREMENT_ID = "33333333-3333-4333-a333-333333333333";

  let customerAToken: string;
  let customerBToken: string;
  let workerAToken: string;
  let workerBToken: string;
  let adminToken: string;

  beforeAll(() => {
    customerAToken = generateToken({ id: CUSTOMER_A_ID, phone: "+919876543210", role: UserRole.CUSTOMER });
    customerBToken = generateToken({ id: CUSTOMER_B_ID, phone: "+919876543211", role: UserRole.CUSTOMER });
    workerAToken = generateToken({ id: WORKER_A_ID, phone: "+919999999991", role: UserRole.WORKER });
    workerBToken = generateToken({ id: WORKER_B_ID, phone: "+919999999992", role: UserRole.WORKER });
    adminToken = generateToken({ id: ADMIN_ID, phone: "+918888888888", role: UserRole.ADMIN });
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ===========================================================================
  // 1. CANONICAL STATES & TERMINAL IDENTIFICATION
  // ===========================================================================
  describe("1. Canonical States & Terminal Identification", () => {
    it("MUST recognize all 5 canonical booking states", () => {
      expect(BookingStatus.CONFIRMED).toBe("CONFIRMED");
      expect(BookingStatus.IN_PROGRESS).toBe("IN_PROGRESS");
      expect(BookingStatus.AWAITING_CONFIRMATION).toBe("AWAITING_CONFIRMATION");
      expect(BookingStatus.COMPLETED).toBe("COMPLETED");
      expect(BookingStatus.CANCELLED).toBe("CANCELLED");
    });

    it("MUST correctly identify terminal states (COMPLETED, CANCELLED)", () => {
      expect(bookingStateService.isTerminal(BookingStatus.COMPLETED)).toBe(true);
      expect(bookingStateService.isTerminal(BookingStatus.CANCELLED)).toBe(true);
      expect(bookingStateService.isTerminal(BookingStatus.CONFIRMED)).toBe(false);
      expect(bookingStateService.isTerminal(BookingStatus.IN_PROGRESS)).toBe(false);
      expect(bookingStateService.isTerminal(BookingStatus.AWAITING_CONFIRMATION)).toBe(false);
    });

    it("Terminal states MUST have zero outbound actions in transition matrix", () => {
      expect(Object.keys(BOOKING_TRANSITION_TABLE[BookingStatus.COMPLETED])).toHaveLength(0);
      expect(Object.keys(BOOKING_TRANSITION_TABLE[BookingStatus.CANCELLED])).toHaveLength(0);
    });

    it("Normalizes legacy and raw casing to canonical BookingStatus", () => {
      expect(bookingStateService.normalizeStatus("confirmed")).toBe(BookingStatus.CONFIRMED);
      expect(bookingStateService.normalizeStatus("CONFIRMED")).toBe(BookingStatus.CONFIRMED);
      expect(bookingStateService.normalizeStatus("in_progress")).toBe(BookingStatus.IN_PROGRESS);
      expect(bookingStateService.normalizeStatus("awaiting_confirmation")).toBe(BookingStatus.AWAITING_CONFIRMATION);
      expect(bookingStateService.normalizeStatus("completed")).toBe(BookingStatus.COMPLETED);
      expect(bookingStateService.normalizeStatus("cancelled")).toBe(BookingStatus.CANCELLED);
      expect(bookingStateService.normalizeStatus(null)).toBe(BookingStatus.CONFIRMED);
    });
  });

  // ===========================================================================
  // 2. LEGAL TRANSITIONS & LIFECYCLE METADATA PERSISTENCE
  // ===========================================================================
  describe("2. Legal Transition Execution", () => {
    function createMockTx(initialBooking: any) {
      let current = { ...initialBooking };
      return {
        booking: {
          findFirst: jest.fn().mockImplementation(() => Promise.resolve(current)),
          findUnique: jest.fn().mockImplementation(() => Promise.resolve(current)),
          update: jest.fn().mockImplementation(({ data }) => {
            current = { ...current, ...data };
            return Promise.resolve(current);
          }),
        },
        booking_transition: {
          create: jest.fn().mockImplementation(({ data }) =>
            Promise.resolve({ id: "trans-uuid-1", ...data })
          ),
        },
      };
    }

    it("CONFIRMED -> START_WORK by assigned Worker -> IN_PROGRESS with started_at", async () => {
      const mockTx = createMockTx({
        id: BOOKING_ID,
        status: BookingStatus.CONFIRMED,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
      });

      const res = await bookingStateService.transition(mockTx as any, {
        bookingId: BOOKING_ID,
        action: BookingAction.START_WORK,
        actor: { id: WORKER_A_ID, role: UserRole.WORKER },
      });

      expect(res.previousStatus).toBe(BookingStatus.CONFIRMED);
      expect(res.currentStatus).toBe(BookingStatus.IN_PROGRESS);
      expect(mockTx.booking.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: BookingStatus.IN_PROGRESS,
            started_at: expect.any(Date),
            otp_verified: true,
          }),
        })
      );
      expect(mockTx.booking_transition.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            from_status: BookingStatus.CONFIRMED,
            to_status: BookingStatus.IN_PROGRESS,
            action: BookingAction.START_WORK,
            actor_id: WORKER_A_ID,
          }),
        })
      );
    });

    it("IN_PROGRESS -> REQUEST_COMPLETION by assigned Worker -> AWAITING_CONFIRMATION with completion_requested_at", async () => {
      const mockTx = createMockTx({
        id: BOOKING_ID,
        status: BookingStatus.IN_PROGRESS,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
      });

      const res = await bookingStateService.transition(mockTx as any, {
        bookingId: BOOKING_ID,
        action: BookingAction.REQUEST_COMPLETION,
        actor: { id: WORKER_A_ID, role: UserRole.WORKER },
      });

      expect(res.previousStatus).toBe(BookingStatus.IN_PROGRESS);
      expect(res.currentStatus).toBe(BookingStatus.AWAITING_CONFIRMATION);
      expect(mockTx.booking.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: BookingStatus.AWAITING_CONFIRMATION,
            completion_requested_at: expect.any(Date),
          }),
        })
      );
    });

    it("AWAITING_CONFIRMATION -> CONFIRM_COMPLETION by owning Customer -> COMPLETED with completed_at and confirmed_by", async () => {
      const mockTx = createMockTx({
        id: BOOKING_ID,
        status: BookingStatus.AWAITING_CONFIRMATION,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
      });

      const res = await bookingStateService.transition(mockTx as any, {
        bookingId: BOOKING_ID,
        action: BookingAction.CONFIRM_COMPLETION,
        actor: { id: CUSTOMER_A_ID, role: UserRole.CUSTOMER },
      });

      expect(res.previousStatus).toBe(BookingStatus.AWAITING_CONFIRMATION);
      expect(res.currentStatus).toBe(BookingStatus.COMPLETED);
      expect(mockTx.booking.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: BookingStatus.COMPLETED,
            completed_at: expect.any(Date),
            confirmed_by: CUSTOMER_A_ID,
          }),
        })
      );
    });

    it("CONFIRMED -> CANCEL by Customer -> CANCELLED with cancelled_at, cancelled_by, cancellation_reason", async () => {
      const mockTx = createMockTx({
        id: BOOKING_ID,
        status: BookingStatus.CONFIRMED,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
      });

      const res = await bookingStateService.transition(mockTx as any, {
        bookingId: BOOKING_ID,
        action: BookingAction.CANCEL,
        actor: { id: CUSTOMER_A_ID, role: UserRole.CUSTOMER },
        reason: "Customer had to reschedule",
      });

      expect(res.previousStatus).toBe(BookingStatus.CONFIRMED);
      expect(res.currentStatus).toBe(BookingStatus.CANCELLED);
      expect(mockTx.booking.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: BookingStatus.CANCELLED,
            cancelled_at: expect.any(Date),
            cancelled_by: CUSTOMER_A_ID,
            cancellation_reason: "Customer had to reschedule",
          }),
        })
      );
    });
  });

  // ===========================================================================
  // 3. REGRESSION TEST: THE ORIGINAL DEFECT IS REMEDIATED
  // ===========================================================================
  describe("3. Regression Test: Worker Cannot Bypass Customer Confirmation", () => {
    it("REGRESSION TEST: Worker completeBooking() on IN_PROGRESS booking moves to AWAITING_CONFIRMATION, NOT COMPLETED", async () => {
      let bookingState = {
        id: BOOKING_ID,
        status: BookingStatus.IN_PROGRESS,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
      };

      const mockTx = {
        booking: {
          findFirst: jest.fn().mockImplementation(() => Promise.resolve(bookingState)),
          findUnique: jest.fn().mockImplementation(() => Promise.resolve(bookingState)),
          update: jest.fn().mockImplementation(({ data }) => {
            bookingState = { ...bookingState, ...data };
            return Promise.resolve(bookingState);
          }),
        },
        booking_transition: {
          create: jest.fn().mockResolvedValue({ id: "trans-1" }),
        },
      };

      (prisma.$transaction as jest.Mock).mockImplementationOnce((cb) => cb(mockTx));

      // Worker executes completeBooking
      const completeRes = await bookingService.completeBooking(BOOKING_ID, WORKER_A_ID, {
        id: WORKER_A_ID,
        role: UserRole.WORKER,
        phone: "+919999999991",
      });

      expect(completeRes.success).toBe(true);

      // PROOF: Booking status is strictly AWAITING_CONFIRMATION, NEVER COMPLETED
      expect(bookingState.status).not.toBe(BookingStatus.COMPLETED);
      expect(bookingState.status).toBe(BookingStatus.AWAITING_CONFIRMATION);

      // Subsequent Customer confirmation is required to produce COMPLETED
      (prisma.$transaction as jest.Mock).mockImplementationOnce((cb) => cb(mockTx));

      const confirmRes = await bookingService.confirmComplete(BOOKING_ID, CUSTOMER_A_ID, {}, {
        id: CUSTOMER_A_ID,
        role: UserRole.CUSTOMER,
        phone: "+919876543210",
      });

      expect(confirmRes.success).toBe(true);
      expect(bookingState.status).toBe(BookingStatus.COMPLETED);
    });
  });

  // ===========================================================================
  // 4. ILLEGAL TRANSITIONS REJECTION
  // ===========================================================================
  describe("4. Illegal Transition Rejection", () => {
    it("MUST reject direct IN_PROGRESS -> COMPLETED without customer confirmation", async () => {
      const mockTx = {
        booking: {
          findUnique: jest.fn().mockResolvedValue({
            id: BOOKING_ID,
            status: BookingStatus.IN_PROGRESS,
            customer_id: CUSTOMER_A_ID,
            worker_id: WORKER_A_ID,
          }),
        },
      };

      await expect(
        bookingStateService.transition(mockTx as any, {
          bookingId: BOOKING_ID,
          action: BookingAction.CONFIRM_COMPLETION,
          actor: { id: WORKER_A_ID, role: UserRole.WORKER },
        })
      ).rejects.toThrow(BookingStateError);
    });

    it("MUST reject CONFIRM_COMPLETION directly on a CONFIRMED booking", async () => {
      const mockTx = {
        booking: {
          findUnique: jest.fn().mockResolvedValue({
            id: BOOKING_ID,
            status: BookingStatus.CONFIRMED,
            customer_id: CUSTOMER_A_ID,
            worker_id: WORKER_A_ID,
          }),
        },
      };

      await expect(
        bookingStateService.transition(mockTx as any, {
          bookingId: BOOKING_ID,
          action: BookingAction.CONFIRM_COMPLETION,
          actor: { id: CUSTOMER_A_ID, role: UserRole.CUSTOMER },
        })
      ).rejects.toThrow(BookingInvalidTransitionError);
    });

    it("MUST reject CANCEL on a COMPLETED booking", async () => {
      const mockTx = {
        booking: {
          findUnique: jest.fn().mockResolvedValue({
            id: BOOKING_ID,
            status: BookingStatus.COMPLETED,
            customer_id: CUSTOMER_A_ID,
            worker_id: WORKER_A_ID,
          }),
        },
      };

      await expect(
        bookingStateService.transition(mockTx as any, {
          bookingId: BOOKING_ID,
          action: BookingAction.CANCEL,
          actor: { id: CUSTOMER_A_ID, role: UserRole.CUSTOMER },
        })
      ).rejects.toThrow(BookingInvalidTransitionError);
    });

    it("MUST reject START_WORK on a CANCELLED booking", async () => {
      const mockTx = {
        booking: {
          findUnique: jest.fn().mockResolvedValue({
            id: BOOKING_ID,
            status: BookingStatus.CANCELLED,
            customer_id: CUSTOMER_A_ID,
            worker_id: WORKER_A_ID,
          }),
        },
      };

      await expect(
        bookingStateService.transition(mockTx as any, {
          bookingId: BOOKING_ID,
          action: BookingAction.START_WORK,
          actor: { id: WORKER_A_ID, role: UserRole.WORKER },
        })
      ).rejects.toThrow(BookingInvalidTransitionError);
    });
  });

  // ===========================================================================
  // 5. ACTOR AUTHORIZATION & RESOURCE BOUNDARIES
  // ===========================================================================
  describe("5. Actor Authorization & Resource Boundaries", () => {
    it("MUST reject unassigned Worker B from verifying OTP / starting work", async () => {
      const mockTx = {
        booking: {
          findUnique: jest.fn().mockResolvedValue({
            id: BOOKING_ID,
            status: BookingStatus.CONFIRMED,
            customer_id: CUSTOMER_A_ID,
            worker_id: WORKER_A_ID, // Assigned to Worker A
          }),
        },
      };

      await expect(
        bookingStateService.transition(mockTx as any, {
          bookingId: BOOKING_ID,
          action: BookingAction.START_WORK,
          actor: { id: WORKER_B_ID, role: UserRole.WORKER },
        })
      ).rejects.toThrow(BookingAuthorizationError);
    });

    it("MUST reject unassigned Worker B from requesting completion", async () => {
      const mockTx = {
        booking: {
          findUnique: jest.fn().mockResolvedValue({
            id: BOOKING_ID,
            status: BookingStatus.IN_PROGRESS,
            customer_id: CUSTOMER_A_ID,
            worker_id: WORKER_A_ID,
          }),
        },
      };

      await expect(
        bookingStateService.transition(mockTx as any, {
          bookingId: BOOKING_ID,
          action: BookingAction.REQUEST_COMPLETION,
          actor: { id: WORKER_B_ID, role: UserRole.WORKER },
        })
      ).rejects.toThrow(BookingAuthorizationError);
    });

    it("MUST reject Customer B from confirming Customer A's booking", async () => {
      const mockTx = {
        booking: {
          findUnique: jest.fn().mockResolvedValue({
            id: BOOKING_ID,
            status: BookingStatus.AWAITING_CONFIRMATION,
            customer_id: CUSTOMER_A_ID, // Owned by Customer A
            worker_id: WORKER_A_ID,
          }),
        },
      };

      await expect(
        bookingStateService.transition(mockTx as any, {
          bookingId: BOOKING_ID,
          action: BookingAction.CONFIRM_COMPLETION,
          actor: { id: CUSTOMER_B_ID, role: UserRole.CUSTOMER },
        })
      ).rejects.toThrow(BookingAuthorizationError);
    });
  });

  // ===========================================================================
  // 6. IDEMPOTENCY SEMANTICS
  // ===========================================================================
  describe("6. Idempotency Semantics", () => {
    it("Customer repeated CONFIRM_COMPLETION on already COMPLETED booking returns success safely", async () => {
      const mockTx = {
        booking: {
          findUnique: jest.fn().mockResolvedValue({
            id: BOOKING_ID,
            status: BookingStatus.COMPLETED,
            customer_id: CUSTOMER_A_ID,
            worker_id: WORKER_A_ID,
          }),
          update: jest.fn(),
        },
        booking_transition: {
          create: jest.fn(),
        },
      };

      const result = await bookingStateService.transition(mockTx as any, {
        bookingId: BOOKING_ID,
        action: BookingAction.CONFIRM_COMPLETION,
        actor: { id: CUSTOMER_A_ID, role: UserRole.CUSTOMER },
      });

      expect(result.isIdempotent).toBe(true);
      expect(result.currentStatus).toBe(BookingStatus.COMPLETED);
      expect(mockTx.booking.update).not.toHaveBeenCalled();
      expect(mockTx.booking_transition.create).not.toHaveBeenCalled();
    });

    it("Worker repeated REQUEST_COMPLETION on already AWAITING_CONFIRMATION returns safely", async () => {
      const mockTx = {
        booking: {
          findUnique: jest.fn().mockResolvedValue({
            id: BOOKING_ID,
            status: BookingStatus.AWAITING_CONFIRMATION,
            customer_id: CUSTOMER_A_ID,
            worker_id: WORKER_A_ID,
          }),
          update: jest.fn(),
        },
      };

      const result = await bookingStateService.transition(mockTx as any, {
        bookingId: BOOKING_ID,
        action: BookingAction.REQUEST_COMPLETION,
        actor: { id: WORKER_A_ID, role: UserRole.WORKER },
      });

      expect(result.isIdempotent).toBe(true);
      expect(result.currentStatus).toBe(BookingStatus.AWAITING_CONFIRMATION);
      expect(mockTx.booking.update).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // 7. CONCURRENCY & RACE CONDITIONS
  // ===========================================================================
  describe("7. Concurrency & Race Simulation", () => {
    it("Race A: Simultaneous Worker completion requests -> exactly one transition", async () => {
      let isRowLocked = false;
      let currentStatus = BookingStatus.IN_PROGRESS;
      let transitionCount = 0;

      const runTransition = async () => {
        const mockTx = {
          $queryRaw: jest.fn().mockImplementation(async () => {
            while (isRowLocked) {
              await new Promise((r) => setTimeout(r, 10));
            }
            isRowLocked = true;
            return [{
              id: BOOKING_ID,
              status: currentStatus,
              customer_id: CUSTOMER_A_ID,
              worker_id: WORKER_A_ID,
            }];
          }),
          booking: {
            update: jest.fn().mockImplementation(({ data }) => {
              currentStatus = data.status;
              transitionCount++;
              isRowLocked = false;
              return Promise.resolve({ id: BOOKING_ID, status: currentStatus });
            }),
          },
          booking_transition: {
            create: jest.fn().mockResolvedValue({ id: "trans-race-a" }),
          },
        };

        try {
          return await bookingStateService.transition(mockTx as any, {
            bookingId: BOOKING_ID,
            action: BookingAction.REQUEST_COMPLETION,
            actor: { id: WORKER_A_ID, role: UserRole.WORKER },
          });
        } finally {
          isRowLocked = false;
        }
      };

      const [res1, res2] = await Promise.all([runTransition(), runTransition()]);

      expect(currentStatus).toBe(BookingStatus.AWAITING_CONFIRMATION);
      expect(transitionCount).toBe(1);
      expect([res1.isIdempotent, res2.isIdempotent]).toContain(false);
      expect([res1.isIdempotent, res2.isIdempotent]).toContain(true);
    });

    it("Race B: Worker completion vs Customer confirmation -> Customer cannot complete before AWAITING_CONFIRMATION", async () => {
      // While IN_PROGRESS, customer confirmation MUST fail
      const mockTxInProgress = {
        booking: {
          findUnique: jest.fn().mockResolvedValue({
            id: BOOKING_ID,
            status: BookingStatus.IN_PROGRESS,
            customer_id: CUSTOMER_A_ID,
            worker_id: WORKER_A_ID,
          }),
        },
      };

      await expect(
        bookingStateService.transition(mockTxInProgress as any, {
          bookingId: BOOKING_ID,
          action: BookingAction.CONFIRM_COMPLETION,
          actor: { id: CUSTOMER_A_ID, role: UserRole.CUSTOMER },
        })
      ).rejects.toThrow(BookingInvalidTransitionError);
    });

    it("Race C: Customer confirmation vs Customer confirmation -> exactly one completes, second is idempotent", async () => {
      let isRowLocked = false;
      let currentStatus = BookingStatus.AWAITING_CONFIRMATION;
      let transitionCount = 0;

      const runConfirm = async () => {
        const mockTx = {
          $queryRaw: jest.fn().mockImplementation(async () => {
            while (isRowLocked) {
              await new Promise((r) => setTimeout(r, 10));
            }
            isRowLocked = true;
            return [{
              id: BOOKING_ID,
              status: currentStatus,
              customer_id: CUSTOMER_A_ID,
              worker_id: WORKER_A_ID,
            }];
          }),
          booking: {
            update: jest.fn().mockImplementation(({ data }) => {
              currentStatus = data.status;
              transitionCount++;
              isRowLocked = false;
              return Promise.resolve({ id: BOOKING_ID, status: currentStatus });
            }),
          },
          booking_transition: {
            create: jest.fn().mockResolvedValue({ id: "trans-race-c" }),
          },
        };

        try {
          return await bookingStateService.transition(mockTx as any, {
            bookingId: BOOKING_ID,
            action: BookingAction.CONFIRM_COMPLETION,
            actor: { id: CUSTOMER_A_ID, role: UserRole.CUSTOMER },
          });
        } finally {
          isRowLocked = false;
        }
      };

      const [c1, c2] = await Promise.all([runConfirm(), runConfirm()]);

      expect(currentStatus).toBe(BookingStatus.COMPLETED);
      expect(transitionCount).toBe(1);
      expect([c1.isIdempotent, c2.isIdempotent]).toContain(false);
      expect([c1.isIdempotent, c2.isIdempotent]).toContain(true);
    });

    it("Race D: Cancellation vs Worker completion -> winner locks state, loser is rejected", async () => {
      // If cancellation commits first -> status is CANCELLED
      const mockTxCancelled = {
        booking: {
          findUnique: jest.fn().mockResolvedValue({
            id: BOOKING_ID,
            status: BookingStatus.CANCELLED,
            customer_id: CUSTOMER_A_ID,
            worker_id: WORKER_A_ID,
          }),
        },
      };

      await expect(
        bookingStateService.transition(mockTxCancelled as any, {
          bookingId: BOOKING_ID,
          action: BookingAction.REQUEST_COMPLETION,
          actor: { id: WORKER_A_ID, role: UserRole.WORKER },
        })
      ).rejects.toThrow(BookingInvalidTransitionError);
    });

    it("Race E: Cancellation vs Customer confirmation -> winner locks state, loser is rejected", async () => {
      const mockTxCancelled = {
        booking: {
          findUnique: jest.fn().mockResolvedValue({
            id: BOOKING_ID,
            status: BookingStatus.CANCELLED,
            customer_id: CUSTOMER_A_ID,
            worker_id: WORKER_A_ID,
          }),
        },
      };

      await expect(
        bookingStateService.transition(mockTxCancelled as any, {
          bookingId: BOOKING_ID,
          action: BookingAction.CONFIRM_COMPLETION,
          actor: { id: CUSTOMER_A_ID, role: UserRole.CUSTOMER },
        })
      ).rejects.toThrow(BookingInvalidTransitionError);
    });
  });

  // ===========================================================================
  // 8. HTTP API ENDPOINTS INTEGRATION
  // ===========================================================================
  describe("8. HTTP API Endpoints Integration", () => {
    it("POST /api/bookings/:bookingId/complete by Worker -> 200 Awaiting Confirmation", async () => {
      (prisma.$transaction as jest.Mock).mockImplementationOnce(async (cb: any) => {
        return cb({
          booking: {
            findFirst: jest.fn().mockResolvedValue({
              id: BOOKING_ID,
              status: BookingStatus.IN_PROGRESS,
              worker_id: WORKER_A_ID,
              customer_id: CUSTOMER_A_ID,
            }),
            findUnique: jest.fn().mockResolvedValue({
              id: BOOKING_ID,
              status: BookingStatus.IN_PROGRESS,
              worker_id: WORKER_A_ID,
              customer_id: CUSTOMER_A_ID,
            }),
            update: jest.fn().mockResolvedValue({
              id: BOOKING_ID,
              status: BookingStatus.AWAITING_CONFIRMATION,
            }),
          },
          booking_transition: {
            create: jest.fn().mockResolvedValue({ id: "trans-http-1" }),
          },
        });
      });

      const res = await request(app)
        .post(`/api/bookings/${BOOKING_ID}/complete`)
        .set("Authorization", `Bearer ${workerAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain("awaiting customer confirmation");
    });

    it("POST /api/bookings/:bookingId/confirm-complete by Customer -> 200 Completed", async () => {
      (prisma.$transaction as jest.Mock).mockImplementationOnce(async (cb: any) => {
        return cb({
          booking: {
            findFirst: jest.fn().mockResolvedValue({
              id: BOOKING_ID,
              status: BookingStatus.AWAITING_CONFIRMATION,
              worker_id: WORKER_A_ID,
              customer_id: CUSTOMER_A_ID,
            }),
            findUnique: jest.fn().mockResolvedValue({
              id: BOOKING_ID,
              status: BookingStatus.AWAITING_CONFIRMATION,
              worker_id: WORKER_A_ID,
              customer_id: CUSTOMER_A_ID,
            }),
            update: jest.fn().mockResolvedValue({
              id: BOOKING_ID,
              status: BookingStatus.COMPLETED,
            }),
            count: jest.fn().mockResolvedValue(0),
          },
          booking_transition: {
            create: jest.fn().mockResolvedValue({ id: "trans-http-2" }),
          },
        });
      });

      const res = await request(app)
        .post(`/api/bookings/${BOOKING_ID}/confirm-complete`)
        .set("Authorization", `Bearer ${customerAToken}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe("Booking completion confirmed");
    });

    it("POST /api/bookings/:bookingId/confirm-complete on IN_PROGRESS booking -> 400 Bad Request", async () => {
      (prisma.$transaction as jest.Mock).mockImplementationOnce(async (cb: any) => {
        return cb({
          booking: {
            findFirst: jest.fn().mockResolvedValue({
              id: BOOKING_ID,
              status: BookingStatus.IN_PROGRESS,
              worker_id: WORKER_A_ID,
              customer_id: CUSTOMER_A_ID,
            }),
            findUnique: jest.fn().mockResolvedValue({
              id: BOOKING_ID,
              status: BookingStatus.IN_PROGRESS,
              worker_id: WORKER_A_ID,
              customer_id: CUSTOMER_A_ID,
            }),
          },
        });
      });

      const res = await request(app)
        .post(`/api/bookings/${BOOKING_ID}/confirm-complete`)
        .set("Authorization", `Bearer ${customerAToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("BOOKING_INVALID_TRANSITION");
    });

    it("POST /api/bookings/:bookingId/cancel on CANCELLED booking -> 400 Bad Request", async () => {
      (prisma.$transaction as jest.Mock).mockImplementationOnce(async (cb: any) => {
        return cb({
          booking: {
            findFirst: jest.fn().mockResolvedValue({
              id: BOOKING_ID,
              status: BookingStatus.CANCELLED,
              worker_id: WORKER_A_ID,
              customer_id: CUSTOMER_A_ID,
            }),
            findUnique: jest.fn().mockResolvedValue({
              id: BOOKING_ID,
              status: BookingStatus.CANCELLED,
              worker_id: WORKER_A_ID,
              customer_id: CUSTOMER_A_ID,
            }),
          },
        });
      });

      const res = await request(app)
        .post(`/api/bookings/${BOOKING_ID}/cancel`)
        .set("Authorization", `Bearer ${customerAToken}`)
        .send({ reason: "Duplicate cancel attempt" });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("BOOKING_INVALID_TRANSITION");
    });
  });
});
