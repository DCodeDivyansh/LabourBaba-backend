import express from "express";
import { getWorkers, verifyWorker, getAllJobs, getFlaggedWorkers, suspendWorker, getWorkerDocuments, getWorkerDocumentAccess } from "./adminController";
import { validateBody, validateParams } from "../../middlewares/validationMiddleware";
import { authenticateJWT, requireRole, UserRole } from "../../middlewares/authMiddleware";
import {
  VerifyWorkerDocumentReqSchema,
  SuspendWorkerReqSchema,
  WorkerSchema,
  JobSchema,
  WorkerDocumentSchema,
  WorkerIdParamSchema,
  WorkerIdAndDocumentIdParamSchema,
  WorkerDocumentAccessResponseSchema,
} from "../../schemas";
import { registry } from "../../config/swagger";
import { z } from "zod";

const router = express.Router();

// Centralized router-level RBAC protection for all admin routes
router.use(authenticateJWT, requireRole(UserRole.ADMIN));

registry.registerPath({
  method: "get",
  path: "/api/admin/workers",
  summary: "List all workers (Admin only)",
  tags: ["Admin"],
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: z.array(WorkerSchema) }) } } },
    401: { description: "Unauthorized - Missing or invalid token" },
    403: { description: "Forbidden - Requires admin role" },
  }
});

registry.registerPath({
  method: "patch",
  path: "/api/admin/workers/{id}/verify",
  summary: "Approve or reject Aadhaar (Admin only)",
  tags: ["Admin"],
  security: [{ bearerAuth: [] }],
  parameters: [{ in: "path", name: "id", required: true, schema: { type: "string", format: "uuid" } }],
  request: { body: { content: { "application/json": { schema: VerifyWorkerDocumentReqSchema } } } },
  responses: {
    200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: WorkerSchema }) } } },
    401: { description: "Unauthorized - Missing or invalid token" },
    403: { description: "Forbidden - Requires admin role" },
  }
});

registry.registerPath({
  method: "get",
  path: "/api/admin/jobs",
  summary: "All jobs across platform with optional customer search filter (Admin only)",
  tags: ["Admin"],
  security: [{ bearerAuth: [] }],
  parameters: [{ in: "query", name: "customer_id", required: false, schema: { type: "string", format: "uuid" }, description: "Optional filter by customer ID" }],
  responses: {
    200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: z.array(JobSchema) }) } } },
    401: { description: "Unauthorized - Missing or invalid token" },
    403: { description: "Forbidden - Requires admin role" },
  }
});

registry.registerPath({
  method: "get",
  path: "/api/admin/flagged",
  summary: "Workers with high decline/timeout counts (Admin only)",
  tags: ["Admin"],
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: z.array(WorkerSchema) }) } } },
    401: { description: "Unauthorized - Missing or invalid token" },
    403: { description: "Forbidden - Requires admin role" },
  }
});

registry.registerPath({
  method: "post",
  path: "/api/admin/workers/{id}/suspend",
  summary: "Suspend worker account (Admin only)",
  tags: ["Admin"],
  security: [{ bearerAuth: [] }],
  parameters: [{ in: "path", name: "id", required: true, schema: { type: "string", format: "uuid" } }],
  request: { body: { content: { "application/json": { schema: SuspendWorkerReqSchema } } } },
  responses: {
    200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: WorkerSchema }) } } },
    401: { description: "Unauthorized - Missing or invalid token" },
    403: { description: "Forbidden - Requires admin role" },
  }
});

registry.registerPath({
  method: "get",
  path: "/api/admin/workers/{id}/documents",
  summary: "List all document metadata for a worker (Admin only)",
  tags: ["Admin"],
  security: [{ bearerAuth: [] }],
  parameters: [{ in: "path", name: "id", required: true, schema: { type: "string", format: "uuid" } }],
  responses: {
    200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: z.array(WorkerDocumentSchema) }) } } },
    401: { description: "Unauthorized - Missing or invalid token" },
    403: { description: "Forbidden - Requires admin role" },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/admin/workers/{id}/documents/{documentId}/access",
  summary: "Get authorized short-lived download URL for worker identity document with audit logging (Admin only)",
  tags: ["Admin"],
  security: [{ bearerAuth: [] }],
  parameters: [
    { in: "path", name: "id", required: true, schema: { type: "string", format: "uuid" } },
    { in: "path", name: "documentId", required: true, schema: { type: "string", format: "uuid" } },
  ],
  responses: {
    200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: WorkerDocumentAccessResponseSchema }) } } },
    401: { description: "Unauthorized - Missing or invalid token" },
    403: { description: "Forbidden - Requires admin role" },
    404: { description: "Document not found" },
  },
});

router.get("/workers", authenticateJWT, requireRole(UserRole.ADMIN), getWorkers);
router.patch("/workers/:id/verify", authenticateJWT, requireRole(UserRole.ADMIN), validateBody(VerifyWorkerDocumentReqSchema), verifyWorker);
router.get("/workers/:id/documents", authenticateJWT, requireRole(UserRole.ADMIN), validateParams(WorkerIdParamSchema), getWorkerDocuments);
router.get("/workers/:id/documents/:documentId/access", authenticateJWT, requireRole(UserRole.ADMIN), validateParams(WorkerIdAndDocumentIdParamSchema), getWorkerDocumentAccess);
router.get("/jobs", authenticateJWT, requireRole(UserRole.ADMIN), getAllJobs);
router.get("/flagged", authenticateJWT, requireRole(UserRole.ADMIN), getFlaggedWorkers);
router.post("/workers/:id/suspend", authenticateJWT, requireRole(UserRole.ADMIN), validateBody(SuspendWorkerReqSchema), suspendWorker);

export default router;

