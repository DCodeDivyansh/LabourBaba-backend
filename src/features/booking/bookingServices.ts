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
import { bookingPolicy, assertPolicy, AuthenticatedUser } from "../../policies";

export const bookingService = {
  async getBookingDetail(bookingId: string, actor?: AuthenticatedUser) {
    const selectClause = {
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
    };

    let booking: any = null;

    // Direct database-level scoped query
    if (actor && prisma.booking.findFirst) {
      booking = await prisma.booking.findFirst({
        where: bookingPolicy.scopeRead(actor, bookingId),
        select: selectClause,
      });
    }

    // Fallback for mock setups or direct lookups
    if (!booking && prisma.booking.findUnique) {
      booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        select: selectClause,
      });
      if (booking && actor) {
        assertPolicy(bookingPolicy.canRead(actor, booking));
      }
    }

    if (!booking) throw new Error("Booking not found");
    return toBookingDTO(booking);
  },

  async verifyOtp(bookingId: string, workerId: string, otp: string, actor?: AuthenticatedUser) {
    return await prisma.$transaction(async (tx) => {
      const booking = tx.booking.findUnique
        ? await tx.booking.findUnique({ where: { id: bookingId } })
        : await tx.booking.findFirst({ where: { id: bookingId } });
      if (!booking) throw new Error("Booking not found");
      if (actor) {
        assertPolicy(bookingPolicy.canVerifyOtp(actor, booking));
      } else {
        if (booking.worker_id !== workerId) throw new Error("Booking not found for this worker");
      }
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

  async completeBooking(bookingId: string, workerId: string, actor?: AuthenticatedUser) {
    return await prisma.$transaction(async (tx) => {
      const booking = tx.booking.findUnique
        ? await tx.booking.findUnique({ where: { id: bookingId } })
        : await tx.booking.findFirst({ where: { id: bookingId } });
      if (!booking) throw new Error("Booking not found");
      if (actor) {
        assertPolicy(bookingPolicy.canComplete(actor, booking));
      } else {
        if (booking.worker_id !== workerId) throw new Error("Booking not found for this worker");
      }
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

  async confirmComplete(bookingId: string, customerId: string, payload: ConfirmBookingCompleteReq, actor?: AuthenticatedUser) {
    return await prisma.$transaction(async (tx) => {
      const booking = tx.booking.findUnique
        ? await tx.booking.findUnique({ where: { id: bookingId } })
        : await tx.booking.findFirst({ where: { id: bookingId } });
      if (!booking) throw new Error("Booking not found");
      if (actor) {
        assertPolicy(bookingPolicy.canConfirmCompletion(actor, booking));
      } else {
        if (booking.customer_id !== customerId) throw new Error("Booking not found");
      }

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

  async cancelBooking(bookingId: string, userId: string, payload: CancelBookingReq, actor?: AuthenticatedUser) {
    return await prisma.$transaction(async (tx) => {
      const booking = tx.booking.findUnique
        ? await tx.booking.findUnique({ where: { id: bookingId } })
        : await tx.booking.findFirst({ where: { id: bookingId } });
      if (!booking) throw new Error("Booking not found");
      if (actor) {
        assertPolicy(bookingPolicy.canCancel(actor, booking));
      } else {
        if (booking.customer_id !== userId && booking.worker_id !== userId) {
          throw new Error("Forbidden: Not an authorized participant of this booking");
        }
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
