import { AuthenticatedUser, UserRole, PolicyDecision } from "./types";

export interface JobResource {
  id: string;
  customer_id: string;
  status?: string | null;
  booking?: Array<{ worker_id: string }>;
  job_requirement?: Array<{
    job_dispatch?: Array<{ worker_id: string }>;
  }>;
}

export const jobPolicy = {
  /**
   * Only authenticated customers may create jobs.
   */
  canCreate(actor: AuthenticatedUser): PolicyDecision {
    if (actor.role !== UserRole.CUSTOMER) {
      return {
        allowed: false,
        reason: "Forbidden: Only customers can create jobs",
        statusCode: 403,
        code: "ROLE_FORBIDDEN",
      };
    }
    return { allowed: true };
  },

  /**
   * A customer may read their own job.
   * A worker may read a job only if they have an active booking or dispatch for it.
   * An admin may read any job.
   */
  canRead(actor: AuthenticatedUser, job: JobResource): PolicyDecision {
    if (actor.role === UserRole.ADMIN) {
      return { allowed: true };
    }

    if (actor.role === UserRole.CUSTOMER) {
      if (job.customer_id === actor.id) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: "Job not found",
        statusCode: 404,
        code: "RESOURCE_NOT_FOUND",
      };
    }

    if (actor.role === UserRole.WORKER) {
      const hasBooking = job.booking?.some((b) => b.worker_id === actor.id);
      const hasDispatch = job.job_requirement?.some((req) =>
        req.job_dispatch?.some((d) => d.worker_id === actor.id)
      );
      if (hasBooking || hasDispatch) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: "Job not found",
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
   * Only the job owner (customer) or an admin can cancel a job.
   * Workers cannot cancel customer jobs.
   */
  canCancel(actor: AuthenticatedUser, job: JobResource): PolicyDecision {
    if (actor.role === UserRole.ADMIN) {
      return { allowed: true };
    }

    if (actor.role === UserRole.CUSTOMER) {
      if (job.customer_id !== actor.id) {
        return {
          allowed: false,
          reason: "Forbidden: You do not own this job",
          statusCode: 403,
          code: "NOT_OWNER",
        };
      }
      if (job.status === "COMPLETED" || job.status === "CANCELLED") {
        return {
          allowed: false,
          reason: `Cannot cancel a ${job.status?.toLowerCase()} job`,
          statusCode: 403,
          code: "INVALID_STATE",
        };
      }
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: "Forbidden: Insufficient permissions",
      statusCode: 403,
      code: "ROLE_FORBIDDEN",
    };
  },

  /**
   * Only the owning customer or admin may add requirements to an existing job.
   */
  canCreateRequirement(actor: AuthenticatedUser, job: JobResource): PolicyDecision {
    if (actor.role === UserRole.ADMIN) {
      return { allowed: true };
    }

    if (actor.role === UserRole.CUSTOMER) {
      if (job.customer_id === actor.id) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: "Forbidden: You do not own this job",
        statusCode: 403,
        code: "NOT_OWNER",
      };
    }

    return {
      allowed: false,
      reason: "Forbidden: Only customers can add requirements to jobs",
      statusCode: 403,
      code: "ROLE_FORBIDDEN",
    };
  },

  /**
   * Only the owning customer or admin may view all bookings under a job.
   * Workers only have access to their own booking, not the full job roster.
   */
  canReadBookings(actor: AuthenticatedUser, job: JobResource): PolicyDecision {
    if (actor.role === UserRole.ADMIN) {
      return { allowed: true };
    }

    if (actor.role === UserRole.CUSTOMER) {
      if (job.customer_id === actor.id) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: "Job not found",
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
   * Database-level Prisma query scope for reading a single job.
   */
  scopeRead(actor: AuthenticatedUser, jobId?: string): Record<string, any> {
    const idFilter = jobId ? { id: jobId } : {};

    if (actor.role === UserRole.ADMIN) {
      return idFilter;
    }

    if (actor.role === UserRole.CUSTOMER) {
      return {
        ...idFilter,
        customer_id: actor.id,
      };
    }

    if (actor.role === UserRole.WORKER) {
      return {
        ...idFilter,
        OR: [
          { booking: { some: { worker_id: actor.id } } },
          { job_requirement: { some: { job_dispatch: { some: { worker_id: actor.id } } } } },
        ],
      };
    }

    // Default deny
    return { id: "00000000-0000-0000-0000-000000000000" };
  },

  /**
   * Database-level Prisma query scope for listing jobs.
   */
  scopeList(actor: AuthenticatedUser, filterCustomerId?: string): Record<string, any> {
    if (actor.role === UserRole.ADMIN) {
      return filterCustomerId ? { customer_id: filterCustomerId } : {};
    }

    if (actor.role === UserRole.CUSTOMER) {
      return { customer_id: actor.id };
    }

    if (actor.role === UserRole.WORKER) {
      return {
        OR: [
          { booking: { some: { worker_id: actor.id } } },
          { job_requirement: { some: { job_dispatch: { some: { worker_id: actor.id } } } } },
        ],
      };
    }

    return { id: "00000000-0000-0000-0000-000000000000" };
  },
};
