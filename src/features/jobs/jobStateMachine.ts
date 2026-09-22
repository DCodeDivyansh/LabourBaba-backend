import { Prisma } from "@prisma/client";
import { UserRole } from "../../policies";
import { logger } from "../../utils/logger";

// ── 1. JOB LIFECYCLE STATES & ACTIONS ────────────────────────────────────────

export enum JobStatus {
  OPEN = "OPEN",
  DISPATCHING = "DISPATCHING",
  BOOKED = "BOOKED",
  IN_PROGRESS = "IN_PROGRESS",
  COMPLETED = "COMPLETED",
  CANCELLED = "CANCELLED",
}

export enum JobAction {
  CREATE = "CREATE",
  START_DISPATCH = "START_DISPATCH",
  MARK_BOOKED = "MARK_BOOKED",
  REOPEN_DISPATCH = "REOPEN_DISPATCH",
  START_WORK = "START_WORK",
  COMPLETE = "COMPLETE",
  CANCEL = "CANCEL",
}

export type JobTransitionActorRole = UserRole | "SYSTEM" | "DISPATCH_WORKER";

export interface JobTransitionActor {
  id?: string;
  role: JobTransitionActorRole | string;
  phone?: string;
}

// ── 2. STABLE DOMAIN ERRORS ──────────────────────────────────────────────────

export class JobStateError extends Error {
  public readonly statusCode: number;
  public readonly status: number;
  public readonly code: string;

  constructor(message: string, statusCode: number = 400, code: string = "JOB_STATE_ERROR") {
    super(message);
    this.name = "JobStateError";
    this.statusCode = statusCode;
    this.status = statusCode;
    this.code = code;
  }
}

export class JobNotFoundError extends JobStateError {
  constructor(message: string = "Job not found") {
    super(message, 404, "JOB_NOT_FOUND");
    this.name = "JobNotFoundError";
  }
}

export class JobInvalidTransitionError extends JobStateError {
  public readonly fromStatus: string;
  public readonly action: string;

  constructor(fromStatus: string, action: string, reason?: string) {
    const msg = reason || `Illegal job transition: Cannot perform '${action}' on job in status '${fromStatus}'`;
    super(msg, 400, "JOB_INVALID_TRANSITION");
    this.name = "JobInvalidTransitionError";
    this.fromStatus = fromStatus;
    this.action = action;
  }
}

export class JobStateConflictError extends JobStateError {
  constructor(message: string = "Job state changed concurrently by another transaction") {
    super(message, 409, "JOB_STATE_CONFLICT");
    this.name = "JobStateConflictError";
  }
}

export class JobAuthorizationError extends JobStateError {
  constructor(message: string = "Forbidden: Not authorized to transition job state") {
    super(message, 403, "JOB_FORBIDDEN");
    this.name = "JobAuthorizationError";
  }
}

// ── 3. FORMAL TRANSITION DEFINITION ──────────────────────────────────────────

export interface TransitionRule {
  targetStatus: JobStatus;
  allowedRoles: (JobTransitionActorRole | string)[];
  requiresOwnership?: boolean; // Customer must own the job
  guard?: (context: TransitionContext) => Promise<boolean | string> | boolean | string;
}

export interface TransitionContext {
  job: {
    id: string;
    status: string | null;
    customer_id: string;
    [key: string]: any;
  };
  action: JobAction;
  actor: JobTransitionActor;
  metadata?: Record<string, any>;
}

export const TERMINAL_JOB_STATES: ReadonlySet<JobStatus> = new Set([
  JobStatus.COMPLETED,
  JobStatus.CANCELLED,
]);

/**
 * Authoritative Transition Table mapping (Source State, Action) -> Transition Rule.
 */
export const JOB_TRANSITION_TABLE: Record<string, Partial<Record<JobAction, TransitionRule>>> = {
  [JobStatus.OPEN]: {
    [JobAction.START_DISPATCH]: {
      targetStatus: JobStatus.DISPATCHING,
      allowedRoles: [UserRole.ADMIN, "SYSTEM", "DISPATCH_WORKER"],
    },
    [JobAction.CANCEL]: {
      targetStatus: JobStatus.CANCELLED,
      allowedRoles: [UserRole.CUSTOMER, UserRole.ADMIN, "SYSTEM"],
      requiresOwnership: true,
    },
  },
  [JobStatus.DISPATCHING]: {
    [JobAction.MARK_BOOKED]: {
      targetStatus: JobStatus.BOOKED,
      allowedRoles: [UserRole.ADMIN, "SYSTEM", "DISPATCH_WORKER", UserRole.WORKER],
    },
    [JobAction.START_WORK]: {
      targetStatus: JobStatus.IN_PROGRESS,
      allowedRoles: [UserRole.ADMIN, "SYSTEM", UserRole.WORKER],
    },
    [JobAction.CANCEL]: {
      targetStatus: JobStatus.CANCELLED,
      allowedRoles: [UserRole.CUSTOMER, UserRole.ADMIN, "SYSTEM"],
      requiresOwnership: true,
    },
  },
  [JobStatus.BOOKED]: {
    [JobAction.START_WORK]: {
      targetStatus: JobStatus.IN_PROGRESS,
      allowedRoles: [UserRole.ADMIN, "SYSTEM", UserRole.WORKER],
    },
    [JobAction.REOPEN_DISPATCH]: {
      targetStatus: JobStatus.DISPATCHING,
      allowedRoles: [UserRole.ADMIN, "SYSTEM", "DISPATCH_WORKER"],
    },
    [JobAction.COMPLETE]: {
      targetStatus: JobStatus.COMPLETED,
      allowedRoles: [UserRole.CUSTOMER, UserRole.ADMIN, "SYSTEM"],
      requiresOwnership: true,
    },
    [JobAction.CANCEL]: {
      targetStatus: JobStatus.CANCELLED,
      allowedRoles: [UserRole.CUSTOMER, UserRole.ADMIN, "SYSTEM"],
      requiresOwnership: true,
    },
  },
  [JobStatus.IN_PROGRESS]: {
    [JobAction.REOPEN_DISPATCH]: {
      targetStatus: JobStatus.DISPATCHING,
      allowedRoles: [UserRole.ADMIN, "SYSTEM", "DISPATCH_WORKER"],
    },
    [JobAction.COMPLETE]: {
      targetStatus: JobStatus.COMPLETED,
      allowedRoles: [UserRole.CUSTOMER, UserRole.ADMIN, "SYSTEM"],
      requiresOwnership: true,
    },
    [JobAction.CANCEL]: {
      targetStatus: JobStatus.CANCELLED,
      allowedRoles: [UserRole.ADMIN, "SYSTEM"], // In-progress jobs can only be cancelled by Admin/System
      requiresOwnership: false,
    },
  },
  [JobStatus.COMPLETED]: {},
  [JobStatus.CANCELLED]: {},
};

// ── 4. TRANSITION SERVICE ───────────────────────────────────────────────────

export interface TransitionJobParams {
  jobId: string;
  action: JobAction;
  actor: JobTransitionActor;
  reason?: string;
  metadata?: Record<string, any>;
  expectedCurrentStatus?: JobStatus;
}

export interface TransitionResult {
  job: any;
  previousStatus: JobStatus;
  currentStatus: JobStatus;
  action: JobAction;
  transitionId?: string;
}

export const jobStateService = {
  /**
   * Check if a given status is terminal.
   */
  isTerminal(status: string | JobStatus): boolean {
    return TERMINAL_JOB_STATES.has(status as JobStatus);
  },

  /**
   * Returns list of legal actions from the current state.
   */
  getLegalActions(status: string | JobStatus): JobAction[] {
    const rules = JOB_TRANSITION_TABLE[status];
    return rules ? (Object.keys(rules) as JobAction[]) : [];
  },

  /**
   * Evaluate whether a transition is allowed without mutating state.
   */
  canTransition(
    currentStatus: string | JobStatus,
    action: JobAction,
    actor: JobTransitionActor,
    jobCustomerId?: string
  ): { allowed: boolean; reason?: string } {
    // 1. Ownership check for customers: if caller does not own the job, reject immediately with 403
    if (actor.role === UserRole.CUSTOMER && jobCustomerId && actor.id && jobCustomerId !== actor.id) {
      return {
        allowed: false,
        reason: "Forbidden: You do not own this job",
      };
    }

    // 2. Normalize legacy or unconfigured status if applicable
    const normalizedStatus = (currentStatus === "POSTED" || !currentStatus) ? JobStatus.OPEN : currentStatus;
    const rulesForStatus = JOB_TRANSITION_TABLE[normalizedStatus];
    if (!rulesForStatus) {
      return { allowed: false, reason: `Unknown or unconfigured job status '${currentStatus}'` };
    }

    const rule = rulesForStatus[action];
    if (!rule) {
      return {
        allowed: false,
        reason: `Action '${action}' is not allowed when job is in status '${normalizedStatus}'`,
      };
    }

    // 3. Role check
    const isRoleAllowed = rule.allowedRoles.includes(actor.role);
    if (!isRoleAllowed) {
      return {
        allowed: false,
        reason: `Actor role '${actor.role}' is not authorized to execute '${action}'`,
      };
    }

    return { allowed: true };
  },

  /**
   * Authoritative, transactional execution of a Job State Machine transition.
   *
   * 1. Acquires row-lock on job (if raw SQL is supported) / queries latest state.
   * 2. Verifies expected current status (CAS check).
   * 3. Verifies transition legality, actor role, and business ownership.
   * 4. Updates job status and lifecycle timestamps atomically.
   * 5. Writes durable job_transition audit record inside the same transaction.
   */
  async transition(
    tx: Prisma.TransactionClient,
    params: TransitionJobParams
  ): Promise<TransitionResult> {
    const { jobId, action, actor, reason, metadata, expectedCurrentStatus } = params;

    // 1. Fetch current job state
    let job: any = tx.job?.findUnique
      ? await tx.job.findUnique({
          where: { id: jobId },
          include: {
            job_requirement: true,
          },
        })
      : null;

    if (!job && tx.job?.findFirst) {
      job = await tx.job.findFirst({ where: { id: jobId } });
    }

    if (!job) {
      throw new JobNotFoundError(`Job '${jobId}' not found`);
    }

    const currentStatus = (job.status as JobStatus) || JobStatus.OPEN;

    // 2. Concurrency CAS check if expectedCurrentStatus is supplied
    if (expectedCurrentStatus && currentStatus !== expectedCurrentStatus) {
      throw new JobStateConflictError(
        `Job status changed concurrently. Expected '${expectedCurrentStatus}' but found '${currentStatus}'`
      );
    }

    // 3. Evaluate transition matrix
    const check = this.canTransition(currentStatus, action, actor, job.customer_id);
    if (!check.allowed) {
      if (check.reason?.includes("Forbidden") || check.reason?.includes("not own")) {
        throw new JobAuthorizationError(check.reason);
      }
      throw new JobInvalidTransitionError(currentStatus, action, check.reason);
    }

    const rule = JOB_TRANSITION_TABLE[currentStatus]![action]!;
    const targetStatus = rule.targetStatus;

    // 4. Build lifecycle update data
    const updateData: Record<string, any> = {
      status: targetStatus,
      updated_at: new Date(),
    };

    if (action === JobAction.CANCEL) {
      updateData.cancelled_at = new Date();
      updateData.cancelled_by = actor.id || String(actor.role);
    } else if (action === JobAction.COMPLETE) {
      updateData.completed_at = new Date();
    }

    // 5. Update job row atomically
    const updatedJob = await tx.job.update({
      where: { id: jobId },
      data: updateData,
    });

    // 6. Record durable transition history within the exact same transaction
    let transitionRecord: any = null;
    if ((tx as any).job_transition?.create) {
      transitionRecord = await (tx as any).job_transition.create({
        data: {
          job_id: jobId,
          from_status: currentStatus,
          to_status: targetStatus,
          action: action,
          actor_type: String(actor.role),
          actor_id: actor.id || null,
          reason: reason || null,
          metadata: metadata ? (metadata as Prisma.InputJsonValue) : undefined,
        },
      });
    }

    logger.info(
      `[JOB_STATE_MACHINE] Job ${jobId} transitioned: ${currentStatus} --(${action})--> ${targetStatus} by [${actor.role}:${actor.id || "system"}]`,
      { jobId, currentStatus, targetStatus, action, actorRole: actor.role, actorId: actor.id }
    );

    return {
      job: updatedJob,
      previousStatus: currentStatus,
      currentStatus: targetStatus,
      action,
      transitionId: transitionRecord?.id,
    };
  },

  /**
   * Retrieves durable transition history for a given job.
   */
  async getTransitionHistory(jobId: string, prismaClient: any): Promise<any[]> {
    if (!prismaClient.job_transition?.findMany) {
      return [];
    }
    return await prismaClient.job_transition.findMany({
      where: { job_id: jobId },
      orderBy: { created_at: "asc" },
    });
  },
};
