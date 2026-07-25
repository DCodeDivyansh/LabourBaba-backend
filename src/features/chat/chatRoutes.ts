import express from "express";
import { getMessages, sendMessage } from "../../features/chat/chatController";
import { registry } from "../../config/swagger";
import { z } from "zod";
import { MessageSchema } from "../../schemas";
import { authenticateJWT } from "../../middlewares/authMiddleware";

const router = express.Router();

registry.registerPath({
  method: "get",
  path: "/api/chat/{bookingId}/messages",
  summary: "Fetch message history",
  tags: ["Chat"],
  parameters: [{ in: "path", name: "bookingId", required: true, schema: { type: "string", format: "uuid" } }],
  responses: { 200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: z.array(MessageSchema) }) } } } }
});

registry.registerPath({
  method: "post",
  path: "/api/chat/{bookingId}/messages",
  summary: "Send message",
  tags: ["Chat"],
  parameters: [{ in: "path", name: "bookingId", required: true, schema: { type: "string", format: "uuid" } }],
  request: { body: { content: { "application/json": { schema: z.object({ content: z.string().min(1) }) } } } },
  responses: { 201: { description: "Created", content: { "application/json": { schema: z.object({ success: z.boolean(), data: MessageSchema }) } } } }
});

router.get("/:bookingId/messages", authenticateJWT, getMessages);
router.post("/:bookingId/messages", authenticateJWT, sendMessage);

export default router;
