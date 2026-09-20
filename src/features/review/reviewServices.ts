import { Prisma } from "@prisma/client";
import prisma from "../../config/prisma";
import { CreateReviewReq } from "../../type/api_req.type";
import { reviewPolicy, PolicyActor, assertPolicy } from "../../policies";

export class ReviewError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(message: string, code: string, statusCode = 400) {
    super(message);
    this.name = "ReviewError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Returns true if the database error corresponds to the review booking_id unique constraint violation.
 * Precise matching ensures unrelated P2002 errors (e.g. on other models/fields) are NOT swallowed.
 */
export function isReviewUniqueConstraintError(err: any): boolean {
  if (!err) return false;
  const isP2002 =
    (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") ||
    err?.code === "P2002";

  if (isP2002) {
    const target = err.meta?.target;
    if (Array.isArray(target)) {
      return target.includes("booking_id") || target.some((t: string) => typeof t === "string" && (t.includes("booking") || t.includes("review")));
    }
    if (typeof target === "string") {
      return target.includes("booking_id") || target.includes("review");
    }
    if (typeof err.message === "string") {
      return (
        err.message.includes("review_booking_id_key") ||
        err.message.includes("uniq_review_booking") ||
        err.message.includes("booking_id") ||
        err.message.includes("review")
      );
    }
    return false;
  }

  // PostgreSQL native unique_violation error code 23505
  if (err?.code === "23505") {
    if (
      err.constraint === "uniq_review_booking" ||
      err.constraint === "review_booking_id_key" ||
      (typeof err.detail === "string" && err.detail.includes("booking_id"))
    ) {
      return true;
    }
  }

  // Not explicit P2002 code, check message string for PostgreSQL unique violation text
  if (typeof err?.message === "string") {
    return (
      err.message.includes("review_booking_id_key") ||
      err.message.includes("uniq_review_booking") ||
      (err.message.includes("Unique constraint failed") && err.message.includes("booking_id"))
    );
  }

  return false;
}

export const reviewService = {
  /**
   * Create a review for a completed booking authored by the authenticated customer.
   *
   * Invariants enforced:
   * 1. Authorship: author is strictly derived from the authenticated customer principal.
   * 2. Ownership: booking must belong to the customer (scoped query + 403 if booking belongs to another customer).
   * 3. Lifecycle State: booking status must be 'COMPLETED' (terminal reviewable state).
   * 4. Worker Identity: derived from the booking server-side (never client-supplied).
   * 5. Uniqueness: exactly one review per booking enforced by both application check and DB UNIQUE constraint.
   */
  async createReview(bookingId: string, customerId: string, payload: CreateReviewReq) {
    // 1. Ownership & existence check
    const booking = await prisma.booking.findFirst({
      where: { id: bookingId, customer_id: customerId }
    });

    if (!booking) {
      // Check if booking exists under another customer to distinguish 403 Forbidden from 404 Not Found
      const bookingExists = await prisma.booking.findUnique({
        where: { id: bookingId }
      });
      if (bookingExists) {
        throw new ReviewError(
          "Forbidden: You are not authorized to review a booking you do not own",
          "FORBIDDEN_BOOKING_ACCESS",
          403
        );
      }
      throw new ReviewError("Booking not found", "BOOKING_NOT_FOUND", 404);
    }

    // 2. Terminal reviewable state check
    if (booking.status !== "COMPLETED") {
      throw new ReviewError(
        `Booking cannot be reviewed in status '${booking.status}'. Reviews are only permitted for completed bookings.`,
        "BOOKING_NOT_COMPLETED",
        409
      );
    }

    // 3. Application-level duplicate pre-check
    const existingReview = await prisma.review.findFirst({
      where: { booking_id: bookingId }
    });
    if (existingReview) {
      throw new ReviewError(
        "A review has already been submitted for this booking",
        "REVIEW_ALREADY_EXISTS",
        409
      );
    }

    // 4. Persistence with database-level uniqueness violation (P2002) handling
    try {
      return await prisma.review.create({
        data: {
          booking_id: bookingId,
          worker_id: booking.worker_id,
          customer_id: customerId,
          rating: payload.rating,
          comment: payload.comment
        }
      });
    } catch (err: any) {
      if (isReviewUniqueConstraintError(err)) {
        throw new ReviewError(
          "A review has already been submitted for this booking",
          "REVIEW_ALREADY_EXISTS",
          409
        );
      }
      throw err;
    }
  },

  async getWorkerReviews(workerId: string) {
    return await prisma.review.findMany({
      where: { worker_id: workerId }
    });
  },

  async getBookingReview(bookingId: string, actor?: PolicyActor) {
    if (actor) {
      const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
      if (!booking) {
        throw new ReviewError("Booking not found", "BOOKING_NOT_FOUND", 404);
      }
      assertPolicy(reviewPolicy.canReadBookingReview(actor, booking));
    }
    return await prisma.review.findFirst({
      where: { booking_id: bookingId }
    });
  }
};

