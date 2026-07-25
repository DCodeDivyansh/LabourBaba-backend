import prisma from "../../config/prisma";
import { SendMessageReq } from "../../type/api_req.type";

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

  async getMessages(bookingId: string) {
    const conversation = await this.getOrCreateConversation(bookingId);
    return await prisma.message.findMany({
      where: { conversation_id: conversation.id },
      orderBy: { sent_at: "asc" }
    });
  },

  async sendMessage(bookingId: string, senderId: string, content: string) {
    const conversation = await this.getOrCreateConversation(bookingId);

    // Authorization check
    if (conversation.worker_id !== senderId && conversation.customer_id !== senderId) {
      throw new Error("Unauthorized");
    }

    const message = await prisma.message.create({
      data: {
        conversation_id: conversation.id,
        sender_id: senderId,
        content: content
      }
    });

    // In a real application, trigger socket.io event here for real-time delivery

    return message;
  }
};
