import prisma from "../../config/prisma";
import { chatPolicy, assertPolicy, AuthenticatedUser, AuthorizationError } from "../../policies";

export interface BookingParticipantContext {
  customer_id: string;
  worker_id: string;
}

export const chatService = {
  /**
   * Resolves existing conversation or creates one for the booking.
   * Accepts pre-authorized booking context to eliminate redundant database queries.
   */
  async getOrCreateConversation(bookingId: string, bookingContext?: BookingParticipantContext) {
    let context = bookingContext;

    if (!context) {
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        select: { customer_id: true, worker_id: true },
      });
      if (!booking) {
        throw new AuthorizationError("Booking not found", 404, "RESOURCE_NOT_FOUND");
      }
      context = booking;
    }

    let conversation = await prisma.conversation.findFirst({
      where: { booking_id: bookingId },
    });

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          booking_id: bookingId,
          customer_id: context.customer_id,
          worker_id: context.worker_id,
        },
      });
    }

    return conversation;
  },

  /**
   * Retrieves chat message history for an authorized participant.
   * Pushes down participant query scoping to PostgreSQL and evaluates chatPolicy.
   */
  async getMessages(bookingId: string, actor?: AuthenticatedUser) {
    if (!actor) {
      throw new AuthorizationError("Authentication required", 401, "UNAUTHORIZED");
    }

    let booking: any = null;

    // 1. Query-level pushdown authorization
    if (prisma.booking.findFirst) {
      booking = await prisma.booking.findFirst({
        where: chatPolicy.scopeBooking(actor, bookingId),
        select: { id: true, customer_id: true, worker_id: true },
      });
    }

    // 2. Mock / fallback resolution with explicit policy assertion
    if (!booking && prisma.booking.findUnique) {
      const rawBooking = await prisma.booking.findUnique({
        where: { id: bookingId },
        select: { id: true, customer_id: true, worker_id: true },
      });
      if (rawBooking) {
        assertPolicy(chatPolicy.canReadConversation(actor, rawBooking));
        booking = rawBooking;
      }
    }

    if (!booking) {
      throw new AuthorizationError("Booking not found", 404, "RESOURCE_NOT_FOUND");
    }

    const conversation = await this.getOrCreateConversation(bookingId, booking);

    return await prisma.message.findMany({
      where: { conversation_id: conversation.id },
      orderBy: { sent_at: "asc" },
    });
  },

  /**
   * Sends a chat message to an authorized booking conversation.
   * Enforces server-derived authoritative sender identity from actor.id.
   * Client-supplied sender IDs are strictly ignored and cannot override actor.id.
   */
  async sendMessage(
    bookingId: string,
    senderId: string,
    content: string,
    actor?: AuthenticatedUser
  ) {
    if (!actor) {
      throw new AuthorizationError("Authentication required", 401, "UNAUTHORIZED");
    }

    let booking: any = null;

    // 1. Query-level pushdown authorization
    if (prisma.booking.findFirst) {
      booking = await prisma.booking.findFirst({
        where: chatPolicy.scopeBooking(actor, bookingId),
        select: { id: true, customer_id: true, worker_id: true },
      });
    }

    // 2. Mock / fallback resolution with explicit policy assertion
    if (!booking && prisma.booking.findUnique) {
      const rawBooking = await prisma.booking.findUnique({
        where: { id: bookingId },
        select: { id: true, customer_id: true, worker_id: true },
      });
      if (rawBooking) {
        assertPolicy(chatPolicy.canSendMessage(actor, rawBooking));
        booking = rawBooking;
      }
    }

    if (!booking) {
      throw new AuthorizationError("Booking not found", 404, "RESOURCE_NOT_FOUND");
    }

    const conversation = await this.getOrCreateConversation(bookingId, booking);

    // NON-NEGOTIABLE: Authoritative sender identity is ALWAYS actor.id
    const message = await prisma.message.create({
      data: {
        conversation_id: conversation.id,
        sender_id: actor.id,
        content: content.trim(),
      },
    });

    return message;
  },
};
