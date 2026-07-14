import express from "express";
import { registry } from "../config/swagger";
import { z } from "zod";
import { JobDispatchSchema, BookingSchema, DispatchWavesResponseSchema } from "../schemas";
import { authenticateJWT } from "../middlewares/authMiddleware";
import { getIncoming, acceptJob, declineJob, getWaves, getDispatchDetail } from "../controllers/dispatchController";

const router = express.Router();

registry.registerPath({
  method: "get",
  path: "/api/dispatch/incoming",
  summary: "Get active incoming job",
  tags: ["Dispatch"],
  responses: { 200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: JobDispatchSchema }) } } } }
});

registry.registerPath({
  method: "post",
  path: "/api/dispatch/{requirementId}/accept",
  summary: "Accept job slot",
  tags: ["Dispatch"],
  parameters: [{ in: "path", name: "requirementId", required: true, schema: { type: "string", format: "uuid" } }],
  responses: { 200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: BookingSchema }) } } } }
});

registry.registerPath({
  method: "post",
  path: "/api/dispatch/{requirementId}/decline",
  summary: "Decline job slot",
  tags: ["Dispatch"],
  parameters: [{ in: "path", name: "requirementId", required: true, schema: { type: "string", format: "uuid" } }],
  responses: { 200: { description: "Success" } }
});

registry.registerPath({
  method: "get",
  path: "/api/dispatch/{requirementId}/waves",
  summary: "View wave history",
  tags: ["Dispatch"],
  parameters: [{ in: "path", name: "requirementId", required: true, schema: { type: "string", format: "uuid" } }],
  responses: { 200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: DispatchWavesResponseSchema }) } } } }
});

registry.registerPath({
  method: "get",
  path: "/api/dispatch/{requirementId}",
  summary: "Get a single dispatch's current status/detail",
  tags: ["Dispatch"],
  parameters: [{ in: "path", name: "requirementId", required: true, schema: { type: "string", format: "uuid" } }],
  responses: { 200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: JobDispatchSchema }) } } } }
});

router.get("/incoming", authenticateJWT, getIncoming);
router.post("/:requirementId/accept", authenticateJWT, acceptJob);
router.post("/:requirementId/decline", authenticateJWT, declineJob);
router.get("/:requirementId/waves", authenticateJWT, getWaves);
router.get("/:requirementId", authenticateJWT, getDispatchDetail);

export default router;
