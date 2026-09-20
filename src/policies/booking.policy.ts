import { AuthenticatedUser, UserRole, PolicyDecision } from "./types";

export interface BookingResource {
  id: string;
  customer_id: string;
  worker_id: string;
  status?: string | null;
}

export const bookingPolicy = {
  /**
   * Customer who booked, Worker assigned, or Admin can read booking detail.
   */
  canRead(actor: AuthenticatedUser, booking: BookingResource): PolicyDecision {
    if (actor.role === UserRole.ADMIN) {
      return { allowed: true };
    }

    if (actor.role === UserRole.CUSTOMER) {
      if (booking.customer_id === actor.id) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: "Booking not found",
        statusCode: 404,
        code: "RESOURCE_NOT_FOUND",
      };
    }

    if (actor.role === UserRole.WORKER) {
      if (booking.worker_id === actor.id) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: "Booking not found",
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
   * Only the assigned worker may verify the OTP to begin the job.
   */
  canVerifyOtp(actor: AuthenticatedUser, booking: BookingResource): PolicyDecision {
    if (actor.role === UserRole.ADMIN) {
      return { allowed: true };
    }

    if (actor.role !== UserRole.WORKER) {
      return {
        allowed: false,
        reason: "Forbidden: Only assigned workers can verify job OTP",
        statusCode: 403,
        code: "ROLE_FORBIDDEN",
      };
    }

    if (booking.worker_id !== actor.id) {
      return {
        allowed: false,
        reason: "Forbidden: You are not assigned to this booking",
        statusCode: 403,
        code: "NOT_ASSIGNED_WORKER",
      };
    }

    return { allowed: true };
  },

  /**
   * Only the assigned worker may mark the booking complete.
   */
  canComplete(actor: AuthenticatedUser, booking: BookingResource): PolicyDecision {
    if (actor.role !== UserRole.WORKER) {
      return {
        allowed: false,
        reason: "Forbidden: Only assigned workers can mark jobs complete",
        statusCode: 403,
        code: "ROLE_FORBIDDEN",
      };
    }

    if (booking.worker_id !== actor.id) {
      return {
        allowed: false,
        reason: "Forbidden: You are not assigned to this booking",
        statusCode: 403,
        code: "NOT_ASSIGNED_WORKER",
      };
    }

    return { allowed: true };
  },

  /**
   * Only the booking customer may confirm completion and submit reviews.
   */
  canConfirmCompletion(actor: AuthenticatedUser, booking: BookingResource): PolicyDecision {
    if (actor.role !== UserRole.CUSTOMER) {
      return {
        allowed: false,
        reason: "Forbidden: Only customers can confirm booking completion",
        statusCode: 403,
        code: "ROLE_FORBIDDEN",
      };
    }

    if (booking.customer_id !== actor.id) {
      return {
        allowed: false,
        reason: "Forbidden: You do not own this booking",
        statusCode: 403,
        code: "NOT_OWNER",
      };
    }

    return { allowed: true };
  },

  /**
   * Either the customer or the worker assigned (or admin) may cancel the booking.
   */
  canCancel(actor: AuthenticatedUser, booking: BookingResource): PolicyDecision {
    if (actor.role === UserRole.ADMIN) {
      return { allowed: true };
    }

    if (actor.role === UserRole.CUSTOMER && booking.customer_id === actor.id) {
      return { allowed: true };
    }

    if (actor.role === UserRole.WORKER && booking.worker_id === actor.id) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: "Forbidden: You are not an authorized participant of this booking",
      statusCode: 403,
      code: "NOT_PARTICIPANT",
    };
  },

  /**
   * Only the booking customer or admin may view the assigned worker's live location.
   */
  canGetWorkerLocation(actor: AuthenticatedUser, booking: BookingResource): PolicyDecision {
    if (actor.role === UserRole.ADMIN) {
      return { allowed: true };
    }

    if (actor.role === UserRole.CUSTOMER && booking.customer_id === actor.id) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: "Forbidden: Only the booking customer can track worker location",
      statusCode: 403,
      code: "NOT_OWNER",
    };
  },

  /**
   * Database-level Prisma query scope for reading booking resources.
   */
  scopeRead(actor: AuthenticatedUser, bookingId?: string): Record<string, any> {
    const idFilter = bookingId ? { id: bookingId } : {};

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
        worker_id: actor.id,
      };
    }

    return { id: "00000000-0000-0000-0000-000000000000" };
  },
};
