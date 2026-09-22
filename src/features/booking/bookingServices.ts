import prisma from "../../config/prisma";
import { Prisma } from "@prisma/client";
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
import { jobStateService, JobAction, JobStatus, JobInvalidTransitionError } from "../jobs/jobStateMachine";
import { requirementStateService, ACTIVE_BOOKING_STATUSES } from "../jobs/requirementStateMachine";
import { bookingConfig } from "../../config/bookingConfig";
import {
  bookingStateService,
  BookingAction,
  BookingStatus,
  BookingInvalidTransitionError,
  BookingOtpError,
  BookingOtpInvalidError,
  BookingOtpExpiredError,
  BookingOtpLockedError,
  BookingOtpAlreadyConsumedError,
  BookingOtpWrongStateError,
} from "./bookingStateMachine";
import { logger } from "../../utils/logger";

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
    if (typeof prisma.booking.findFirst === "function") {
      booking = await prisma.booking.findFirst({
        where: bookingPolicy.scopeRead(actor, bookingId),
        select: selectClause,
      });
    }

    if (!booking && typeof prisma.booking.findUnique === "function") {
      // Mock fallback with explicit ABAC policy evaluation
      const candidate = await prisma.booking.findUnique({
        where: { id: bookingId },
        select: selectClause,
      });
      if (candidate) {
        assertPolicy(bookingPolicy.canRead(actor, candidate));
        booking = candidate;
      }
    }

    if (!booking) throw new AuthorizationError("Booking not found", 404);
    return toBookingDTO(booking, actor);
  },

  async verifyOtp(bookingId: string, workerId: string, otp: string, actor?: AuthenticatedUser) {
    return await prisma.$transaction(async (tx) => {
      const effectiveWorkerId = actor?.role === UserRole.WORKER ? actor.id : workerId;

      // 1. Acquire row lock and fetch latest booking record scoped to assigned worker
      let lockedBooking: any = null;
      try {
        if (typeof (tx as any).$queryRaw === "function") {
          const rows = await (tx as any).$queryRaw`
            SELECT id, status, otp_hash, otp_expires_at, otp_attempts, otp_locked_at, otp_consumed_at, otp_verified, worker_id, customer_id, job_id
            FROM "booking"
            WHERE id = ${bookingId}::uuid
              ${actor?.role === UserRole.ADMIN ? Prisma.empty : Prisma.sql`AND worker_id = ${effectiveWorkerId}::uuid`}
            FOR UPDATE
          `;
          if (Array.isArray(rows) && rows.length > 0) {
            lockedBooking = rows[0];
          }
        }
      } catch {
        lockedBooking = null;
      }

      if (!lockedBooking) {
        const scopeWhere = actor?.role === UserRole.ADMIN
          ? { id: bookingId }
          : { id: bookingId, worker_id: effectiveWorkerId };
        if (typeof (tx.booking as any)?.findFirst === "function") {
          lockedBooking = await (tx.booking as any).findFirst({ where: scopeWhere });
        }
        if (!lockedBooking && typeof (tx.booking as any)?.findUnique === "function") {
          const candidate = await (tx.booking as any).findUnique({ where: { id: bookingId } });
          if (candidate) {
            if (actor) {
              assertPolicy(bookingPolicy.canVerifyOtp(actor, candidate));
            } else if (candidate.worker_id !== effectiveWorkerId) {
              throw new AuthorizationError("Forbidden: You are not assigned to this booking", 403);
            }
            lockedBooking = candidate;
          }
        }
      }

      if (!lockedBooking) throw new AuthorizationError("Booking not found", 404);

      // 2. Authorization check
      if (actor) {
        assertPolicy(bookingPolicy.canVerifyOtp(actor, lockedBooking));
      } else {
        if (lockedBooking.worker_id !== workerId) {
          throw new AuthorizationError("Forbidden: You are not assigned to this booking", 403);
        }
      }

      // 3. State check: pre-verification state is strictly CONFIRMED
      const currentStatus = bookingStateService.normalizeStatus(lockedBooking.status);
      if (currentStatus !== BookingStatus.CONFIRMED) {
        throw new BookingOtpWrongStateError(
          `Cannot verify OTP: Booking is in status '${currentStatus}', expected '${BookingStatus.CONFIRMED}'`
        );
      }

      // 4. Consumption check
      if (lockedBooking.otp_consumed_at != null || lockedBooking.otp_verified === true) {
        throw new BookingOtpAlreadyConsumedError("Booking OTP has already been verified and consumed");
      }

      // 5. Lockout / attempt exhaustion check
      const currentAttempts = lockedBooking.otp_attempts ?? 0;
      if (lockedBooking.otp_locked_at != null || currentAttempts >= bookingConfig.bookingOtpMaxAttempts) {
        throw new BookingOtpLockedError(
          "Maximum verification attempts exceeded. Booking OTP is locked."
        );
      }

      // 6. Expiration check
      if (lockedBooking.otp_expires_at != null && Date.now() > new Date(lockedBooking.otp_expires_at).getTime()) {
        throw new BookingOtpExpiredError("Booking OTP has expired");
      }

      // 7. Verify hash
      let isValid = false;
      if (lockedBooking.otp_hash) {
        try {
          isValid = await comparePassword(otp, lockedBooking.otp_hash);
        } catch {
          isValid = false;
        }
      }

      // 8. Handle invalid OTP (increment attempts, lock if max exceeded)
      if (!isValid) {
        const newAttempts = currentAttempts + 1;
        const isNowLocked = newAttempts >= bookingConfig.bookingOtpMaxAttempts;
        const now = new Date();

        if (typeof (tx.booking as any)?.update === "function") {
          await (tx.booking as any).update({
            where: { id: bookingId },
            data: {
              otp_attempts: newAttempts,
              ...(isNowLocked ? { otp_locked_at: now } : {}),
              updated_at: now,
            },
          });
        }

        if (isNowLocked) {
          throw new BookingOtpLockedError(
            "Maximum verification attempts exceeded. Booking OTP is locked."
          );
        }

        throw new BookingOtpInvalidError("Invalid OTP");
      }

      // 9. Transition booking state -> IN_PROGRESS
      await bookingStateService.transition(tx, {
        bookingId,
        action: BookingAction.START_WORK,
        actor: { id: effectiveWorkerId, role: actor?.role || UserRole.WORKER },
        reason: `Worker verified OTP for booking ${bookingId}`,
      });

      // Synchronize parent job state -> IN_PROGRESS (Issue 14: Cross-entity transition)
      if (lockedBooking.job_id) {
        try {
          await jobStateService.transition(tx, {
            jobId: lockedBooking.job_id,
            action: JobAction.START_WORK,
            actor: { id: effectiveWorkerId, role: UserRole.WORKER },
            reason: `Worker verified OTP for booking ${bookingId}`,
          });
        } catch (err: any) {
          // P4 Issue 14: Only suppress explicitly proven idempotent conditions.
          // For multi-worker jobs, if the parent job is ALREADY in IN_PROGRESS, JobInvalidTransitionError is idempotent.
          if (err instanceof JobInvalidTransitionError && err.fromStatus === JobStatus.IN_PROGRESS) {
            // Idempotent: another worker on the same job already moved parent job to IN_PROGRESS
          } else {
            // Unexpected database/Prisma/domain error MUST propagate to abort the transaction!
            throw err;
          }
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

      let booking: any = null;
      if (typeof tx.booking.findFirst === "function") {
        booking = await tx.booking.findFirst({ where: scopeWhere });
      } else if (typeof tx.booking.findUnique === "function") {
        const candidate = await tx.booking.findUnique({ where: { id: bookingId } });
        if (candidate && (actor?.role === UserRole.ADMIN || candidate.worker_id === effectiveWorkerId)) {
          booking = candidate;
        }
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

      let booking: any = null;
      if (typeof tx.booking.findFirst === "function") {
        booking = await tx.booking.findFirst({ where: scopeWhere });
      } else if (typeof tx.booking.findUnique === "function") {
        const candidate = await tx.booking.findUnique({ where: { id: bookingId } });
        if (candidate && (actor?.role === UserRole.ADMIN || candidate.customer_id === effectiveCustomerId)) {
          booking = candidate;
        }
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

      // Check if all bookings under parent job are now completed -> transition job to COMPLETED (Issue 14)
      if (booking.job_id) {
        const uncompletedBookings = await tx.booking.count({
          where: {
            job_id: booking.job_id,
            status: { notIn: ["COMPLETED", "CANCELLED"] },
          },
        });
        if (uncompletedBookings === 0) {
          try {
            await jobStateService.transition(tx, {
              jobId: booking.job_id,
              action: JobAction.COMPLETE,
              actor: { id: effectiveCustomerId, role: actor?.role || UserRole.CUSTOMER },
              reason: "All bookings completed and confirmed",
            });
          } catch (err: any) {
            // P4 Issue 14: Only ignore if job is already COMPLETED (idempotent completion)
            if (err instanceof JobInvalidTransitionError && err.fromStatus === JobStatus.COMPLETED) {
              // Idempotent retry: job is already completed
            } else {
              // Any unexpected database/Prisma/domain error MUST propagate!
              throw err;
            }
          }
        }
      }

      return { success: true, message: "Booking completion confirmed" };
    });
  },

  async cancelBooking(bookingId: string, userId: string, payload: CancelBookingReq, actor?: AuthenticatedUser) {
    return await prisma.$transaction(async (tx) => {
      const effectiveActorId = actor?.id || userId;
      const effectiveRole = actor?.role || UserRole.CUSTOMER;

      // 1. Acquire exclusive row lock scoped to authorized participant
      let lockedBooking: any = null;
      try {
        if (typeof (tx as any).$queryRaw === "function") {
          const rows = await (tx as any).$queryRaw`
            SELECT id, status, customer_id, worker_id, job_id, requirement_id, cancelled_at, cancelled_by, cancellation_reason
            FROM "booking"
            WHERE id = ${bookingId}::uuid
              ${
                effectiveRole === UserRole.ADMIN
                  ? Prisma.empty
                  : effectiveRole === UserRole.WORKER
                  ? Prisma.sql`AND worker_id = ${effectiveActorId}::uuid`
                  : Prisma.sql`AND customer_id = ${effectiveActorId}::uuid`
              }
            FOR UPDATE
          `;
          if (Array.isArray(rows) && rows.length > 0) {
            lockedBooking = rows[0];
          }
        }
      } catch {
        lockedBooking = null;
      }

      if (!lockedBooking) {
        const scopeWhere = effectiveRole === UserRole.ADMIN
          ? { id: bookingId }
          : effectiveRole === UserRole.WORKER
          ? { id: bookingId, worker_id: effectiveActorId }
          : { id: bookingId, customer_id: effectiveActorId };

        if (typeof (tx.booking as any)?.findFirst === "function") {
          lockedBooking = await (tx.booking as any).findFirst({ where: scopeWhere });
        } else if (typeof (tx.booking as any)?.findUnique === "function") {
          const candidate = await (tx.booking as any).findUnique({ where: { id: bookingId } });
          if (
            candidate &&
            (effectiveRole === UserRole.ADMIN ||
              (effectiveRole === UserRole.WORKER && candidate.worker_id === effectiveActorId) ||
              (effectiveRole === UserRole.CUSTOMER && candidate.customer_id === effectiveActorId))
          ) {
            lockedBooking = candidate;
          }
        }
      }

      if (!lockedBooking) throw new AuthorizationError("Booking not found", 404);

      // 2. Authorization check
      if (actor) {
        assertPolicy(bookingPolicy.canCancel(actor, lockedBooking));
      } else {
        if (lockedBooking.customer_id !== userId && lockedBooking.worker_id !== userId) {
          throw new AuthorizationError("Forbidden: Not an authorized participant of this booking", 403);
        }
      }

      // 3. Reason validation: non-empty, trimmed
      const trimmedReason = payload.reason?.trim();
      if (!trimmedReason) {
        throw new BookingInvalidTransitionError(
          lockedBooking.status,
          BookingAction.CANCEL,
          "Cancellation reason is required and cannot be empty"
        );
      }

      // 4. Transition booking to CANCELLED (handles state verification, metadata stamping, audit event)
      const transitionResult = await bookingStateService.transition(tx, {
        bookingId,
        action: BookingAction.CANCEL,
        actor: { id: effectiveActorId, role: effectiveRole },
        reason: trimmedReason,
      });

      // 5. Reconcile side effects if not idempotent retry
      if (!transitionResult.isIdempotent) {
        // Reconcile requirement capacity from authoritative active bookings
        if (lockedBooking.requirement_id) {
          // This is part of the cancellation's durable capacity release. Do
          // not swallow failures: committing a cancelled booking with stale
          // capacity can subsequently permit an overbooking.
          await requirementStateService.reconcileCapacity(tx, lockedBooking.requirement_id);
        }

        // Reconcile worker dispatch record
        if (lockedBooking.requirement_id && lockedBooking.worker_id) {
          if (typeof (tx as any).job_dispatch?.updateMany === "function") {
            await (tx as any).job_dispatch.updateMany({
              where: {
                requirement_id: lockedBooking.requirement_id,
                worker_id: lockedBooking.worker_id,
                status: { in: ['accepted', 'pending'] },
              },
              data: {
                status: 'cancelled',
                responded_at: new Date(),
              },
            });
          }
        }

        // If all bookings cancelled for the job, reopen dispatch if applicable
        if (lockedBooking.job_id) {
          const activeBookings = await tx.booking.count({
            where: {
              job_id: lockedBooking.job_id,
              status: { in: Array.from(ACTIVE_BOOKING_STATUSES) },
            },
          });
          if (activeBookings === 0) {
            try {
              await jobStateService.transition(tx, {
                jobId: lockedBooking.job_id,
                action: JobAction.REOPEN_DISPATCH,
                actor: { role: "SYSTEM" },
                reason: `Booking ${bookingId} cancelled, reopening dispatch`,
              });
            } catch (err: any) {
              // P4 Issue 14: Safe ignore only if parent job already in terminal/cancelled or dispatching state
              if (
                err instanceof JobInvalidTransitionError &&
                (err.fromStatus === JobStatus.CANCELLED ||
                  err.fromStatus === JobStatus.DISPATCHING ||
                  err.fromStatus === JobStatus.COMPLETED)
              ) {
                // Safe idempotent ignore
              } else {
                throw err;
              }
            }
          }
        }
      }

      return {
        success: true,
        message: "Booking cancelled",
        data: toBookingDTO(transitionResult.booking, actor),
      };
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
      throw new AuthorizationError("Forbidden: Only the booking customer can track worker location", 403);
    }

    assertPolicy(bookingPolicy.canGetWorkerLocation(actor, booking));

    const workerCoords = await prisma.$queryRaw<Array<{
      latitude: number | null;
      longitude: number | null;
      updated_at: Date | null;
    }>>`
      SELECT ST_Y(location_geo::geometry) AS latitude,
             ST_X(location_geo::geometry) AS longitude,
             last_location_at AS updated_at
      FROM worker
      WHERE id = ${booking.worker_id}::uuid
    `;

    const row = workerCoords?.[0];
    if (!row || row.latitude === null || row.longitude === null) {
      const location = await prisma.worker_location.findFirst({
        where: { worker_id: booking.worker_id },
        orderBy: { updated_at: "desc" }
      });
      return toWorkerLocationDTO(location);
    }

    return toWorkerLocationDTO({
      worker_id: booking.worker_id,
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      updated_at: row.updated_at,
    });
  }
};
