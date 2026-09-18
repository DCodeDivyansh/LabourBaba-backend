import { AuthenticatedUser, UserRole, PolicyDecision } from "./types";

export interface PaymentBookingResource {
  id: string;
  customer_id: string;
  worker_id?: string;
  status?: string | null;
}

export const paymentPolicy = {
  /**
   * Only the customer who owns the booking can create a payment order.
   */
  canCreateOrder(actor: AuthenticatedUser, booking: PaymentBookingResource): PolicyDecision {
    if (actor.role !== UserRole.CUSTOMER) {
      return {
        allowed: false,
        reason: "Forbidden: Only customers can create payment orders",
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
   * Only the booking customer or admin may view payment details.
   * Workers are forbidden from accessing customer payment records.
   */
  canRead(actor: AuthenticatedUser, booking: PaymentBookingResource): PolicyDecision {
    if (actor.role === UserRole.ADMIN) {
      return { allowed: true };
    }

    if (actor.role === UserRole.CUSTOMER && booking.customer_id === actor.id) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: "Forbidden: Insufficient permissions to view payment",
      statusCode: 403,
      code: "FORBIDDEN",
    };
  },

  /**
   * Only the booking customer or admin may initiate a refund.
   */
  canRefund(actor: AuthenticatedUser, booking: PaymentBookingResource): PolicyDecision {
    if (actor.role === UserRole.ADMIN) {
      return { allowed: true };
    }

    if (actor.role === UserRole.CUSTOMER && booking.customer_id === actor.id) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: "Forbidden: Only the booking customer can request a refund",
      statusCode: 403,
      code: "NOT_OWNER",
    };
  },

  /**
   * Database-level Prisma query scope for reading payments.
   */
  scopeRead(actor: AuthenticatedUser, bookingId: string): Record<string, any> {
    if (actor.role === UserRole.ADMIN) {
      return { booking_id: bookingId };
    }

    if (actor.role === UserRole.CUSTOMER) {
      return {
        booking_id: bookingId,
        booking: {
          customer_id: actor.id,
        },
      };
    }

    return { id: "00000000-0000-0000-0000-000000000000" };
  },
};
