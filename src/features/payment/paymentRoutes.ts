import express from "express";
import { createOrder, handleWebhook, getPaymentStatus, refundPayment } from "./paymentController";
import { validateBody } from "../../middlewares/validationMiddleware";
import { authenticateJWT } from "../../middlewares/authMiddleware";
import { CreatePaymentReqSchema, PaymentSchema } from "../../schemas";
import { registry } from "../../config/swagger";
import { z } from "zod";

const router = express.Router();

registry.registerPath({
  method: "post",
  path: "/api/payments/{bookingId}/create-order",
  summary: "Create Razorpay order",
  tags: ["Payments"],
  parameters: [{ in: "path", name: "bookingId", required: true, schema: { type: "string", format: "uuid" } }],
  request: { body: { content: { "application/json": { schema: z.object({ amount: z.number().int() }) } } } },
  responses: { 201: { description: "Created", content: { "application/json": { schema: z.object({ success: z.boolean(), data: PaymentSchema }) } } } }
});

registry.registerPath({
  method: "post",
  path: "/api/payments/webhook",
  summary: "Razorpay webhook",
  tags: ["Payments"],
  responses: { 200: { description: "Success" } }
});

registry.registerPath({
  method: "get",
  path: "/api/payments/{bookingId}",
  summary: "Get payment status",
  tags: ["Payments"],
  parameters: [{ in: "path", name: "bookingId", required: true, schema: { type: "string", format: "uuid" } }],
  responses: { 200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: z.array(PaymentSchema) }) } } } }
});

registry.registerPath({
  method: "post",
  path: "/api/payments/{bookingId}/refund",
  summary: "Initiate refund",
  tags: ["Payments"],
  parameters: [{ in: "path", name: "bookingId", required: true, schema: { type: "string", format: "uuid" } }],
  responses: { 200: { description: "Success" } }
});

router.post("/:bookingId/create-order", authenticateJWT, validateBody(CreatePaymentReqSchema), createOrder);
router.post("/webhook", handleWebhook);
router.get("/:bookingId", authenticateJWT, getPaymentStatus);
router.post("/:bookingId/refund", authenticateJWT, refundPayment);

export default router;
