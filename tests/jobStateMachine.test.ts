import request from "supertest";
import { UserRole } from "../src/type/userRole";
import { generateToken } from "../src/utils/authUtils";
import {
  jobStateService,
  JobStatus,
  JobAction,
  JobInvalidTransitionError,
  JobStateConflictError,
  JobAuthorizationError,
  JobNotFoundError,
  TERMINAL_JOB_STATES,
} from "../src/features/jobs/jobStateMachine";

// Mock Bull Board and BullMQ
jest.mock("@bull-board/api", () => ({ createBullBoard: jest.fn().mockReturnValue({}) }));
jest.mock("@bull-board/api/bullMQAdapter", () => ({ BullMQAdapter: jest.fn().mockImplementation(() => ({})) }));
jest.mock("@bull-board/express", () => ({ ExpressAdapter: jest.fn().mockImplementation(() => ({ setBasePath: jest.fn(), getRouter: jest.fn().mockReturnValue((req: any, res: any, next: any) => next()) })) }));
jest.mock("bullmq", () => ({ Queue: jest.fn().mockImplementation(() => ({ add: jest.fn().mockResolvedValue({}) })), Worker: jest.fn().mockImplementation(() => ({ on: jest.fn(), close: jest.fn() })) }));
jest.mock("../src/config/bullmq", () => ({ dispatchQueue: { add: jest.fn() }, timeoutQueue: { add: jest.fn() }, connection: {} }));
jest.mock("../src/features/dispatch/simpleDispatch", () => ({ dispatchJobSimple: jest.fn().mockResolvedValue({}) }));

// Mock Prisma client
jest.mock("../src/config/prisma", () => {
  const mockPrisma = {
    customer: { findUnique: jest.fn(), findFirst: jest.fn() },
    worker: { findUnique: jest.fn(), findFirst: jest.fn() },
    job: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    job_requirement: {
      findMany: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    job_dispatch: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    job_transition: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
    booking: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  return {
    __esModule: true,
    default: mockPrisma,
  };
});

import { app } from "../src/server";
import prisma from "../src/config/prisma";
import { jobService } from "../src/features/jobs/job.services";

describe("P1 Security & Marketplace Correctness — Issue #14: Job State Machine", () => {
  const CUSTOMER_A_ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const CUSTOMER_B_ID = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
  const WORKER_ID = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
  const ADMIN_ID = "dddddddd-dddd-4ddd-dddd-dddddddddddd";
  const JOB_ID = "11111111-1111-4111-8111-111111111111";

  let customerAToken: string;
  let customerBToken: string;
  let workerToken: string;
  let adminToken: string;

  beforeAll(() => {
    customerAToken = generateToken({ id: CUSTOMER_A_ID, phone: "+919876543210", role: UserRole.CUSTOMER });
    customerBToken = generateToken({ id: CUSTOMER_B_ID, phone: "+919876543211", role: UserRole.CUSTOMER });
    workerToken = generateToken({ id: WORKER_ID, phone: "+919876543212", role: UserRole.WORKER });
    adminToken = generateToken({ id: ADMIN_ID, phone: "+919876543213", role: UserRole.ADMIN });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.$transaction as jest.Mock).mockImplementation(async (cb) => cb(prisma));
    (prisma.job_transition.create as jest.Mock).mockResolvedValue({ id: "trans-1" });
    (prisma.job_requirement.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.job_requirement.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (prisma.job_dispatch.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
  });

  // =========================================================================
  // 1. STATE DEFINITIONS & MATRIX RECOGNITION
  // =========================================================================
  describe("1. State Definitions & Terminal Identification", () => {
    it("MUST recognize all 6 canonical job states", () => {
      expect(JobStatus.OPEN).toBe("OPEN");
      expect(JobStatus.DISPATCHING).toBe("DISPATCHING");
      expect(JobStatus.BOOKED).toBe("BOOKED");
      expect(JobStatus.IN_PROGRESS).toBe("IN_PROGRESS");
      expect(JobStatus.COMPLETED).toBe("COMPLETED");
      expect(JobStatus.CANCELLED).toBe("CANCELLED");
    });

    it("MUST recognize COMPLETED and CANCELLED as terminal states", () => {
      expect(jobStateService.isTerminal(JobStatus.COMPLETED)).toBe(true);
      expect(jobStateService.isTerminal(JobStatus.CANCELLED)).toBe(true);
      expect(jobStateService.isTerminal(JobStatus.OPEN)).toBe(false);
      expect(jobStateService.isTerminal(JobStatus.DISPATCHING)).toBe(false);
      expect(jobStateService.isTerminal(JobStatus.BOOKED)).toBe(false);
      expect(jobStateService.isTerminal(JobStatus.IN_PROGRESS)).toBe(false);
    });

    it("Terminal states MUST have zero outbound actions", () => {
      expect(jobStateService.getLegalActions(JobStatus.COMPLETED)).toEqual([]);
      expect(jobStateService.getLegalActions(JobStatus.CANCELLED)).toEqual([]);
    });
  });

  // =========================================================================
  // 2. LEGAL TRANSITIONS SUITE
  // =========================================================================
  describe("2. Legal Transition Execution", () => {
    it("OPEN -> START_DISPATCH by SYSTEM -> DISPATCHING", async () => {
      const mockJob = { id: JOB_ID, status: JobStatus.OPEN, customer_id: CUSTOMER_A_ID };
      (prisma.job.findUnique as jest.Mock).mockResolvedValue(mockJob);
      (prisma.job.update as jest.Mock).mockImplementation(async ({ data }) => ({ ...mockJob, ...data }));

      const res = await jobStateService.transition(prisma as any, {
        jobId: JOB_ID,
        action: JobAction.START_DISPATCH,
        actor: { role: "SYSTEM" },
      });

      expect(res.previousStatus).toBe(JobStatus.OPEN);
      expect(res.currentStatus).toBe(JobStatus.DISPATCHING);
      expect(prisma.job.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: JOB_ID },
          data: expect.objectContaining({ status: JobStatus.DISPATCHING }),
        })
      );
      expect(prisma.job_transition.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            job_id: JOB_ID,
            from_status: JobStatus.OPEN,
            to_status: JobStatus.DISPATCHING,
            action: JobAction.START_DISPATCH,
            actor_type: "SYSTEM",
          }),
        })
      );
    });

    it("OPEN -> CANCEL by owning CUSTOMER -> CANCELLED with cancelled_at and cancelled_by", async () => {
      const mockJob = { id: JOB_ID, status: JobStatus.OPEN, customer_id: CUSTOMER_A_ID };
      (prisma.job.findUnique as jest.Mock).mockResolvedValue(mockJob);
      (prisma.job.update as jest.Mock).mockImplementation(async ({ data }) => ({ ...mockJob, ...data }));

      const res = await jobStateService.transition(prisma as any, {
        jobId: JOB_ID,
        action: JobAction.CANCEL,
        actor: { id: CUSTOMER_A_ID, role: UserRole.CUSTOMER },
        reason: "Customer changed mind",
      });

      expect(res.currentStatus).toBe(JobStatus.CANCELLED);
      expect(prisma.job.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: JOB_ID },
          data: expect.objectContaining({
            status: JobStatus.CANCELLED,
            cancelled_by: CUSTOMER_A_ID,
            cancelled_at: expect.any(Date),
          }),
        })
      );
    });

    it("DISPATCHING -> MARK_BOOKED by SYSTEM/WORKER -> BOOKED", async () => {
      const mockJob = { id: JOB_ID, status: JobStatus.DISPATCHING, customer_id: CUSTOMER_A_ID };
      (prisma.job.findUnique as jest.Mock).mockResolvedValue(mockJob);
      (prisma.job.update as jest.Mock).mockImplementation(async ({ data }) => ({ ...mockJob, ...data }));

      const res = await jobStateService.transition(prisma as any, {
        jobId: JOB_ID,
        action: JobAction.MARK_BOOKED,
        actor: { role: "SYSTEM" },
        reason: "All slots filled",
      });

      expect(res.currentStatus).toBe(JobStatus.BOOKED);
    });

    it("BOOKED -> START_WORK by WORKER -> IN_PROGRESS", async () => {
      const mockJob = { id: JOB_ID, status: JobStatus.BOOKED, customer_id: CUSTOMER_A_ID };
      (prisma.job.findUnique as jest.Mock).mockResolvedValue(mockJob);
      (prisma.job.update as jest.Mock).mockImplementation(async ({ data }) => ({ ...mockJob, ...data }));

      const res = await jobStateService.transition(prisma as any, {
        jobId: JOB_ID,
        action: JobAction.START_WORK,
        actor: { id: WORKER_ID, role: UserRole.WORKER },
        reason: "Worker OTP verified",
      });

      expect(res.currentStatus).toBe(JobStatus.IN_PROGRESS);
    });

    it("BOOKED -> REOPEN_DISPATCH by SYSTEM -> DISPATCHING (when booking was cancelled)", async () => {
      const mockJob = { id: JOB_ID, status: JobStatus.BOOKED, customer_id: CUSTOMER_A_ID };
      (prisma.job.findUnique as jest.Mock).mockResolvedValue(mockJob);
      (prisma.job.update as jest.Mock).mockImplementation(async ({ data }) => ({ ...mockJob, ...data }));

      const res = await jobStateService.transition(prisma as any, {
        jobId: JOB_ID,
        action: JobAction.REOPEN_DISPATCH,
        actor: { role: "SYSTEM" },
        reason: "Booking cancelled, redispatching unfilled slot",
      });

      expect(res.currentStatus).toBe(JobStatus.DISPATCHING);
    });

    it("IN_PROGRESS -> COMPLETE by CUSTOMER owner -> COMPLETED with completed_at", async () => {
      const mockJob = { id: JOB_ID, status: JobStatus.IN_PROGRESS, customer_id: CUSTOMER_A_ID };
      (prisma.job.findUnique as jest.Mock).mockResolvedValue(mockJob);
      (prisma.job.update as jest.Mock).mockImplementation(async ({ data }) => ({ ...mockJob, ...data }));

      const res = await jobStateService.transition(prisma as any, {
        jobId: JOB_ID,
        action: JobAction.COMPLETE,
        actor: { id: CUSTOMER_A_ID, role: UserRole.CUSTOMER },
        reason: "Customer confirmed completion",
      });

      expect(res.currentStatus).toBe(JobStatus.COMPLETED);
      expect(prisma.job.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: JOB_ID },
          data: expect.objectContaining({
            status: JobStatus.COMPLETED,
            completed_at: expect.any(Date),
          }),
        })
      );
    });

    it("OPEN -> CANCEL by ADMIN -> CANCELLED", async () => {
      const mockJob = { id: JOB_ID, status: JobStatus.OPEN, customer_id: CUSTOMER_A_ID };
      (prisma.job.findUnique as jest.Mock).mockResolvedValue(mockJob);
      (prisma.job.update as jest.Mock).mockImplementation(async ({ data }) => ({ ...mockJob, ...data }));

      const res = await jobStateService.transition(prisma as any, {
        jobId: JOB_ID,
        action: JobAction.CANCEL,
        actor: { id: ADMIN_ID, role: UserRole.ADMIN },
        reason: "Administrative cancellation",
      });

      expect(res.currentStatus).toBe(JobStatus.CANCELLED);
    });
  });

  // =========================================================================
  // 3. ILLEGAL TRANSITIONS SUITE
  // =========================================================================
  describe("3. Illegal Transition Rejection", () => {
    it("MUST reject CANCEL on a COMPLETED job", async () => {
      const mockJob = { id: JOB_ID, status: JobStatus.COMPLETED, customer_id: CUSTOMER_A_ID };
      (prisma.job.findUnique as jest.Mock).mockResolvedValue(mockJob);

      await expect(
        jobStateService.transition(prisma as any, {
          jobId: JOB_ID,
          action: JobAction.CANCEL,
          actor: { id: CUSTOMER_A_ID, role: UserRole.CUSTOMER },
        })
      ).rejects.toThrow(JobInvalidTransitionError);
    });

    it("MUST reject START_DISPATCH on a CANCELLED job", async () => {
      const mockJob = { id: JOB_ID, status: JobStatus.CANCELLED, customer_id: CUSTOMER_A_ID };
      (prisma.job.findUnique as jest.Mock).mockResolvedValue(mockJob);

      await expect(
        jobStateService.transition(prisma as any, {
          jobId: JOB_ID,
          action: JobAction.START_DISPATCH,
          actor: { role: "SYSTEM" },
        })
      ).rejects.toThrow(JobInvalidTransitionError);
    });

    it("MUST reject COMPLETE directly on an OPEN job", async () => {
      const mockJob = { id: JOB_ID, status: JobStatus.OPEN, customer_id: CUSTOMER_A_ID };
      (prisma.job.findUnique as jest.Mock).mockResolvedValue(mockJob);

      await expect(
        jobStateService.transition(prisma as any, {
          jobId: JOB_ID,
          action: JobAction.COMPLETE,
          actor: { id: CUSTOMER_A_ID, role: UserRole.CUSTOMER },
        })
      ).rejects.toThrow(JobInvalidTransitionError);
    });

    it("MUST reject START_WORK directly on an OPEN job (must be DISPATCHING or BOOKED)", async () => {
      const mockJob = { id: JOB_ID, status: JobStatus.OPEN, customer_id: CUSTOMER_A_ID };
      (prisma.job.findUnique as jest.Mock).mockResolvedValue(mockJob);

      await expect(
        jobStateService.transition(prisma as any, {
          jobId: JOB_ID,
          action: JobAction.START_WORK,
          actor: { id: WORKER_ID, role: UserRole.WORKER },
        })
      ).rejects.toThrow(JobInvalidTransitionError);
    });
  });

  // =========================================================================
  // 4. ACTOR AUTHORIZATION & OWNERSHIP
  // =========================================================================
  describe("4. Actor Authorization & Ownership Guards", () => {
    it("MUST reject Customer B attempting to cancel Customer A's job", async () => {
      const mockJob = { id: JOB_ID, status: JobStatus.OPEN, customer_id: CUSTOMER_A_ID };
      (prisma.job.findUnique as jest.Mock).mockResolvedValue(mockJob);

      await expect(
        jobStateService.transition(prisma as any, {
          jobId: JOB_ID,
          action: JobAction.CANCEL,
          actor: { id: CUSTOMER_B_ID, role: UserRole.CUSTOMER },
        })
      ).rejects.toThrow(JobAuthorizationError);
    });

    it("MUST reject Worker attempting to cancel customer job", async () => {
      const mockJob = { id: JOB_ID, status: JobStatus.OPEN, customer_id: CUSTOMER_A_ID };
      (prisma.job.findUnique as jest.Mock).mockResolvedValue(mockJob);

      await expect(
        jobStateService.transition(prisma as any, {
          jobId: JOB_ID,
          action: JobAction.CANCEL,
          actor: { id: WORKER_ID, role: UserRole.WORKER },
        })
      ).rejects.toThrow(JobInvalidTransitionError);
    });

    it("MUST reject Customer attempting to trigger system-only START_DISPATCH", async () => {
      const mockJob = { id: JOB_ID, status: JobStatus.OPEN, customer_id: CUSTOMER_A_ID };
      (prisma.job.findUnique as jest.Mock).mockResolvedValue(mockJob);

      await expect(
        jobStateService.transition(prisma as any, {
          jobId: JOB_ID,
          action: JobAction.START_DISPATCH,
          actor: { id: CUSTOMER_A_ID, role: UserRole.CUSTOMER },
        })
      ).rejects.toThrow(JobInvalidTransitionError);
    });
  });

  // =========================================================================
  // 5. ATOMIC CONCURRENCY & COMPARE-AND-SET (CAS)
  // =========================================================================
  describe("5. Atomic Concurrency & CAS Conflict Protection", () => {
    it("MUST reject transition if expectedCurrentStatus does not match actual state (CAS conflict)", async () => {
      // Current DB state is DISPATCHING
      const mockJob = { id: JOB_ID, status: JobStatus.DISPATCHING, customer_id: CUSTOMER_A_ID };
      (prisma.job.findUnique as jest.Mock).mockResolvedValue(mockJob);

      // Caller expected state to still be OPEN
      await expect(
        jobStateService.transition(prisma as any, {
          jobId: JOB_ID,
          action: JobAction.CANCEL,
          actor: { id: CUSTOMER_A_ID, role: UserRole.CUSTOMER },
          expectedCurrentStatus: JobStatus.OPEN,
        })
      ).rejects.toThrow(JobStateConflictError);
    });

    it("MUST allow transition when expectedCurrentStatus matches actual state", async () => {
      const mockJob = { id: JOB_ID, status: JobStatus.OPEN, customer_id: CUSTOMER_A_ID };
      (prisma.job.findUnique as jest.Mock).mockResolvedValue(mockJob);
      (prisma.job.update as jest.Mock).mockImplementation(async ({ data }) => ({ ...mockJob, ...data }));

      const res = await jobStateService.transition(prisma as any, {
        jobId: JOB_ID,
        action: JobAction.CANCEL,
        actor: { id: CUSTOMER_A_ID, role: UserRole.CUSTOMER },
        expectedCurrentStatus: JobStatus.OPEN,
      });

      expect(res.currentStatus).toBe(JobStatus.CANCELLED);
    });

    it("MUST reject non-existent job with JobNotFoundError", async () => {
      (prisma.job.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        jobStateService.transition(prisma as any, {
          jobId: "00000000-0000-0000-0000-000000000000",
          action: JobAction.CANCEL,
          actor: { id: CUSTOMER_A_ID, role: UserRole.CUSTOMER },
        })
      ).rejects.toThrow(JobNotFoundError);
    });
  });

  // =========================================================================
  // 6. HTTP API INTEGRATION TESTS
  // =========================================================================
  describe("6. HTTP API Integration: PATCH /api/jobs/:jobId/cancel", () => {
    it("Customer A cancels own OPEN job -> 200 Success with state machine execution", async () => {
      const mockJob = { id: JOB_ID, customer_id: CUSTOMER_A_ID, status: JobStatus.OPEN };
      (prisma.job.findUnique as jest.Mock).mockResolvedValue(mockJob);
      (prisma.job.update as jest.Mock).mockImplementation(async ({ data }) => ({ ...mockJob, ...data }));

      const res = await request(app)
        .patch(`/api/jobs/${JOB_ID}/cancel`)
        .set("Authorization", `Bearer ${customerAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe("Job cancelled");
      expect(res.body.data.currentStatus).toBe(JobStatus.CANCELLED);
    });

    it("Customer A attempts to cancel already CANCELLED job -> 400 with JOB_INVALID_TRANSITION", async () => {
      const mockJob = { id: JOB_ID, customer_id: CUSTOMER_A_ID, status: JobStatus.CANCELLED };
      (prisma.job.findUnique as jest.Mock).mockResolvedValue(mockJob);

      const res = await request(app)
        .patch(`/api/jobs/${JOB_ID}/cancel`)
        .set("Authorization", `Bearer ${customerAToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("JOB_INVALID_TRANSITION");
    });

    it("Customer A attempts to cancel already COMPLETED job -> 400 with JOB_INVALID_TRANSITION", async () => {
      const mockJob = { id: JOB_ID, customer_id: CUSTOMER_A_ID, status: JobStatus.COMPLETED };
      (prisma.job.findUnique as jest.Mock).mockResolvedValue(mockJob);

      const res = await request(app)
        .patch(`/api/jobs/${JOB_ID}/cancel`)
        .set("Authorization", `Bearer ${customerAToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("JOB_INVALID_TRANSITION");
    });

    it("Customer B attempts to cancel Customer A's job -> 403 Forbidden", async () => {
      const mockJob = { id: JOB_ID, customer_id: CUSTOMER_A_ID, status: JobStatus.OPEN };
      (prisma.job.findUnique as jest.Mock).mockResolvedValue(mockJob);

      const res = await request(app)
        .patch(`/api/jobs/${JOB_ID}/cancel`)
        .set("Authorization", `Bearer ${customerBToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });
  });
});
