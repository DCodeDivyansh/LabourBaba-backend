import prisma from "../../config/prisma";
import { comparePassword } from "../../utils/authUtils";
import { CancelBookingReq, ConfirmBookingCompleteReq } from "../../type/api_req.type";
import { isReviewUniqueConstraintError } from "../review/reviewServices";
import {
  bookingSafeSelect,
  workerPublicSelect,
  customerSummarySelect,
  paymentSafeSelect,
  toBookingDTO,
} from "../../shared/prismaSelects";

export const bookingService = {
  async getBookingDetail(bookingId: string) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        ...bookingSafeSelect,
        job: true,
        worker: {
          select: workerPublicSelect,
        },
        customer: {
          select: customerSummarySelect,
        },
        review: true,
        payment: {
          select: paymentSafeSelect,
        },
        job_requirement: true,
      },
    });
    if (!booking) throw new Error("Booking not found");
    return toBookingDTO(booking);
  },

  async verifyOtp(bookingId: string, workerId: string, otp: string) {
    return await prisma.$transaction(async (tx) => {
      const booking = await tx.booking.findFirst({
        where: { id: bookingId, worker_id: workerId }
      });
      if (!booking) throw new Error("Booking not found for this worker");
      if (!booking.otp_hash || !(await comparePassword(otp, booking.otp_hash))) {
        throw new Error("Invalid OTP");
      }

      await tx.booking.update({
        where: { id: bookingId },
        data: { status: "IN_PROGRESS", otp_verified: true }
      });

      return { success: true, message: "OTP verified, job started" };
    });
  },

  async completeBooking(bookingId: string, workerId: string) {
    return await prisma.$transaction(async (tx) => {
      const booking = await tx.booking.findFirst({
        where: { id: bookingId, worker_id: workerId }
      });
      if (!booking) throw new Error("Booking not found");
      if (booking.status !== "IN_PROGRESS") throw new Error("Booking is not in progress");

      // In real scenario, wait for customer confirmation. We mark it as COMPLETED here or AWAITING_CONFIRM
      // For this spec, we just set it to COMPLETED
      await tx.booking.update({
        where: { id: bookingId },
        data: { status: "COMPLETED" }
      });

      return { success: true, message: "Booking completed by worker" };
    });
  },

  async confirmComplete(bookingId: string, customerId: string, payload: ConfirmBookingCompleteReq) {
    return await prisma.$transaction(async (tx) => {
      const booking = await tx.booking.findFirst({
        where: { id: bookingId, customer_id: customerId }
      });
      if (!booking) throw new Error("Booking not found");

      if (payload.rating) {
        if (booking.status !== "COMPLETED") {
          throw new Error("Cannot review a booking that is not completed");
        }

        try {
          await tx.review.create({
            data: {
              booking_id: bookingId,
              worker_id: booking.worker_id,
              customer_id: customerId,
              rating: payload.rating,
              comment: payload.comment
            }
          });
        } catch (err: any) {
          // If a review already exists (e.g. repeated confirmation request), do not fail the confirmation
          if (isReviewUniqueConstraintError(err)) {
            // Idempotent retry: review already exists for this booking, safely ignore
          } else {
            throw err;
          }
        }
      }

      return { success: true, message: "Booking completion confirmed" };
    });
  },

  async cancelBooking(bookingId: string, userId: string, payload: CancelBookingReq) {
    return await prisma.$transaction(async (tx) => {
      const booking = await tx.booking.findUnique({ where: { id: bookingId } });
      if (!booking) throw new Error("Booking not found");
      if (booking.customer_id !== userId && booking.worker_id !== userId) {
        throw new Error("Unauthorized");
      }

      await tx.booking.update({
        where: { id: bookingId },
        data: { status: "CANCELLED" }
      });

      // Optionally re-open requirement or penalize worker based on who canceled
      return { success: true, message: "Booking cancelled" };
    });
  },

  async getWorkerLocation(bookingId: string, customerId: string) {
    const booking = await prisma.booking.findFirst({
      where: { id: bookingId, customer_id: customerId }
    });
    if (!booking) throw new Error("Booking not found");

    const location = await prisma.worker_location.findFirst({
      where: { worker_id: booking.worker_id },
      orderBy: { updated_at: "desc" }
    });

    return location;
  }
};
