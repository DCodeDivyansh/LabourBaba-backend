import express from "express";
import { createJob, getMyJobs, getJobDetail, cancelJob, getJobRequirements, getJobBookings, createJobRequirement } from "./jobController";
import { validateBody } from "../../middlewares/validationMiddleware";
import { authenticateJWT, requireRole, UserRole } from "../../middlewares/authMiddleware";
import { CreateJobReqSchema, JobSchema, JobRequirementSchema, BookingSchema, CreateJobRequirementReqSchema } from "../../schemas";
import { registry } from "../../config/swagger";
import { z } from "zod";

const router = express.Router();

registry.registerPath({
  method: "post",
  path: "/api/jobs",
  summary: "Create a new job (Customer only - authenticated principal is owner)",
  tags: ["Jobs"],
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: CreateJobReqSchema } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: z.object({ success: z.boolean(), data: JobSchema }) } } },
    400: { description: "Bad Request - Validation error or extraneous properties" },
    401: { description: "Unauthorized - Missing or invalid token" },
    403: { description: "Forbidden - Requires customer role" },
  }
});

registry.registerPath({
  method: "get",
  path: "/api/jobs",
  summary: "List own posted jobs (Customer only - scoped to authenticated principal)",
  tags: ["Jobs"],
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: z.array(JobSchema) }) } } },
    401: { description: "Unauthorized - Missing or invalid token" },
    403: { description: "Forbidden - Requires customer role" },
  }
});

registry.registerPath({
  method: "get",
  path: "/api/jobs/{jobId}",
  summary: "Get job detail with requirements",
  tags: ["Jobs"],
  parameters: [{ in: "path", name: "jobId", required: true, schema: { type: "string", format: "uuid" } }],
  responses: { 200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: JobSchema }) } } } }
});

registry.registerPath({
  method: "patch",
  path: "/api/jobs/{jobId}/cancel",
  summary: "Cancel open job",
  tags: ["Jobs"],
  parameters: [{ in: "path", name: "jobId", required: true, schema: { type: "string", format: "uuid" } }],
  responses: { 200: { description: "Success" } }
});

registry.registerPath({
  method: "get",
  path: "/api/jobs/{jobId}/requirements",
  summary: "List all requirements",
  tags: ["Jobs"],
  parameters: [{ in: "path", name: "jobId", required: true, schema: { type: "string", format: "uuid" } }],
  responses: { 200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: z.array(JobRequirementSchema) }) } } } }
});

registry.registerPath({
  method: "get",
  path: "/api/jobs/{jobId}/bookings",
  summary: "All bookings under this job",
  tags: ["Jobs"],
  parameters: [{ in: "path", name: "jobId", required: true, schema: { type: "string", format: "uuid" } }],
  responses: { 200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: z.array(BookingSchema) }) } } } }
});

registry.registerPath({
  method: "post",
  path: "/api/jobs/{jobId}/requirements",
  summary: "Create a job requirement for an existing job",
  tags: ["Jobs"],
  parameters: [{ in: "path", name: "jobId", required: true, schema: { type: "string", format: "uuid" } }],
  request: { body: { content: { "application/json": { schema: CreateJobRequirementReqSchema } } } },
  responses: { 201: { description: "Created", content: { "application/json": { schema: z.object({ success: z.boolean(), data: JobRequirementSchema }) } } } }
});

router.post("/", authenticateJWT, requireRole(UserRole.CUSTOMER), validateBody(CreateJobReqSchema), createJob);
router.get("/", authenticateJWT, requireRole(UserRole.CUSTOMER), getMyJobs);
router.get("/:jobId", authenticateJWT, getJobDetail);
router.patch("/:jobId/cancel", authenticateJWT, requireRole(UserRole.CUSTOMER), cancelJob);
router.get("/:jobId/requirements", authenticateJWT, getJobRequirements);
router.post("/:jobId/requirements", authenticateJWT, validateBody(CreateJobRequirementReqSchema), createJobRequirement);
router.get("/:jobId/bookings", authenticateJWT, getJobBookings);

export default router;
