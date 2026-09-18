import prisma from "../../config/prisma";
import { SendMessageReq } from "../../type/api_req.type";
import { chatPolicy, assertPolicy, AuthenticatedUser } from "../../policies";

export const chatService = {
  async getOrCreateConversation(bookingId: string) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId }
    });
    if (!booking) throw new Error("Booking not found");

    let conversation = await prisma.conversation.findFirst({
      where: { booking_id: bookingId }
    });

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          booking_id: bookingId,
          customer_id: booking.customer_id,
          worker_id: booking.worker_id
        }
      });
    }

    return conversation;
  },

  async getMessages(bookingId: string, actor?: AuthenticatedUser) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, customer_id: true, worker_id: true },
    });
    if (!booking) throw new Error("Booking not found");

    if (actor) {
      assertPolicy(chatPolicy.canReadConversation(actor, booking));
    }

    const conversation = await this.getOrCreateConversation(bookingId);
    return await prisma.message.findMany({
      where: { conversation_id: conversation.id },
      orderBy: { sent_at: "asc" }
    });
  },

  async sendMessage(bookingId: string, senderId: string, content: string, actor?: AuthenticatedUser) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, customer_id: true, worker_id: true },
    });
    if (!booking) throw new Error("Booking not found");

    if (actor) {
      assertPolicy(chatPolicy.canSendMessage(actor, booking));
    } else {
      if (booking.worker_id !== senderId && booking.customer_id !== senderId) {
        throw new Error("Forbidden: Not an authorized participant of this conversation");
      }
    }

    const conversation = await this.getOrCreateConversation(bookingId);
    const message = await prisma.message.create({
      data: {
        conversation_id: conversation.id,
        sender_id: senderId,
        content: content
      }
    });

    return message;
  }
};
