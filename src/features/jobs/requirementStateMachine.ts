import { Prisma } from "@prisma/client";
import { UserRole } from "../../policies";

// ── 1. REQUIREMENT LIFECYCLE STATES & ACTIONS ──────────────────────────────

export enum RequirementStatus {
  OPEN = "OPEN",
  DISPATCHING = "DISPATCHING",
  PARTIALLY_FILLED = "PARTIALLY_FILLED",
  FILLED = "FILLED",
  NO_WORKERS_AVAILABLE = "NO_WORKERS_AVAILABLE",
  CANCELLED = "CANCELLED",
}

export enum RequirementAction {
  CREATE = "CREATE",
  START_DISPATCH = "START_DISPATCH",
  RECORD_ACCEPTANCE = "RECORD_ACCEPTANCE",
  EXHAUST_DISPATCH = "EXHAUST_DISPATCH",
  RELEASE_SLOT = "RELEASE_SLOT",
  CANCEL = "CANCEL",
  UPDATE_DEMAND = "UPDATE_DEMAND",
}

export type RequirementTransitionActorRole = UserRole | "SYSTEM" | "DISPATCH_WORKER";

export interface RequirementTransitionActor {
  id?: string;
  role: RequirementTransitionActorRole | string;
  phone?: string;
}

// ── 2. DOMAIN ERRORS ────────────────────────────────────────────────────────

export class RequirementStateError extends Error {
  public readonly statusCode: number;
  public readonly status: number;
  public readonly code: string;

  constructor(message: string, statusCode: number = 400, code: string = "REQUIREMENT_STATE_ERROR") {
    super(message);
    this.name = "RequirementStateError";
    this.statusCode = statusCode;
    this.status = statusCode;
    this.code = code;
  }
}

export class RequirementNotFoundError extends RequirementStateError {
  constructor(message: string = "Requirement not found") {
    super(message, 404, "REQUIREMENT_NOT_FOUND");
    this.name = "RequirementNotFoundError";
  }
}

export class RequirementInvalidTransitionError extends RequirementStateError {
  public readonly fromStatus: string;
  public readonly action: string;

  constructor(fromStatus: string, action: string, reason?: string) {
    const msg = reason || `Illegal requirement transition: Cannot perform '${action}' on requirement in status '${fromStatus}'`;
    super(msg, 400, "REQUIREMENT_INVALID_TRANSITION");
    this.name = "RequirementInvalidTransitionError";
    this.fromStatus = fromStatus;
    this.action = action;
  }
}

export class RequirementCapacityExceededError extends RequirementStateError {
  constructor(message: string = "Requirement slots are already full") {
    super(message, 409, "REQUIREMENT_CAPACITY_EXCEEDED");
    this.name = "RequirementCapacityExceededError";
  }
}

export class RequirementInvalidWorkerCountError extends RequirementStateError {
  constructor(message: string = "Worker count must be a positive integer") {
    super(message, 400, "REQUIREMENT_WORKER_COUNT_INVALID");
    this.name = "RequirementInvalidWorkerCountError";
  }
}

export class RequirementAuthorizationError extends RequirementStateError {
  constructor(message: string = "Forbidden: Not authorized to modify requirement state") {
    super(message, 403, "REQUIREMENT_FORBIDDEN");
    this.name = "RequirementAuthorizationError";
  }
}

// ── 3. CAPACITY MODEL & INVARIANTS ──────────────────────────────────────────

export interface RequirementCapacity {
  workerCountNeeded: number;
  filledCapacity: number;
  remainingCapacity: number;
  isFilled: boolean;
  isOpen: boolean;
  isPartiallyFilled: boolean;
}

export const ACTIVE_BOOKING_STATUSES: ReadonlySet<string> = new Set([
  "confirmed",
  "CONFIRMED",
  "IN_PROGRESS",
  "COMPLETED",
]);

export function calculateRequirementCapacity(
  workerCountNeeded: number,
  filledCapacity: number
): RequirementCapacity {
  if (!Number.isInteger(workerCountNeeded) || workerCountNeeded <= 0) {
    throw new RequirementInvalidWorkerCountError(
      `Invalid worker_count_needed: ${workerCountNeeded}. Must be an integer >= 1`
    );
  }

  const filled = Math.max(0, filledCapacity || 0);
  const remaining = Math.max(0, workerCountNeeded - filled);

  return {
    workerCountNeeded,
    filledCapacity: filled,
    remainingCapacity: remaining,
    isFilled: filled >= workerCountNeeded,
    isOpen: filled === 0,
    isPartiallyFilled: filled > 0 && filled < workerCountNeeded,
  };
}

// ── 4. TRANSITION RULES & MATRIX ─────────────────────────────────────────────

export interface RequirementTransitionRule {
  targetStatus: RequirementStatus | ((context: RequirementTransitionContext) => RequirementStatus);
  allowedRoles: (RequirementTransitionActorRole | string)[];
  requiresOwnership?: boolean;
}

export interface RequirementTransitionContext {
  requirement: {
    id: string;
    job_id: string;
    status: string | null;
    worker_count_needed: number;
    worker_count_filled: number | null;
    job?: { customer_id: string; [key: string]: any } | null;
    [key: string]: any;
  };
  action: RequirementAction;
  actor: RequirementTransitionActor;
  metadata?: Record<string, any>;
  newFilledCount?: number;
}

export const TERMINAL_REQUIREMENT_STATES: ReadonlySet<RequirementStatus> = new Set([
  RequirementStatus.CANCELLED,
]);

export const REQUIREMENT_TRANSITION_TABLE: Record<
  RequirementStatus,
  Partial<Record<RequirementAction, RequirementTransitionRule>>
> = {
  [RequirementStatus.OPEN]: {
    [RequirementAction.START_DISPATCH]: {
      targetStatus: RequirementStatus.DISPATCHING,
      allowedRoles: [UserRole.ADMIN, "SYSTEM", "DISPATCH_WORKER"],
    },
    [RequirementAction.RECORD_ACCEPTANCE]: {
      targetStatus: (ctx) => {
        const filled = ctx.newFilledCount ?? ((ctx.requirement.worker_count_filled ?? 0) + 1);
        return filled >= ctx.requirement.worker_count_needed
          ? RequirementStatus.FILLED
          : RequirementStatus.PARTIALLY_FILLED;
      },
      allowedRoles: [UserRole.ADMIN, "SYSTEM", "DISPATCH_WORKER", UserRole.WORKER],
    },
    [RequirementAction.CANCEL]: {
      targetStatus: RequirementStatus.CANCELLED,
      allowedRoles: [UserRole.CUSTOMER, UserRole.ADMIN, "SYSTEM"],
      requiresOwnership: true,
    },
  },
  [RequirementStatus.DISPATCHING]: {
    [RequirementAction.RECORD_ACCEPTANCE]: {
      targetStatus: (ctx) => {
        const filled = ctx.newFilledCount ?? ((ctx.requirement.worker_count_filled ?? 0) + 1);
        return filled >= ctx.requirement.worker_count_needed
          ? RequirementStatus.FILLED
          : RequirementStatus.PARTIALLY_FILLED;
      },
      allowedRoles: [UserRole.ADMIN, "SYSTEM", "DISPATCH_WORKER", UserRole.WORKER],
    },
    [RequirementAction.EXHAUST_DISPATCH]: {
      targetStatus: (ctx) => {
        const filled = ctx.requirement.worker_count_filled ?? 0;
        return filled > 0
          ? RequirementStatus.PARTIALLY_FILLED
          : RequirementStatus.NO_WORKERS_AVAILABLE;
      },
      allowedRoles: [UserRole.ADMIN, "SYSTEM", "DISPATCH_WORKER"],
    },
    [RequirementAction.CANCEL]: {
      targetStatus: RequirementStatus.CANCELLED,
      allowedRoles: [UserRole.CUSTOMER, UserRole.ADMIN, "SYSTEM"],
      requiresOwnership: true,
    },
  },
  [RequirementStatus.PARTIALLY_FILLED]: {
    [RequirementAction.START_DISPATCH]: {
      targetStatus: RequirementStatus.DISPATCHING,
      allowedRoles: [UserRole.ADMIN, "SYSTEM", "DISPATCH_WORKER"],
    },
    [RequirementAction.RECORD_ACCEPTANCE]: {
      targetStatus: (ctx) => {
        const filled = ctx.newFilledCount ?? ((ctx.requirement.worker_count_filled ?? 0) + 1);
        return filled >= ctx.requirement.worker_count_needed
          ? RequirementStatus.FILLED
          : RequirementStatus.PARTIALLY_FILLED;
      },
      allowedRoles: [UserRole.ADMIN, "SYSTEM", "DISPATCH_WORKER", UserRole.WORKER],
    },
    [RequirementAction.EXHAUST_DISPATCH]: {
      targetStatus: RequirementStatus.PARTIALLY_FILLED,
      allowedRoles: [UserRole.ADMIN, "SYSTEM", "DISPATCH_WORKER"],
    },
    [RequirementAction.RELEASE_SLOT]: {
      targetStatus: (ctx) => {
        const filled = ctx.newFilledCount ?? Math.max(0, (ctx.requirement.worker_count_filled ?? 1) - 1);
        return filled === 0 ? RequirementStatus.OPEN : RequirementStatus.PARTIALLY_FILLED;
      },
      allowedRoles: [UserRole.CUSTOMER, UserRole.ADMIN, "SYSTEM", UserRole.WORKER],
    },
    [RequirementAction.CANCEL]: {
      targetStatus: RequirementStatus.CANCELLED,
      allowedRoles: [UserRole.CUSTOMER, UserRole.ADMIN, "SYSTEM"],
      requiresOwnership: true,
    },
  },
  [RequirementStatus.FILLED]: {
    [RequirementAction.RELEASE_SLOT]: {
      targetStatus: (ctx) => {
        const filled = ctx.newFilledCount ?? Math.max(0, (ctx.requirement.worker_count_filled ?? 1) - 1);
        return filled === 0
          ? RequirementStatus.OPEN
          : RequirementStatus.PARTIALLY_FILLED;
      },
      allowedRoles: [UserRole.CUSTOMER, UserRole.ADMIN, "SYSTEM", UserRole.WORKER],
    },
    [RequirementAction.CANCEL]: {
      targetStatus: RequirementStatus.CANCELLED,
      allowedRoles: [UserRole.CUSTOMER, UserRole.ADMIN, "SYSTEM"],
      requiresOwnership: true,
    },
  },
  [RequirementStatus.NO_WORKERS_AVAILABLE]: {
    [RequirementAction.START_DISPATCH]: {
      targetStatus: RequirementStatus.DISPATCHING,
      allowedRoles: [UserRole.ADMIN, "SYSTEM", "DISPATCH_WORKER", UserRole.CUSTOMER],
    },
    [RequirementAction.CANCEL]: {
      targetStatus: RequirementStatus.CANCELLED,
      allowedRoles: [UserRole.CUSTOMER, UserRole.ADMIN, "SYSTEM"],
      requiresOwnership: true,
    },
  },
  [RequirementStatus.CANCELLED]: {},
};

// ── 5. TRANSITION SERVICE ───────────────────────────────────────────────────

export interface TransitionRequirementParams {
  requirementId: string;
  action: RequirementAction;
  actor: RequirementTransitionActor;
  reason?: string;
  metadata?: Record<string, any>;
  newFilledCount?: number;
}

export interface RequirementTransitionResult {
  requirement: any;
  previousStatus: RequirementStatus;
  currentStatus: RequirementStatus;
  action: RequirementAction;
  capacity: RequirementCapacity;
}

export const requirementStateService = {
  /**
   * Normalizes raw status string to canonical RequirementStatus.
   */
  normalizeStatus(status?: string | null): RequirementStatus {
    if (!status) return RequirementStatus.OPEN;
    const upper = status.toUpperCase();
    if (upper === "FILLED") return RequirementStatus.FILLED;
    if (upper === "DISPATCHING") return RequirementStatus.DISPATCHING;
    if (upper === "PARTIALLY_FILLED") return RequirementStatus.PARTIALLY_FILLED;
    if (upper === "NO_WORKERS_AVAILABLE") return RequirementStatus.NO_WORKERS_AVAILABLE;
    if (upper === "CANCELLED") return RequirementStatus.CANCELLED;
    return RequirementStatus.OPEN;
  },

  /**
   * Checks if status is terminal.
   */
  isTerminal(status: string | RequirementStatus): boolean {
    return TERMINAL_REQUIREMENT_STATES.has(this.normalizeStatus(status));
  },

  /**
   * Derives capacity for given requirement object.
   */
  getCapacity(req: { worker_count_needed: number; worker_count_filled?: number | null }): RequirementCapacity {
    return calculateRequirementCapacity(req.worker_count_needed, req.worker_count_filled ?? 0);
  },

  /**
   * Evaluates if a transition is allowed.
   */
  canTransition(
    currentStatus: string | RequirementStatus,
    action: RequirementAction,
    actor: RequirementTransitionActor,
    customerOwnerId?: string
  ): { allowed: boolean; reason?: string } {
    const normalized = this.normalizeStatus(currentStatus);

    // Ownership check for customer actors
    if (actor.role === UserRole.CUSTOMER && customerOwnerId && actor.id && customerOwnerId !== actor.id) {
      return {
        allowed: false,
        reason: "Forbidden: You do not own this requirement",
      };
    }

    const rules = REQUIREMENT_TRANSITION_TABLE[normalized];
    if (!rules) {
      return { allowed: false, reason: `Unknown requirement status '${currentStatus}'` };
    }

    const rule = rules[action];
    if (!rule) {
      return {
        allowed: false,
        reason: `Action '${action}' is not allowed when requirement is in status '${normalized}'`,
      };
    }

    if (!rule.allowedRoles.includes(actor.role)) {
      return {
        allowed: false,
        reason: `Actor role '${actor.role}' is not authorized to execute '${action}'`,
      };
    }

    return { allowed: true };
  },

  /**
   * Transactional transition of Requirement lifecycle.
   */
  async transition(
    tx: Prisma.TransactionClient,
    params: TransitionRequirementParams
  ): Promise<RequirementTransitionResult> {
    const { requirementId, action, actor, newFilledCount } = params;

    const req = await tx.job_requirement.findUnique({
      where: { id: requirementId },
      include: { job: { select: { customer_id: true } } },
    });

    if (!req) {
      throw new RequirementNotFoundError(`Requirement '${requirementId}' not found`);
    }

    const currentStatus = this.normalizeStatus(req.status);
    const customerId = req.job?.customer_id;

    const check = this.canTransition(currentStatus, action, actor, customerId);
    if (!check.allowed) {
      if (check.reason?.includes("Forbidden")) {
        throw new RequirementAuthorizationError(check.reason);
      }
      throw new RequirementInvalidTransitionError(currentStatus, action, check.reason);
    }

    const rule = REQUIREMENT_TRANSITION_TABLE[currentStatus]![action]!;
    const targetStatus = typeof rule.targetStatus === "function"
      ? rule.targetStatus({ requirement: req, action, actor, newFilledCount })
      : rule.targetStatus;

    const updateData: Record<string, any> = {
      status: targetStatus,
      updated_at: new Date(),
    };

    if (newFilledCount !== undefined) {
      updateData.worker_count_filled = newFilledCount;
    }

    const updated = await tx.job_requirement.update({
      where: { id: requirementId },
      data: updateData,
    });

    const capacity = calculateRequirementCapacity(
      updated.worker_count_needed,
      updated.worker_count_filled ?? 0
    );

    return {
      requirement: updated,
      previousStatus: currentStatus,
      currentStatus: targetStatus,
      action,
      capacity,
    };
  },

  /**
   * Authoritatively reconciles requirement filled capacity from active bookings.
   */
  async reconcileCapacity(
    tx: Prisma.TransactionClient,
    requirementId: string
  ): Promise<RequirementCapacity> {
    const req = await tx.job_requirement.findUnique({
      where: { id: requirementId },
    });
    if (!req) {
      throw new RequirementNotFoundError(`Requirement '${requirementId}' not found`);
    }

    // Count authoritative active bookings
    const activeBookingsCount = await tx.booking.count({
      where: {
        requirement_id: requirementId,
        status: { in: Array.from(ACTIVE_BOOKING_STATUSES) },
      },
    });

    const capacity = calculateRequirementCapacity(req.worker_count_needed, activeBookingsCount);

    let nextStatus: RequirementStatus;
    const currentStatus = this.normalizeStatus(req.status);

    if (currentStatus === RequirementStatus.CANCELLED) {
      nextStatus = RequirementStatus.CANCELLED;
    } else if (capacity.isFilled) {
      nextStatus = RequirementStatus.FILLED;
    } else if (capacity.isPartiallyFilled) {
      nextStatus = RequirementStatus.PARTIALLY_FILLED;
    } else if (currentStatus === RequirementStatus.DISPATCHING) {
      nextStatus = RequirementStatus.DISPATCHING;
    } else {
      nextStatus = RequirementStatus.OPEN;
    }

    await tx.job_requirement.update({
      where: { id: requirementId },
      data: {
        worker_count_filled: activeBookingsCount,
        status: nextStatus,
        updated_at: new Date(),
      },
    });

    return capacity;
  },

  /**
   * Updates worker demand for a requirement, preventing demand < filled capacity.
   */
  async updateDemand(
    tx: Prisma.TransactionClient,
    requirementId: string,
    newWorkerCountNeeded: number,
    actor: RequirementTransitionActor
  ): Promise<{ requirement: any; capacity: RequirementCapacity }> {
    if (!Number.isInteger(newWorkerCountNeeded) || newWorkerCountNeeded <= 0) {
      throw new RequirementInvalidWorkerCountError("worker_count_needed must be an integer >= 1");
    }

    const req = await tx.job_requirement.findUnique({
      where: { id: requirementId },
      include: { job: { select: { customer_id: true } } },
    });

    if (!req) throw new RequirementNotFoundError(`Requirement '${requirementId}' not found`);

    if (actor.role === UserRole.CUSTOMER && req.job?.customer_id && actor.id !== req.job.customer_id) {
      throw new RequirementAuthorizationError("Forbidden: You do not own this requirement");
    }

    const currentStatus = this.normalizeStatus(req.status);
    if (currentStatus === RequirementStatus.CANCELLED) {
      throw new RequirementInvalidTransitionError(
        currentStatus,
        RequirementAction.UPDATE_DEMAND,
        "Cannot update worker demand for a cancelled requirement"
      );
    }

    const filled = req.worker_count_filled ?? 0;
    if (newWorkerCountNeeded < filled) {
      throw new RequirementCapacityExceededError(
        `Cannot reduce required workers to ${newWorkerCountNeeded} because ${filled} worker(s) are already booked`
      );
    }

    const capacity = calculateRequirementCapacity(newWorkerCountNeeded, filled);
    let targetStatus = currentStatus;
    if (capacity.isFilled) {
      targetStatus = RequirementStatus.FILLED;
    } else if (capacity.isPartiallyFilled && currentStatus === RequirementStatus.FILLED) {
      targetStatus = RequirementStatus.PARTIALLY_FILLED;
    }

    const updated = await tx.job_requirement.update({
      where: { id: requirementId },
      data: {
        worker_count_needed: newWorkerCountNeeded,
        status: targetStatus,
        updated_at: new Date(),
      },
    });

    return { requirement: updated, capacity };
  },
};
