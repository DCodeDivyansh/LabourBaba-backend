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
    const role = String(actor?.role || "").toLowerCase();

    if (role === "admin") {
      return { allowed: true };
    }

    if (role === "customer" && booking.customer_id === actor.id) {
      return { allowed: true };
    }

    if (role === "worker" && booking.worker_id === actor.id) {
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
    return this.canReadConversation(actor, booking);
  },

  /**
   * Only the booking customer, assigned worker, or admin may join a booking socket room.
   */
  canJoinRoom(actor: AuthenticatedUser, booking: ChatBookingResource): PolicyDecision {
    const decision = this.canReadConversation(actor, booking);
    if (!decision.allowed) {
      return {
        ...decision,
        reason: "Forbidden: Not an authorized participant of this booking",
      };
    }
    return decision;
  },

  /**
   * Database-level Prisma query scope for reading conversation messages.
   */
  scopeBooking(actor: AuthenticatedUser, bookingId: string): Record<string, any> {
    const role = String(actor?.role || "").toLowerCase();

    if (role === "admin") {
      return { id: bookingId };
    }

    if (role === "customer") {
      return {
        id: bookingId,
        customer_id: actor.id,
      };
    }

    if (role === "worker") {
      return {
        id: bookingId,
        worker_id: actor.id,
      };
    }

    return { id: "00000000-0000-0000-0000-000000000000" };
  },
};
