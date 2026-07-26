import express from "express";
import { createReview, getWorkerReviews, getBookingReview } from "../../features/review/reviewController";
import { validateBody } from "../../middlewares/validationMiddleware";
import { authenticateJWT } from "../../middlewares/authMiddleware";
import { CreateReviewReqSchema, ReviewSchema } from "../../schemas";
import { registry } from "../../config/swagger";
import { z } from "zod";

const router = express.Router();

registry.registerPath({
  method: "post",
  path: "/api/reviews/{bookingId}",
  summary: "Submit rating and comment",
  tags: ["Reviews"],
  parameters: [{ in: "path", name: "bookingId", required: true, schema: { type: "string", format: "uuid" } }],
  request: { body: { content: { "application/json": { schema: CreateReviewReqSchema } } } },
  responses: { 201: { description: "Created", content: { "application/json": { schema: z.object({ success: z.boolean(), data: ReviewSchema }) } } } }
});

registry.registerPath({
  method: "get",
  path: "/api/reviews/worker/{workerId}",
  summary: "Get worker reviews",
  tags: ["Reviews"],
  parameters: [{ in: "path", name: "workerId", required: true, schema: { type: "string", format: "uuid" } }],
  responses: { 200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: z.array(ReviewSchema) }) } } } }
});

registry.registerPath({
  method: "get",
  path: "/api/reviews/{bookingId}",
  summary: "Get review for booking",
  tags: ["Reviews"],
  parameters: [{ in: "path", name: "bookingId", required: true, schema: { type: "string", format: "uuid" } }],
  responses: { 200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: ReviewSchema }) } } } }
});

router.post("/:bookingId", authenticateJWT, validateBody(CreateReviewReqSchema), createReview);
router.get("/worker/:workerId", authenticateJWT, getWorkerReviews);
router.get("/:bookingId", authenticateJWT, getBookingReview);

export default router;
