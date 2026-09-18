import { AuthenticatedUser, UserRole, PolicyDecision } from "./types";

export interface ChatBookingResource {
  id: string;
  customer_id: string;
  worker_id: string;
}

export const chatPolicy = {
  /**
   * Only the booking customer, assigned worker, or admin may read messages.
   */
  canReadConversation(actor: AuthenticatedUser, booking: ChatBookingResource): PolicyDecision {
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
      reason: "Forbidden: Not an authorized participant of this conversation",
      statusCode: 403,
      code: "NOT_PARTICIPANT",
    };
  },

  /**
   * Only the booking customer, assigned worker, or admin may send messages.
   */
  canSendMessage(actor: AuthenticatedUser, booking: ChatBookingResource): PolicyDecision {
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
      reason: "Forbidden: Not an authorized participant of this conversation",
      statusCode: 403,
      code: "NOT_PARTICIPANT",
    };
  },

  /**
   * Only the booking customer, assigned worker, or admin may join a booking socket room.
   */
  canJoinRoom(actor: AuthenticatedUser, booking: ChatBookingResource): PolicyDecision {
    return this.canReadConversation(actor, booking);
  },

  /**
   * Database-level Prisma query scope for reading conversation messages.
   */
  scopeBooking(actor: AuthenticatedUser, bookingId: string): Record<string, any> {
    if (actor.role === UserRole.ADMIN) {
      return { id: bookingId };
    }

    if (actor.role === UserRole.CUSTOMER) {
      return {
        id: bookingId,
        customer_id: actor.id,
      };
    }

    if (actor.role === UserRole.WORKER) {
      return {
        id: bookingId,
        worker_id: actor.id,
      };
    }

    return { id: "00000000-0000-0000-0000-000000000000" };
  },
};
