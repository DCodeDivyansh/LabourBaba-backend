import prisma from "../../config/prisma";
import { CreateReviewReq } from "../../type/api_req.type";

export const reviewService = {
  async createReview(bookingId: string, customerId: string, payload: CreateReviewReq) {
    const booking = await prisma.booking.findFirst({
      where: { id: bookingId, customer_id: customerId }
    });

    if (!booking) throw new Error("Booking not found");

    return await prisma.review.create({
      data: {
        booking_id: bookingId,
        worker_id: booking.worker_id,
        customer_id: customerId,
        rating: payload.rating,
        comment: payload.comment
      }
    });
  },

  async getWorkerReviews(workerId: string) {
    return await prisma.review.findMany({
      where: { worker_id: workerId }
    });
  },

  async getBookingReview(bookingId: string) {
    return await prisma.review.findFirst({
      where: { booking_id: bookingId }
    });
  }
};
