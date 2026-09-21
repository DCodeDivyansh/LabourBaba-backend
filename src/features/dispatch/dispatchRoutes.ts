import express from "express";
import { registry } from "../../config/swagger";
import { z } from "zod";
import { JobDispatchSchema, BookingSchema, DispatchWavesResponseSchema, RequirementIdParamSchema } from "../../schemas";
import { authenticateJWT, requireRole, UserRole } from "../../middlewares/authMiddleware";
import { validateParams } from "../../middlewares/validationMiddleware";
import { getIncoming, acceptJob, declineJob, getWaves, getDispatchDetail } from "./dispatchController";

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
  description: "Atomically accepts a pending, non-expired dispatch for the authenticated worker. Worker identity is strictly derived from JWT bearer token (req.user.id). Client-supplied worker_id is rejected.",
  tags: ["Dispatch"],
  security: [{ bearerAuth: [] }],
  parameters: [{ in: "path", name: "requirementId", required: true, schema: { type: "string", format: "uuid" } }],
  responses: {
    200: { description: "Dispatch accepted and booking created", content: { "application/json": { schema: z.object({ success: z.boolean(), data: BookingSchema }) } } },
    400: { description: "Invalid requirementId or client attempted to supply worker_id" },
    401: { description: "Unauthorized: Valid JWT required" },
    403: { description: "Forbidden: Worker role required" },
    404: { description: "Requirement not found or worker has no dispatch row for this requirement" },
    409: { description: "Requirement slots are full, dispatch already accepted, or worker has active booking" },
    410: { description: "Dispatch has expired" },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/dispatch/{requirementId}/decline",
  summary: "Decline job slot",
  description: "Declines a pending dispatch for the authenticated worker. Worker identity is strictly derived from JWT bearer token (req.user.id). Client-supplied worker_id is rejected.",
  tags: ["Dispatch"],
  security: [{ bearerAuth: [] }],
  parameters: [{ in: "path", name: "requirementId", required: true, schema: { type: "string", format: "uuid" } }],
  responses: {
    200: { description: "Dispatch declined" },
    400: { description: "Invalid requirementId or client attempted to supply worker_id" },
    401: { description: "Unauthorized: Valid JWT required" },
    403: { description: "Forbidden: Worker role required" },
    404: { description: "Requirement not found or worker has no dispatch row" },
  },
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

import { dispatchActionRateLimiter } from "../../middlewares/rateLimiter";

router.get("/incoming", authenticateJWT, requireRole(UserRole.WORKER), getIncoming);
router.post("/:requirementId/accept", authenticateJWT, requireRole(UserRole.WORKER), dispatchActionRateLimiter, validateParams(RequirementIdParamSchema), acceptJob);
router.post("/:requirementId/decline", authenticateJWT, requireRole(UserRole.WORKER), dispatchActionRateLimiter, validateParams(RequirementIdParamSchema), declineJob);
router.get("/:requirementId/waves", authenticateJWT, validateParams(RequirementIdParamSchema), getWaves);
router.get("/:requirementId", authenticateJWT, requireRole(UserRole.WORKER), validateParams(RequirementIdParamSchema), getDispatchDetail);

export default router;
