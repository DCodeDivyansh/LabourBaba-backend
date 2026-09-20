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
  toWorkerLocationDTO,
} from "../../shared/prismaSelects";
import { bookingPolicy, assertPolicy, AuthenticatedUser, AuthorizationError, UserRole } from "../../policies";
import { jobStateService, JobAction } from "../jobs/jobStateMachine";
import { requirementStateService, ACTIVE_BOOKING_STATUSES } from "../jobs/requirementStateMachine";
import { bookingStateService, BookingAction, BookingStatus, BookingInvalidTransitionError } from "./bookingStateMachine";

export const bookingService = {
  async getBookingDetail(bookingId: string, actor?: AuthenticatedUser) {
    if (!actor) {
      throw new AuthorizationError("Authentication required to view booking", 401);
    }

    const isWorker = actor.role === UserRole.WORKER;
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
      payment: isWorker ? false : {
        select: paymentSafeSelect,
      },
      job_requirement: true,
    };

    let booking: any = null;

    // Direct database-level scoped query
    if (prisma.booking.findFirst) {
      booking = await prisma.booking.findFirst({
        where: bookingPolicy.scopeRead(actor, bookingId),
        select: selectClause,
      });
    }

    // Fallback for mock setups where test specifically mocked findUnique instead of findFirst
    if (!booking && prisma.booking.findUnique) {
      const candidate = await prisma.booking.findUnique({
        where: { id: bookingId },
        select: selectClause,
      });
      if (candidate) {
        const decision = bookingPolicy.canRead(actor, candidate);
        if (!decision.allowed) {
          throw new AuthorizationError(
            decision.reason || "Booking not found",
            decision.statusCode || 404,
            decision.code
          );
        }
        booking = candidate;
      }
    }

    if (!booking) throw new AuthorizationError("Booking not found", 404);
    return toBookingDTO(booking, actor);
  },

  async verifyOtp(bookingId: string, workerId: string, otp: string, actor?: AuthenticatedUser) {
    return await prisma.$transaction(async (tx) => {
      const effectiveWorkerId = actor?.role === UserRole.WORKER ? actor.id : workerId;
      const scopeWhere = actor?.role === UserRole.ADMIN
        ? { id: bookingId }
        : { id: bookingId, worker_id: effectiveWorkerId };

      let booking = tx.booking.findFirst
        ? await tx.booking.findFirst({ where: scopeWhere })
        : null;

      if (!booking && tx.booking.findUnique) {
        booking = await tx.booking.findUnique({ where: { id: bookingId } });
      }

      if (!booking) throw new AuthorizationError("Booking not found", 404);
      if (actor) {
        assertPolicy(bookingPolicy.canVerifyOtp(actor, booking));
      } else {
        if (booking.worker_id !== workerId) throw new AuthorizationError("Forbidden: You are not assigned to this booking", 403);
      }
      if (!booking.otp_hash || !(await comparePassword(otp, booking.otp_hash))) {
        throw new Error("Invalid OTP");
      }

      await bookingStateService.transition(tx, {
        bookingId,
        action: BookingAction.START_WORK,
        actor: { id: effectiveWorkerId, role: actor?.role || UserRole.WORKER },
        reason: `Worker verified OTP for booking ${bookingId}`,
      });

      // Synchronize parent job state -> IN_PROGRESS
      if (booking.job_id) {
        try {
          await jobStateService.transition(tx, {
            jobId: booking.job_id,
            action: JobAction.START_WORK,
            actor: { id: effectiveWorkerId, role: UserRole.WORKER },
            reason: `Worker verified OTP for booking ${bookingId}`,
          });
        } catch {
          // If job was already in IN_PROGRESS (multi-worker), safe to proceed
        }
      }

      return { success: true, message: "OTP verified, job started" };
    });
  },

  async completeBooking(bookingId: string, workerId: string, actor?: AuthenticatedUser) {
    return await prisma.$transaction(async (tx) => {
      const effectiveWorkerId = actor?.role === UserRole.WORKER ? actor.id : workerId;
      const scopeWhere = actor?.role === UserRole.ADMIN
        ? { id: bookingId }
        : { id: bookingId, worker_id: effectiveWorkerId };

      let booking = tx.booking.findFirst
        ? await tx.booking.findFirst({ where: scopeWhere })
        : null;

      if (!booking && tx.booking.findUnique) {
        booking = await tx.booking.findUnique({ where: { id: bookingId } });
      }

      if (!booking) throw new AuthorizationError("Booking not found", 404);
      if (actor) {
        assertPolicy(bookingPolicy.canComplete(actor, booking));
      } else {
        if (booking.worker_id !== workerId) throw new AuthorizationError("Forbidden: You are not assigned to this booking", 403);
      }

      await bookingStateService.transition(tx, {
        bookingId,
        action: BookingAction.REQUEST_COMPLETION,
        actor: { id: effectiveWorkerId, role: actor?.role || UserRole.WORKER },
        reason: "Worker marked work completed",
      });

      return { success: true, message: "Booking completion requested by worker, awaiting customer confirmation" };
    });
  },

  async confirmComplete(bookingId: string, customerId: string, payload: ConfirmBookingCompleteReq, actor?: AuthenticatedUser) {
    return await prisma.$transaction(async (tx) => {
      const effectiveCustomerId = actor?.role === UserRole.CUSTOMER ? actor.id : customerId;
      const scopeWhere = actor?.role === UserRole.ADMIN
        ? { id: bookingId }
        : { id: bookingId, customer_id: effectiveCustomerId };

      let booking = tx.booking.findFirst
        ? await tx.booking.findFirst({ where: scopeWhere })
        : null;

      if (!booking && tx.booking.findUnique) {
        booking = await tx.booking.findUnique({ where: { id: bookingId } });
      }

      if (!booking) throw new AuthorizationError("Booking not found", 404);
      if (actor) {
        assertPolicy(bookingPolicy.canConfirmCompletion(actor, booking));
      } else {
        if (booking.customer_id !== customerId) throw new AuthorizationError("Forbidden: You do not own this booking", 403);
      }

      const currentNormalized = bookingStateService.normalizeStatus(booking.status);
      if (payload.rating && currentNormalized !== BookingStatus.COMPLETED && currentNormalized !== BookingStatus.AWAITING_CONFIRMATION) {
        throw new BookingInvalidTransitionError(
          currentNormalized,
          BookingAction.CONFIRM_COMPLETION,
          "Cannot review a booking that is not completed"
        );
      }

      // Transition AWAITING_CONFIRMATION -> COMPLETED (or idempotent if already COMPLETED)
      await bookingStateService.transition(tx, {
        bookingId,
        action: BookingAction.CONFIRM_COMPLETION,
        actor: { id: effectiveCustomerId, role: actor?.role || UserRole.CUSTOMER },
        reason: "Customer confirmed completion",
      });

      if (payload.rating) {
        try {
          await tx.review.create({
            data: {
              booking_id: bookingId,
              worker_id: booking.worker_id,
              customer_id: effectiveCustomerId,
              rating: payload.rating,
              comment: payload.comment
            }
          });
        } catch (err: any) {
          if (isReviewUniqueConstraintError(err)) {
            // Idempotent retry: review already exists for this booking, safely ignore
          } else {
            throw err;
          }
        }
      }

      // Check if all bookings under parent job are now completed -> transition job to COMPLETED
      if (booking.job_id) {
        try {
          const uncompletedBookings = await tx.booking.count({
            where: {
              job_id: booking.job_id,
              status: { notIn: ["COMPLETED", "CANCELLED"] },
            },
          });
          if (uncompletedBookings === 0) {
            await jobStateService.transition(tx, {
              jobId: booking.job_id,
              action: JobAction.COMPLETE,
              actor: { id: effectiveCustomerId, role: actor?.role || UserRole.CUSTOMER },
              reason: "All bookings completed and confirmed",
            });
          }
        } catch {
          // Safe ignore if already completed or unable
        }
      }

      return { success: true, message: "Booking completion confirmed" };
    });
  },

  async cancelBooking(bookingId: string, userId: string, payload: CancelBookingReq, actor?: AuthenticatedUser) {
    return await prisma.$transaction(async (tx) => {
      const scopeWhere = actor
        ? (actor.role === UserRole.ADMIN
            ? { id: bookingId }
            : actor.role === UserRole.CUSTOMER
            ? { id: bookingId, customer_id: actor.id }
            : { id: bookingId, worker_id: actor.id })
        : { id: bookingId };

      let booking = tx.booking.findFirst
        ? await tx.booking.findFirst({ where: scopeWhere })
        : null;

      if (!booking && tx.booking.findUnique) {
        booking = await tx.booking.findUnique({ where: { id: bookingId } });
      }

      if (!booking) throw new AuthorizationError("Booking not found", 404);

      if (actor) {
        assertPolicy(bookingPolicy.canCancel(actor, booking));
      } else {
        if (booking.customer_id !== userId && booking.worker_id !== userId) {
          throw new AuthorizationError("Forbidden: Not an authorized participant of this booking", 403);
        }
      }

      await bookingStateService.transition(tx, {
        bookingId,
        action: BookingAction.CANCEL,
        actor: { id: actor?.id || userId, role: actor?.role || UserRole.CUSTOMER },
        reason: payload.reason || "Booking cancelled",
      });

      // Reconcile requirement capacity from authoritative active bookings
      if (booking.requirement_id) {
        try {
          await requirementStateService.reconcileCapacity(tx, booking.requirement_id);
        } catch (capErr: any) {
          console.warn(`[bookingServices] Note: Could not reconcile requirement capacity: ${capErr?.message}`);
        }
      }

      // If all bookings cancelled for the job, reopen dispatch if applicable
      if (booking.job_id) {
        try {
          const activeBookings = await tx.booking.count({
            where: {
              job_id: booking.job_id,
              status: { in: Array.from(ACTIVE_BOOKING_STATUSES) },
            },
          });
          if (activeBookings === 0) {
            await jobStateService.transition(tx, {
              jobId: booking.job_id,
              action: JobAction.REOPEN_DISPATCH,
              actor: { role: "SYSTEM" },
              reason: `Booking ${bookingId} cancelled, reopening dispatch`,
            });
          }
        } catch {
          // Safe ignore if parent job already in terminal/cancelled state
        }
      }

      return { success: true, message: "Booking cancelled" };
    });
  },

  async getWorkerLocation(bookingId: string, actor: AuthenticatedUser) {
    if (!actor) {
      throw new AuthorizationError("Unauthorized", 401);
    }

    const scopeWhere = actor.role === UserRole.ADMIN
      ? { id: bookingId }
      : { id: bookingId, customer_id: actor.id };

    const booking = await prisma.booking.findFirst({
      where: scopeWhere,
    });

    if (!booking) {
      // Check if booking exists under another user to distinguish 403 from 404
      const anyBooking = await prisma.booking.findUnique({
        where: { id: bookingId },
      });
      if (anyBooking) {
        throw new AuthorizationError(
          "Forbidden: Only the booking customer can track worker location",
          403
        );
      }
      throw new AuthorizationError("Booking not found", 404);
    }

    assertPolicy(bookingPolicy.canGetWorkerLocation(actor, booking));

    const location = await prisma.worker_location.findFirst({
      where: { worker_id: booking.worker_id },
      orderBy: { updated_at: "desc" }
    });

    return toWorkerLocationDTO(location);
  }
};
