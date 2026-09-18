import express from "express";
import { getBooking, verifyOtp, completeBooking, confirmComplete, cancelBooking, getWorkerLocation } from "./bookingController";
import { getPaymentStatusHandler } from "../payment/paymentController";
import { validateBody, validateParams } from "../../middlewares/validationMiddleware";
import {
  ConfirmBookingCompleteReqSchema,
  CancelBookingReqSchema,
  BookingSchema,
  BookingIdParamSchema,
  VerifyBookingOtpReqSchema,
  PaymentSchema,
} from "../../schemas";
import { registry } from "../../config/swagger";
import { z } from "zod";
import { authenticateJWT, requireRole, UserRole } from "../../middlewares/authMiddleware";

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
  request: { body: { content: { "application/json": { schema: VerifyBookingOtpReqSchema } } } },
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

registry.registerPath({
  method: "get",
  path: "/api/bookings/{bookingId}/payment",
  summary: "Get booking payment status",
  tags: ["Bookings"],
  security: [{ bearerAuth: [] }],
  parameters: [{ in: "path", name: "bookingId", required: true, schema: { type: "string", format: "uuid" } }],
  responses: {
    200: { description: "Payment status", content: { "application/json": { schema: z.object({ success: z.boolean(), data: PaymentSchema }) } } },
    401: { description: "Unauthorized" },
    403: { description: "Forbidden" },
    404: { description: "Booking or payment not found" },
  },
});

router.get("/:bookingId", authenticateJWT, validateParams(BookingIdParamSchema), getBooking);
router.post("/:bookingId/otp/verify", authenticateJWT, validateParams(BookingIdParamSchema), validateBody(VerifyBookingOtpReqSchema), verifyOtp);
router.post("/:bookingId/complete", authenticateJWT, validateParams(BookingIdParamSchema), completeBooking);
router.post("/:bookingId/confirm-complete", authenticateJWT, validateParams(BookingIdParamSchema), validateBody(ConfirmBookingCompleteReqSchema), confirmComplete);
router.post("/:bookingId/cancel", authenticateJWT, validateParams(BookingIdParamSchema), validateBody(CancelBookingReqSchema), cancelBooking);
router.get("/:bookingId/location", authenticateJWT, validateParams(BookingIdParamSchema), getWorkerLocation);
router.get("/:bookingId/payment", authenticateJWT, requireRole(UserRole.CUSTOMER, UserRole.ADMIN), validateParams(BookingIdParamSchema), getPaymentStatusHandler);

export default router;
