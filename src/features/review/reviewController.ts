import { Request, Response } from "express";
import { reviewService, ReviewError } from "./reviewServices";
import { CreateReviewReq } from "../../type/api_req.type";
import { AuthenticatedRequest } from "../../middlewares/authMiddleware";
import { AuthorizationError } from "../../policies";
import { toReviewDTO } from "../../shared/prismaSelects";
import { logger } from "../../utils/logger";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUUID(val: unknown): boolean {
  return typeof val === "string" && UUID_REGEX.test(val);
}

function handleReviewError(error: unknown, req: Request, res: Response): void {
  const reqLogger = (req as any).logger || logger;
  if (error instanceof AuthorizationError) {
    res.status(error.status).json({
      success: false,
      code: error.status === 404 ? "BOOKING_NOT_FOUND" : "FORBIDDEN",
      message: error.message,
    });
    return;
  }
  if (error instanceof ReviewError) {
    res.status(error.statusCode).json({
      success: false,
      code: error.code,
      message: error.message,
    });
    return;
  }

  // Unknown error — log server-side, never expose raw database or provider internals
  reqLogger.error("[reviewController] Unexpected error:", { error: (error as any)?.message, stack: (error as any)?.stack });
  res.status(500).json({
    success: false,
    code: "REVIEW_INTERNAL_ERROR",
    message: "An unexpected error occurred while processing the review.",
  });
}

/**
 * POST /api/reviews/:bookingId
 * Creates a review for a completed booking.
 *
 * Security:
 * - Requires authenticateJWT and requireRole(UserRole.CUSTOMER).
 * - Authoritative customer identity is derived strictly from req.user.id.
 * - Client-supplied identity fields (customer_id, worker_id, booking_id) are rejected.
 */
export const createReview = async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    const customerId = authReq.user?.id;
    if (!customerId) {
      res.status(401).json({
        success: false,
        code: "UNAUTHORIZED",
        message: "Authentication required",
      });
      return;
    }

    const { bookingId } = req.params as { bookingId: string };
    if (!isValidUUID(bookingId)) {
      res.status(400).json({
        success: false,
        code: "INVALID_BOOKING_ID",
        message: "Invalid booking ID format. Must be a valid UUID.",
      });
      return;
    }

    const payload: CreateReviewReq = req.body;
    const review = await reviewService.createReview(bookingId, customerId, payload);
    res.status(201).json({ success: true, data: toReviewDTO(review) });
  } catch (error) {
    handleReviewError(error, req, res);
  }
};

export const getWorkerReviews = async (req: Request, res: Response): Promise<void> => {
  try {
    const { workerId } = req.params as { workerId: string };
    if (!isValidUUID(workerId)) {
      res.status(400).json({
        success: false,
        code: "INVALID_WORKER_ID",
        message: "Invalid worker ID format. Must be a valid UUID.",
      });
      return;
    }

    const reviews = await reviewService.getWorkerReviews(workerId);
    res.status(200).json({ success: true, data: reviews.map(toReviewDTO).filter(Boolean) });
  } catch (error) {
    handleReviewError(error, req, res);
  }
};

export const getBookingReview = async (req: Request, res: Response): Promise<void> => {
  try {
    const { bookingId } = req.params as { bookingId: string };
    if (!isValidUUID(bookingId)) {
      res.status(400).json({
        success: false,
        code: "INVALID_BOOKING_ID",
        message: "Invalid booking ID format. Must be a valid UUID.",
      });
      return;
    }

    const actor = (req as AuthenticatedRequest).user;
    const review = await reviewService.getBookingReview(bookingId, actor);
    res.status(200).json({ success: true, data: toReviewDTO(review) });
  } catch (error) {
    handleReviewError(error, req, res);
  }
};

