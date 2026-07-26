import prisma from "../../config/prisma";

export const paymentService = {
  async createOrder(bookingId: string, amount: number) {
    // Mock Razorpay Order Creation
    const orderId = `order_${Math.random().toString(36).substring(7)}`;

    return await prisma.payment.create({
      data: {
        booking_id: bookingId,
        amount: amount,
        razorpay_order_id: orderId,
        status: "PENDING"
      }
    });
  },

  async handleWebhook(payload: any) {
    // Mock webhook handler for Razorpay
    // Assume payload contains { event: 'payment.captured', payload: { payment: { entity: { order_id: '...' } } } }
    const event = payload.event;
    if (event === "payment.captured") {
      const orderId = payload.payload?.payment?.entity?.order_id;
      if (orderId) {
        await prisma.payment.updateMany({
          where: { razorpay_order_id: orderId },
          data: { status: "COMPLETED" }
        });
      }
    } else if (event === "payment.failed") {
      const orderId = payload.payload?.payment?.entity?.order_id;
      if (orderId) {
        await prisma.payment.updateMany({
          where: { razorpay_order_id: orderId },
          data: { status: "FAILED" }
        });
      }
    }
    return { success: true };
  },

  async getPaymentStatus(bookingId: string) {
    return await prisma.payment.findMany({
      where: { booking_id: bookingId }
    });
  },

  async refundPayment(bookingId: string) {
    // Mock Refund logic
    const payment = await prisma.payment.findFirst({
      where: { booking_id: bookingId, status: "COMPLETED" }
    });

    if (!payment) throw new Error("No completed payment found for this booking");

    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: "REFUNDED" }
    });

    return { success: true, message: "Refund initiated successfully" };
  }
};
