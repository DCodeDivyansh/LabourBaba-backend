import express from "express";
import {
  createJob,
  getMyJobs,
  getJobDetail,
  cancelJob,
  getJobRequirements,
  getJobBookings,
  createJobRequirement,
  getRequirementDetail,
} from "./jobController";
import { validateBody, validateParams } from "../../middlewares/validationMiddleware";
import { authenticateJWT, requireRole, UserRole } from "../../middlewares/authMiddleware";
import {
  CreateJobReqSchema,
  JobSchema,
  JobRequirementSchema,
  BookingSchema,
  CreateJobRequirementReqSchema,
  JobIdParamSchema,
  JobAndRequirementIdParamSchema,
} from "../../schemas";
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
  responses: {
    200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: JobSchema }) } } },
    400: { description: "Bad Request - Malformed jobId UUID" },
    401: { description: "Unauthorized" },
    404: { description: "Job not found (IDOR protection)" },
  }
});

registry.registerPath({
  method: "patch",
  path: "/api/jobs/{jobId}/cancel",
  summary: "Cancel open job",
  tags: ["Jobs"],
  parameters: [{ in: "path", name: "jobId", required: true, schema: { type: "string", format: "uuid" } }],
  responses: {
    200: { description: "Success" },
    400: { description: "Bad Request - Malformed jobId or invalid state" },
    401: { description: "Unauthorized" },
    403: { description: "Forbidden" },
    404: { description: "Job not found" },
  }
});

registry.registerPath({
  method: "get",
  path: "/api/jobs/{jobId}/requirements",
  summary: "List all requirements",
  tags: ["Jobs"],
  parameters: [{ in: "path", name: "jobId", required: true, schema: { type: "string", format: "uuid" } }],
  responses: {
    200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: z.array(JobRequirementSchema) }) } } },
    400: { description: "Bad Request - Malformed jobId UUID" },
    401: { description: "Unauthorized" },
    404: { description: "Job not found (IDOR protection)" },
  }
});

registry.registerPath({
  method: "get",
  path: "/api/jobs/{jobId}/requirements/{requirementId}",
  summary: "Get requirement detail by ID",
  tags: ["Jobs"],
  parameters: [
    { in: "path", name: "jobId", required: true, schema: { type: "string", format: "uuid" } },
    { in: "path", name: "requirementId", required: true, schema: { type: "string", format: "uuid" } },
  ],
  responses: {
    200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: JobRequirementSchema }) } } },
    400: { description: "Bad Request - Malformed UUID" },
    401: { description: "Unauthorized" },
    404: { description: "Requirement not found (IDOR protection)" },
  }
});

registry.registerPath({
  method: "get",
  path: "/api/jobs/{jobId}/bookings",
  summary: "All bookings under this job",
  tags: ["Jobs"],
  parameters: [{ in: "path", name: "jobId", required: true, schema: { type: "string", format: "uuid" } }],
  responses: {
    200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: z.array(BookingSchema) }) } } },
    400: { description: "Bad Request - Malformed jobId UUID" },
    401: { description: "Unauthorized" },
    404: { description: "Job not found (IDOR protection)" },
  }
});

registry.registerPath({
  method: "post",
  path: "/api/jobs/{jobId}/requirements",
  summary: "Create a job requirement for an existing job",
  tags: ["Jobs"],
  parameters: [{ in: "path", name: "jobId", required: true, schema: { type: "string", format: "uuid" } }],
  request: { body: { content: { "application/json": { schema: CreateJobRequirementReqSchema } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: z.object({ success: z.boolean(), data: JobRequirementSchema }) } } },
    400: { description: "Bad Request - Validation error" },
    401: { description: "Unauthorized" },
    403: { description: "Forbidden" },
    404: { description: "Job not found" },
  }
});

router.post("/", authenticateJWT, requireRole(UserRole.CUSTOMER), validateBody(CreateJobReqSchema), createJob);
router.get("/", authenticateJWT, requireRole(UserRole.CUSTOMER), getMyJobs);
router.get("/:jobId", authenticateJWT, validateParams(JobIdParamSchema), getJobDetail);
router.patch("/:jobId/cancel", authenticateJWT, requireRole(UserRole.CUSTOMER), validateParams(JobIdParamSchema), cancelJob);
router.get("/:jobId/requirements", authenticateJWT, validateParams(JobIdParamSchema), getJobRequirements);
router.get("/:jobId/requirements/:requirementId", authenticateJWT, validateParams(JobAndRequirementIdParamSchema), getRequirementDetail);
router.post("/:jobId/requirements", authenticateJWT, requireRole(UserRole.CUSTOMER), validateParams(JobIdParamSchema), validateBody(CreateJobRequirementReqSchema), createJobRequirement);
router.get("/:jobId/bookings", authenticateJWT, validateParams(JobIdParamSchema), getJobBookings);

export default router;
