import { AuthenticatedUser, UserRole, PolicyDecision } from "./types";

export const workerPolicy = {
  /**
   * Only the worker themselves or an admin can access full private profile data.
   */
  canReadSelf(actor: AuthenticatedUser, targetWorkerId: string): PolicyDecision {
    if (actor.role === UserRole.ADMIN) {
      return { allowed: true };
    }

    if (actor.role === UserRole.WORKER && actor.id === targetWorkerId) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: "Forbidden: Cannot access another worker's profile",
      statusCode: 403,
      code: "NOT_OWNER",
    };
  },

  /**
   * Only the authenticated worker themselves can update their profile.
   */
  canUpdateSelf(actor: AuthenticatedUser, targetWorkerId: string): PolicyDecision {
    if (actor.role === UserRole.WORKER && actor.id === targetWorkerId) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: "Forbidden: Cannot update another worker's profile",
      statusCode: 403,
      code: "NOT_OWNER",
    };
  },

  /**
   * Only the authenticated worker can update their live location.
   */
  canUpdateLocation(actor: AuthenticatedUser, targetWorkerId: string): PolicyDecision {
    if (actor.role === UserRole.WORKER && actor.id === targetWorkerId) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: "Forbidden: Only the authenticated worker can update their location",
      statusCode: 403,
      code: "NOT_OWNER",
    };
  },

  /**
   * Worker documents (Aadhaar, IDs) are private.
   * Only the owning worker or an authorized admin can view documents.
   * Customers are STRICTLY FORBIDDEN.
   */
  canReadDocuments(actor: AuthenticatedUser, targetWorkerId: string): PolicyDecision {
    if (String(actor.role).toLowerCase() === UserRole.ADMIN) {
      return { allowed: true };
    }

    if (String(actor.role).toLowerCase() === UserRole.WORKER && actor.id === targetWorkerId) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: "Forbidden: Cannot access worker private documents",
      statusCode: 403,
      code: "DOCUMENT_ACCESS_DENIED",
    };
  },

  /**
   * Only the owning worker or an authorized admin can access a specific worker document.
   * Customers or other workers are STRICTLY FORBIDDEN.
   */
  canReadDocument(actor: AuthenticatedUser, document: { id: string; worker_id: string }): PolicyDecision {
    if (String(actor.role).toLowerCase() === UserRole.ADMIN) {
      return { allowed: true };
    }

    if (String(actor.role).toLowerCase() === UserRole.WORKER && actor.id === document.worker_id) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: "Forbidden: Cannot access another worker's document",
      statusCode: 403,
      code: "DOCUMENT_ACCESS_DENIED",
    };
  },

  /**
   * Only the owning worker or an administrator can delete a worker document.
   */
  canDeleteDocument(actor: AuthenticatedUser, document: { id: string; worker_id: string }): PolicyDecision {
    if (String(actor.role).toLowerCase() === UserRole.ADMIN) {
      return { allowed: true };
    }

    if (String(actor.role).toLowerCase() === UserRole.WORKER && actor.id === document.worker_id) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: "Forbidden: Cannot delete another worker's document",
      statusCode: 403,
      code: "DOCUMENT_ACCESS_DENIED",
    };
  },

  /**
   * Only the authenticated worker may upload documents to their own account.
   */
  canUploadDocuments(actor: AuthenticatedUser, targetWorkerId: string): PolicyDecision {
    if (actor.role === UserRole.WORKER && actor.id === targetWorkerId) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: "Forbidden: Cannot upload documents for another worker",
      statusCode: 403,
      code: "NOT_OWNER",
    };
  },

  /**
   * Only an administrator may verify or reject worker documents.
   */
  canAdminVerify(actor: AuthenticatedUser): PolicyDecision {
    if (actor.role === UserRole.ADMIN) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: "Forbidden: Administrator role required to verify worker documents",
      statusCode: 403,
      code: "ROLE_FORBIDDEN",
    };
  },

  /**
   * Only an administrator may suspend a worker.
   */
  canAdminSuspend(actor: AuthenticatedUser): PolicyDecision {
    if (actor.role === UserRole.ADMIN) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: "Forbidden: Administrator role required to suspend workers",
      statusCode: 403,
      code: "ROLE_FORBIDDEN",
    };
  },

  /**
   * Joining a worker-specific socket room.
   */
  canJoinRoom(actor: AuthenticatedUser, targetWorkerId: string): PolicyDecision {
    if (actor.role === UserRole.ADMIN) {
      return { allowed: true };
    }

    if (actor.role === UserRole.WORKER && actor.id === targetWorkerId) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: "Forbidden: Cannot join another worker's socket room",
      statusCode: 403,
      code: "FORBIDDEN",
    };
  },
};
