import express from "express";
import { getBooking, verifyOtp, completeBooking, confirmComplete, cancelBooking, getWorkerLocation } from "./bookingController";
import { validateBody } from "../../middlewares/validationMiddleware";
import { ConfirmBookingCompleteReqSchema, CancelBookingReqSchema, BookingSchema } from "../../schemas";
import { registry } from "../../config/swagger";
import { z } from "zod";
import { authenticateJWT } from "../../middlewares/authMiddleware";

const router = express.Router();

registry.registerPath({
  method: "get",
  path: "/api/bookings/{bookingId}",
  summary: "Get booking detail",
  tags: ["Bookings"],
  parameters: [{ in: "path", name: "bookingId", required: true, schema: { type: "string", format: "uuid" } }],
  responses: { 200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: BookingSchema }) } } } }
});

registry.registerPath({
  method: "post",
  path: "/api/bookings/{bookingId}/otp/verify",
  summary: "Worker submits OTP to start job",
  tags: ["Bookings"],
  parameters: [{ in: "path", name: "bookingId", required: true, schema: { type: "string", format: "uuid" } }],
  request: { body: { content: { "application/json": { schema: z.object({ otp: z.string().length(6) }) } } } },
  responses: { 200: { description: "Success" } }
});

registry.registerPath({
  method: "post",
  path: "/api/bookings/{bookingId}/complete",
  summary: "Worker marks job done",
  tags: ["Bookings"],
  parameters: [{ in: "path", name: "bookingId", required: true, schema: { type: "string", format: "uuid" } }],
  responses: { 200: { description: "Success" } }
});

registry.registerPath({
  method: "post",
  path: "/api/bookings/{bookingId}/confirm-complete",
  summary: "Customer confirms completion and reviews",
  tags: ["Bookings"],
  parameters: [{ in: "path", name: "bookingId", required: true, schema: { type: "string", format: "uuid" } }],
  request: { body: { content: { "application/json": { schema: ConfirmBookingCompleteReqSchema } } } },
  responses: { 200: { description: "Success" } }
});

registry.registerPath({
  method: "post",
  path: "/api/bookings/{bookingId}/cancel",
  summary: "Cancel booking with reason",
  tags: ["Bookings"],
  parameters: [{ in: "path", name: "bookingId", required: true, schema: { type: "string", format: "uuid" } }],
  request: { body: { content: { "application/json": { schema: CancelBookingReqSchema } } } },
  responses: { 200: { description: "Success" } }
});

registry.registerPath({
  method: "get",
  path: "/api/bookings/{bookingId}/location",
  summary: "Customer gets worker's current location",
  tags: ["Bookings"],
  parameters: [{ in: "path", name: "bookingId", required: true, schema: { type: "string", format: "uuid" } }],
  responses: { 200: { description: "Success" } }
});

router.get("/:bookingId", authenticateJWT, getBooking);
router.post("/:bookingId/otp/verify", authenticateJWT, verifyOtp);
router.post("/:bookingId/complete", authenticateJWT, completeBooking);
router.post("/:bookingId/confirm-complete", authenticateJWT, validateBody(ConfirmBookingCompleteReqSchema), confirmComplete);
router.post("/:bookingId/cancel", authenticateJWT, validateBody(CancelBookingReqSchema), cancelBooking);
router.get("/:bookingId/location", authenticateJWT, getWorkerLocation);

export default router;
