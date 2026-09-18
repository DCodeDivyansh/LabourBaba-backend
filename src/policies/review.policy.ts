import { AuthenticatedUser, UserRole, PolicyDecision } from "./types";

export interface ReviewBookingResource {
  id: string;
  customer_id: string;
  worker_id: string;
  status?: string | null;
}

export const reviewPolicy = {
  /**
   * Only the customer who owns the completed booking can author a review.
   */
  canCreate(actor: AuthenticatedUser, booking: ReviewBookingResource): PolicyDecision {
    if (actor.role !== UserRole.CUSTOMER) {
      return {
        allowed: false,
        reason: "Forbidden: Only customers can write reviews",
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
   * The customer, assigned worker, or admin may read a booking's review.
   */
  canReadBookingReview(actor: AuthenticatedUser, booking: ReviewBookingResource): PolicyDecision {
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
      reason: "Forbidden: Not an authorized participant of this review",
      statusCode: 403,
      code: "NOT_PARTICIPANT",
    };
  },

  /**
   * Worker public reviews can be read by authenticated users.
   */
  canReadWorkerReviews(actor: AuthenticatedUser): PolicyDecision {
    if (!actor || !actor.id) {
      return {
        allowed: false,
        reason: "Unauthorized",
        statusCode: 403,
        code: "UNAUTHORIZED",
      };
    }
    return { allowed: true };
  },

  /**
   * Database-level Prisma query scope for reading a booking review.
   */
  scopeBookingReview(actor: AuthenticatedUser, bookingId: string): Record<string, any> {
    if (actor.role === UserRole.ADMIN) {
      return { booking_id: bookingId };
    }

    if (actor.role === UserRole.CUSTOMER) {
      return {
        booking_id: bookingId,
        customer_id: actor.id,
      };
    }

    if (actor.role === UserRole.WORKER) {
      return {
        booking_id: bookingId,
        worker_id: actor.id,
      };
    }

    return { id: "00000000-0000-0000-0000-000000000000" };
  },
};
