import express from "express";
import { createReview, getWorkerReviews, getBookingReview } from "../../features/review/reviewController";
import { validateBody } from "../../middlewares/validationMiddleware";
import { authenticateJWT, requireRole, UserRole } from "../../middlewares/authMiddleware";
import { CreateReviewReqSchema, ReviewSchema } from "../../schemas";
import { registry } from "../../config/swagger";
import { z } from "zod";

const router = express.Router();

registry.registerPath({
  method: "post",
  path: "/api/reviews/{bookingId}",
  summary: "Submit rating and comment for completed booking",
  tags: ["Reviews"],
  security: [{ bearerAuth: [] }],
  parameters: [{ in: "path", name: "bookingId", required: true, schema: { type: "string", format: "uuid" } }],
  request: { body: { content: { "application/json": { schema: CreateReviewReqSchema } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: z.object({ success: z.boolean(), data: ReviewSchema }) } } },
    400: { description: "Bad Request — Invalid UUID or validation failure" },
    401: { description: "Unauthorized — Authentication token missing or invalid" },
    403: { description: "Forbidden — Insufficient permissions or unowned booking" },
    404: { description: "Not Found — Booking not found" },
    409: { description: "Conflict — Booking not completed or already reviewed" },
  }
});

registry.registerPath({
  method: "get",
  path: "/api/reviews/worker/{workerId}",
  summary: "Get worker reviews",
  tags: ["Reviews"],
  security: [{ bearerAuth: [] }],
  parameters: [{ in: "path", name: "workerId", required: true, schema: { type: "string", format: "uuid" } }],
  responses: { 200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: z.array(ReviewSchema) }) } } } }
});

registry.registerPath({
  method: "get",
  path: "/api/reviews/{bookingId}",
  summary: "Get review for booking",
  tags: ["Reviews"],
  security: [{ bearerAuth: [] }],
  parameters: [{ in: "path", name: "bookingId", required: true, schema: { type: "string", format: "uuid" } }],
  responses: { 200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: ReviewSchema }) } } } }
});

router.post("/:bookingId", authenticateJWT, requireRole(UserRole.CUSTOMER), validateBody(CreateReviewReqSchema), createReview);
router.get("/worker/:workerId", authenticateJWT, getWorkerReviews);
router.get("/:bookingId", authenticateJWT, getBookingReview);

export default router;

