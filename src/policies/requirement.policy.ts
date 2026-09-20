import { AuthenticatedUser, UserRole, PolicyDecision } from "./types";

export interface RequirementResource {
  id: string;
  job_id: string;
  job?: {
    customer_id: string;
  };
  job_dispatch?: Array<{ worker_id: string }>;
  booking?: Array<{ worker_id: string }>;
}

export const requirementPolicy = {
  /**
   * Customer owning parent job, Worker legitimately dispatched/booked, or Admin can read a requirement.
   */
  canRead(actor: AuthenticatedUser, requirement: RequirementResource): PolicyDecision {
    if (actor.role === UserRole.ADMIN) {
      return { allowed: true };
    }

    if (actor.role === UserRole.CUSTOMER) {
      if (requirement.job && requirement.job.customer_id === actor.id) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: "Requirement not found",
        statusCode: 404,
        code: "RESOURCE_NOT_FOUND",
      };
    }

    if (actor.role === UserRole.WORKER) {
      const hasDispatch = requirement.job_dispatch?.some((d) => d.worker_id === actor.id);
      const hasBooking = requirement.booking?.some((b) => b.worker_id === actor.id);
      if (hasDispatch || hasBooking) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: "Requirement not found",
        statusCode: 404,
        code: "RESOURCE_NOT_FOUND",
      };
    }

    return {
      allowed: false,
      reason: "Forbidden: Insufficient permissions",
      statusCode: 403,
      code: "FORBIDDEN",
    };
  },

  /**
   * Only the owning customer or admin can update a requirement's demand.
   */
  canUpdate(actor: AuthenticatedUser, requirement: RequirementResource): PolicyDecision {
    if (actor.role === UserRole.ADMIN) {
      return { allowed: true };
    }

    if (actor.role === UserRole.CUSTOMER) {
      if (requirement.job && requirement.job.customer_id === actor.id) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: "Forbidden: You do not own this requirement",
        statusCode: 403,
        code: "NOT_OWNER",
      };
    }

    return {
      allowed: false,
      reason: "Forbidden: Insufficient permissions to update requirement",
      statusCode: 403,
      code: "ROLE_FORBIDDEN",
    };
  },

  /**
   * Database-level Prisma query scope for reading a requirement.
   */
  scopeRead(actor: AuthenticatedUser, requirementId?: string): Record<string, any> {
    const idFilter = requirementId ? { id: requirementId } : {};

    if (actor.role === UserRole.ADMIN) {
      return idFilter;
    }

    if (actor.role === UserRole.CUSTOMER) {
      return {
        ...idFilter,
        job: {
          customer_id: actor.id,
        },
      };
    }

    if (actor.role === UserRole.WORKER) {
      return {
        ...idFilter,
        OR: [
          { booking: { some: { worker_id: actor.id } } },
          { job_dispatch: { some: { worker_id: actor.id } } },
        ],
      };
    }

    return { id: "00000000-0000-0000-0000-000000000000" };
  },
};
