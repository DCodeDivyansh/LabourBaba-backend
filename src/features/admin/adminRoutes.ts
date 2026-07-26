import express from "express";
import { getWorkers, verifyWorker, getAllJobs, getFlaggedWorkers, suspendWorker } from "./adminController";
import { validateBody } from "../../middlewares/validationMiddleware";
import { authenticateJWT } from "../../middlewares/authMiddleware";
import { VerifyWorkerDocumentReqSchema, SuspendWorkerReqSchema, WorkerSchema, JobSchema } from "../../schemas";
import { registry } from "../../config/swagger";
import { z } from "zod";

const router = express.Router();

registry.registerPath({
  method: "get",
  path: "/api/admin/workers",
  summary: "List all workers",
  tags: ["Admin"],
  responses: { 200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: z.array(WorkerSchema) }) } } } }
});

registry.registerPath({
  method: "patch",
  path: "/api/admin/workers/{id}/verify",
  summary: "Approve or reject Aadhaar",
  tags: ["Admin"],
  parameters: [{ in: "path", name: "id", required: true, schema: { type: "string", format: "uuid" } }],
  request: { body: { content: { "application/json": { schema: VerifyWorkerDocumentReqSchema } } } },
  responses: { 200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: WorkerSchema }) } } } }
});

registry.registerPath({
  method: "get",
  path: "/api/admin/jobs",
  summary: "All jobs across platform",
  tags: ["Admin"],
  responses: { 200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: z.array(JobSchema) }) } } } }
});

registry.registerPath({
  method: "get",
  path: "/api/admin/flagged",
  summary: "Workers with high decline/timeout counts",
  tags: ["Admin"],
  responses: { 200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: z.array(WorkerSchema) }) } } } }
});

registry.registerPath({
  method: "post",
  path: "/api/admin/workers/{id}/suspend",
  summary: "Suspend worker account",
  tags: ["Admin"],
  parameters: [{ in: "path", name: "id", required: true, schema: { type: "string", format: "uuid" } }],
  request: { body: { content: { "application/json": { schema: SuspendWorkerReqSchema } } } },
  responses: { 200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: WorkerSchema }) } } } }
});

router.get("/workers", authenticateJWT, getWorkers);
router.patch("/workers/:id/verify", authenticateJWT, validateBody(VerifyWorkerDocumentReqSchema), verifyWorker);
router.get("/jobs", authenticateJWT, getAllJobs);
router.get("/flagged", authenticateJWT, getFlaggedWorkers);
router.post("/workers/:id/suspend", authenticateJWT, validateBody(SuspendWorkerReqSchema), suspendWorker);

export default router;
