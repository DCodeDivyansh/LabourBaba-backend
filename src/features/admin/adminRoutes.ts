import express from "express";
import {
  getWorkers,
  verifyWorker,
  getAllJobs,
  getFlaggedWorkers,
  suspendWorker,
  getWorkerDocuments,
  getWorkerDocumentAccess,
  getAuditLogs,
} from "./adminController";
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

router.get("/workers", authenticateJWT, requireRole(UserRole.ADMIN), getWorkers);
router.patch("/workers/:id/verify", authenticateJWT, requireRole(UserRole.ADMIN), validateBody(VerifyWorkerDocumentReqSchema), verifyWorker);
router.get("/workers/:id/documents", authenticateJWT, requireRole(UserRole.ADMIN), validateParams(WorkerIdParamSchema), getWorkerDocuments);
router.get("/workers/:id/documents/:documentId/access", authenticateJWT, requireRole(UserRole.ADMIN), validateParams(WorkerIdAndDocumentIdParamSchema), getWorkerDocumentAccess);
router.get("/jobs", authenticateJWT, requireRole(UserRole.ADMIN), getAllJobs);
router.get("/flagged", authenticateJWT, requireRole(UserRole.ADMIN), getFlaggedWorkers);
router.post("/workers/:id/suspend", authenticateJWT, requireRole(UserRole.ADMIN), validateBody(SuspendWorkerReqSchema), suspendWorker);
router.get("/audit-logs", authenticateJWT, requireRole(UserRole.ADMIN), getAuditLogs);

export default router;

