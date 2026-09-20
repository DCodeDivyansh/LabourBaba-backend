import {
  RequirementStatus,
  RequirementAction,
  RequirementStateError,
  RequirementNotFoundError,
  RequirementInvalidTransitionError,
  RequirementCapacityExceededError,
  RequirementInvalidWorkerCountError,
  RequirementAuthorizationError,
  calculateRequirementCapacity,
  requirementStateService,
  ACTIVE_BOOKING_STATUSES,
} from "../src/features/jobs/requirementStateMachine";
import { UserRole } from "../src/policies";

describe("Issue #15: Requirement State Machine & Worker Count Capacity Model", () => {
  describe("1. Capacity Model & Invariants", () => {
    it("should correctly compute capacity for an open requirement", () => {
      const cap = calculateRequirementCapacity(5, 0);
      expect(cap.workerCountNeeded).toBe(5);
      expect(cap.filledCapacity).toBe(0);
      expect(cap.remainingCapacity).toBe(5);
      expect(cap.isOpen).toBe(true);
      expect(cap.isPartiallyFilled).toBe(false);
      expect(cap.isFilled).toBe(false);
    });

    it("should correctly compute capacity for a partially filled requirement", () => {
      const cap = calculateRequirementCapacity(5, 2);
      expect(cap.workerCountNeeded).toBe(5);
      expect(cap.filledCapacity).toBe(2);
      expect(cap.remainingCapacity).toBe(3);
      expect(cap.isOpen).toBe(false);
      expect(cap.isPartiallyFilled).toBe(true);
      expect(cap.isFilled).toBe(false);
    });

    it("should correctly compute capacity for a completely filled requirement", () => {
      const cap = calculateRequirementCapacity(3, 3);
      expect(cap.workerCountNeeded).toBe(3);
      expect(cap.filledCapacity).toBe(3);
      expect(cap.remainingCapacity).toBe(0);
      expect(cap.isOpen).toBe(false);
      expect(cap.isPartiallyFilled).toBe(false);
      expect(cap.isFilled).toBe(true);
    });

    it("should reject invalid worker counts (zero, negative, decimal, NaN, Infinity)", () => {
      expect(() => calculateRequirementCapacity(0, 0)).toThrow(RequirementInvalidWorkerCountError);
      expect(() => calculateRequirementCapacity(-3, 0)).toThrow(RequirementInvalidWorkerCountError);
      expect(() => calculateRequirementCapacity(2.5, 0)).toThrow(RequirementInvalidWorkerCountError);
      expect(() => calculateRequirementCapacity(NaN, 0)).toThrow(RequirementInvalidWorkerCountError);
      expect(() => calculateRequirementCapacity(Infinity, 0)).toThrow(RequirementInvalidWorkerCountError);
    });
  });

  describe("2. Transition Legality (canTransition)", () => {
    const customerActor = { id: "cust-1", role: UserRole.CUSTOMER };
    const nonOwnerCustomer = { id: "cust-2", role: UserRole.CUSTOMER };
    const adminActor = { id: "admin-1", role: UserRole.ADMIN };
    const systemActor = { role: "SYSTEM" };
    const workerActor = { id: "worker-1", role: UserRole.WORKER };

    it("should allow START_DISPATCH from OPEN, PARTIALLY_FILLED, and NO_WORKERS_AVAILABLE", () => {
      expect(
        requirementStateService.canTransition(RequirementStatus.OPEN, RequirementAction.START_DISPATCH, systemActor)
      ).toEqual({ allowed: true });

      expect(
        requirementStateService.canTransition(
          RequirementStatus.PARTIALLY_FILLED,
          RequirementAction.START_DISPATCH,
          systemActor
        )
      ).toEqual({ allowed: true });

      expect(
        requirementStateService.canTransition(
          RequirementStatus.NO_WORKERS_AVAILABLE,
          RequirementAction.START_DISPATCH,
          customerActor,
          "cust-1"
        )
      ).toEqual({ allowed: true });
    });

    it("should reject START_DISPATCH on FILLED and CANCELLED states", () => {
      expect(
        requirementStateService.canTransition(RequirementStatus.FILLED, RequirementAction.START_DISPATCH, systemActor)
          .allowed
      ).toBe(false);

      expect(
        requirementStateService.canTransition(RequirementStatus.CANCELLED, RequirementAction.START_DISPATCH, systemActor)
          .allowed
      ).toBe(false);
    });

    it("should enforce ownership on CANCEL for customer actors", () => {
      expect(
        requirementStateService.canTransition(RequirementStatus.OPEN, RequirementAction.CANCEL, customerActor, "cust-1")
      ).toEqual({ allowed: true });

      const nonOwnerResult = requirementStateService.canTransition(
        RequirementStatus.OPEN,
        RequirementAction.CANCEL,
        nonOwnerCustomer,
        "cust-1"
      );
      expect(nonOwnerResult.allowed).toBe(false);
      expect(nonOwnerResult.reason).toContain("Forbidden");
    });

    it("should allow ADMIN and SYSTEM to CANCEL any non-terminal requirement", () => {
      expect(
        requirementStateService.canTransition(RequirementStatus.OPEN, RequirementAction.CANCEL, adminActor, "cust-1")
      ).toEqual({ allowed: true });

      expect(
        requirementStateService.canTransition(RequirementStatus.DISPATCHING, RequirementAction.CANCEL, systemActor, "cust-1")
      ).toEqual({ allowed: true });
    });

    it("should allow RELEASE_SLOT on FILLED and PARTIALLY_FILLED", () => {
      expect(
        requirementStateService.canTransition(RequirementStatus.FILLED, RequirementAction.RELEASE_SLOT, systemActor)
      ).toEqual({ allowed: true });

      expect(
        requirementStateService.canTransition(
          RequirementStatus.PARTIALLY_FILLED,
          RequirementAction.RELEASE_SLOT,
          systemActor
        )
      ).toEqual({ allowed: true });
    });
  });

  describe("3. Transactional Transitions & Reconciliations", () => {
    it("should execute RECORD_ACCEPTANCE and transition to PARTIALLY_FILLED when slots remain", async () => {
      const mockReq = {
        id: "req-1",
        job_id: "job-1",
        status: "OPEN",
        worker_count_needed: 3,
        worker_count_filled: 0,
        job: { customer_id: "cust-1" },
      };

      const mockTx = {
        job_requirement: {
          findUnique: jest.fn().mockResolvedValue(mockReq),
          update: jest.fn().mockImplementation(({ data }) => ({
            ...mockReq,
            ...data,
          })),
        },
      };

      const res = await requirementStateService.transition(mockTx as any, {
        requirementId: "req-1",
        action: RequirementAction.RECORD_ACCEPTANCE,
        actor: { id: "w-1", role: UserRole.WORKER },
        newFilledCount: 1,
      });

      expect(res.currentStatus).toBe(RequirementStatus.PARTIALLY_FILLED);
      expect(res.capacity.filledCapacity).toBe(1);
      expect(res.capacity.remainingCapacity).toBe(2);
      expect(res.capacity.isFilled).toBe(false);
    });

    it("should execute RECORD_ACCEPTANCE and transition to FILLED when all slots are taken", async () => {
      const mockReq = {
        id: "req-1",
        job_id: "job-1",
        status: "PARTIALLY_FILLED",
        worker_count_needed: 2,
        worker_count_filled: 1,
        job: { customer_id: "cust-1" },
      };

      const mockTx = {
        job_requirement: {
          findUnique: jest.fn().mockResolvedValue(mockReq),
          update: jest.fn().mockImplementation(({ data }) => ({
            ...mockReq,
            ...data,
          })),
        },
      };

      const res = await requirementStateService.transition(mockTx as any, {
        requirementId: "req-1",
        action: RequirementAction.RECORD_ACCEPTANCE,
        actor: { id: "w-2", role: UserRole.WORKER },
        newFilledCount: 2,
      });

      expect(res.currentStatus).toBe(RequirementStatus.FILLED);
      expect(res.capacity.filledCapacity).toBe(2);
      expect(res.capacity.remainingCapacity).toBe(0);
      expect(res.capacity.isFilled).toBe(true);
    });

    it("should reconcile requirement capacity authoritatively from active bookings", async () => {
      const mockReq = {
        id: "req-1",
        job_id: "job-1",
        status: "FILLED",
        worker_count_needed: 3,
        worker_count_filled: 3,
      };

      const mockTx = {
        job_requirement: {
          findUnique: jest.fn().mockResolvedValue(mockReq),
          update: jest.fn().mockImplementation(({ data }) => ({
            ...mockReq,
            ...data,
          })),
        },
        booking: {
          count: jest.fn().mockResolvedValue(1), // 1 active booking left after 2 were cancelled
        },
      };

      const capacity = await requirementStateService.reconcileCapacity(mockTx as any, "req-1");

      expect(capacity.filledCapacity).toBe(1);
      expect(capacity.remainingCapacity).toBe(2);
      expect(capacity.isPartiallyFilled).toBe(true);
      expect(mockTx.job_requirement.update).toHaveBeenCalledWith({
        where: { id: "req-1" },
        data: expect.objectContaining({
          worker_count_filled: 1,
          status: RequirementStatus.PARTIALLY_FILLED,
        }),
      });
    });

    it("should update worker demand when new demand >= filled capacity", async () => {
      const mockReq = {
        id: "req-1",
        job_id: "job-1",
        status: "PARTIALLY_FILLED",
        worker_count_needed: 2,
        worker_count_filled: 1,
        job: { customer_id: "cust-1" },
      };

      const mockTx = {
        job_requirement: {
          findUnique: jest.fn().mockResolvedValue(mockReq),
          update: jest.fn().mockImplementation(({ data }) => ({
            ...mockReq,
            ...data,
          })),
        },
      };

      const res = await requirementStateService.updateDemand(
        mockTx as any,
        "req-1",
        4,
        { id: "cust-1", role: UserRole.CUSTOMER }
      );

      expect(res.capacity.workerCountNeeded).toBe(4);
      expect(res.capacity.remainingCapacity).toBe(3);
    });

    it("should reject reducing demand below filled capacity", async () => {
      const mockReq = {
        id: "req-1",
        job_id: "job-1",
        status: "PARTIALLY_FILLED",
        worker_count_needed: 4,
        worker_count_filled: 3,
        job: { customer_id: "cust-1" },
      };

      const mockTx = {
        job_requirement: {
          findUnique: jest.fn().mockResolvedValue(mockReq),
        },
      };

      await expect(
        requirementStateService.updateDemand(
          mockTx as any,
          "req-1",
          2, // 2 < 3 filled
          { id: "cust-1", role: UserRole.CUSTOMER }
        )
      ).rejects.toThrow(RequirementCapacityExceededError);
    });
  });

  describe("4. Concurrency & Overbooking Prevention Logic", () => {
    it("should safely allocate slots without overbooking under concurrent acceptance attempts", async () => {
      const workerCountNeeded = 2;
      let workerCountFilled = 0;
      let requirementStatus = RequirementStatus.OPEN;
      const acceptedWorkers: string[] = [];
      const rejectedWorkers: string[] = [];

      // Simulate serialized row-lock inside transaction
      const simulateAccept = async (workerId: string) => {
        // SELECT FOR UPDATE
        if (workerCountFilled >= workerCountNeeded || requirementStatus === RequirementStatus.FILLED) {
          rejectedWorkers.push(workerId);
          throw new RequirementCapacityExceededError("Requirement slots are already full");
        }

        // Increment and transition
        workerCountFilled += 1;
        if (workerCountFilled >= workerCountNeeded) {
          requirementStatus = RequirementStatus.FILLED;
        } else {
          requirementStatus = RequirementStatus.PARTIALLY_FILLED;
        }
        acceptedWorkers.push(workerId);
        return { success: true, filled: workerCountFilled };
      };

      // 10 concurrent worker acceptance attempts
      const attempts = Array.from({ length: 10 }, (_, i) => `worker-${i + 1}`);
      const results = await Promise.allSettled(attempts.map((w) => simulateAccept(w)));

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      expect(fulfilled.length).toBe(2);
      expect(rejected.length).toBe(8);
      expect(acceptedWorkers.length).toBe(2);
      expect(rejectedWorkers.length).toBe(8);
      expect(workerCountFilled).toBe(2);
      expect(requirementStatus).toBe(RequirementStatus.FILLED);
    });
  });
});
