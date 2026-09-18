import { AuthenticatedUser, UserRole, PolicyDecision } from "./types";

export interface DispatchResource {
  id?: string;
  requirement_id: string;
  worker_id: string;
  status?: string | null;
  expires_at?: Date | null;
}

export const dispatchPolicy = {
  /**
   * Only the targeted worker or admin may view dispatch details.
   */
  canRead(actor: AuthenticatedUser, dispatch: DispatchResource): PolicyDecision {
    if (actor.role === UserRole.ADMIN) {
      return { allowed: true };
    }

    if (actor.role === UserRole.WORKER) {
      if (dispatch.worker_id === actor.id) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: "Dispatch not found",
        statusCode: 404,
        code: "RESOURCE_NOT_FOUND",
      };
    }

    return {
      allowed: false,
      reason: "Forbidden: Insufficient permissions",
      statusCode: 403,
      code: "ROLE_FORBIDDEN",
    };
  },

  /**
   * Only the notified worker may accept the dispatch slot.
   */
  canAccept(actor: AuthenticatedUser, dispatch: DispatchResource): PolicyDecision {
    if (actor.role !== UserRole.WORKER) {
      return {
        allowed: false,
        reason: "Forbidden: Only workers can accept dispatch slots",
        statusCode: 403,
        code: "ROLE_FORBIDDEN",
      };
    }

    if (dispatch.worker_id !== actor.id) {
      return {
        allowed: false,
        reason: "Forbidden: This dispatch was not offered to you",
        statusCode: 403,
        code: "NOT_ASSIGNED_WORKER",
      };
    }

    return { allowed: true };
  },

  /**
   * Only the notified worker may decline the dispatch slot.
   */
  canDecline(actor: AuthenticatedUser, dispatch: DispatchResource): PolicyDecision {
    if (actor.role !== UserRole.WORKER) {
      return {
        allowed: false,
        reason: "Forbidden: Only workers can decline dispatch slots",
        statusCode: 403,
        code: "ROLE_FORBIDDEN",
      };
    }

    if (dispatch.worker_id !== actor.id) {
      return {
        allowed: false,
        reason: "Forbidden: This dispatch was not offered to you",
        statusCode: 403,
        code: "NOT_ASSIGNED_WORKER",
      };
    }

    return { allowed: true };
  },

  /**
   * Database-level Prisma query scope for reading worker dispatches.
   */
  scopeRead(actor: AuthenticatedUser, requirementId?: string): Record<string, any> {
    const requirementFilter = requirementId ? { requirement_id: requirementId } : {};

    if (actor.role === UserRole.ADMIN) {
      return requirementFilter;
    }

    if (actor.role === UserRole.WORKER) {
      return {
        ...requirementFilter,
        worker_id: actor.id,
      };
    }

    return { id: "00000000-0000-0000-0000-000000000000" };
  },
};
