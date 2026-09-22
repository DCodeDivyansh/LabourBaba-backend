import { Request, Response } from "express";
import { adminService } from "./adminServices";
import { VerifyWorkerDocumentReq, SuspendWorkerReq } from "../../type/api_req.type";
import { AuthenticatedRequest } from "../../middlewares/authMiddleware";
import { logger } from "../../utils/logger";

function handleAdminError(error: any, req: Request, res: Response): void {
  const reqLogger = (req as any).logger || logger;
  const statusCode = error.statusCode || error.status;
  if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
    res.status(statusCode).json({ success: false, code: error.code || "CLIENT_ERROR", message: error.message });
    return;
  }

  reqLogger.error("[adminController] Unexpected error:", { error: error?.message, stack: error?.stack });
  res.status(500).json({
    success: false,
    code: "INTERNAL_SERVER_ERROR",
    message: "An unexpected internal error occurred.",
  });
}

export const getWorkers = async (req: Request, res: Response): Promise<void> => {
  try {
    const workers = await adminService.getWorkers();
    res.status(200).json({ success: true, data: workers });
  } catch (error: any) {
    handleAdminError(error, req, res);
  }
};

export const verifyWorker = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params as any;
    const payload: VerifyWorkerDocumentReq = req.body;
    const adminId = (req as AuthenticatedRequest).user?.id || "admin-system";

    const worker = await adminService.verifyWorkerDocument(id, payload, adminId);

    res.status(200).json({ success: true, data: worker });
  } catch (error: any) {
    handleAdminError(error, req, res);
  }
};

export const getAuditLogs = async (req: Request, res: Response): Promise<void> => {
  try {
    const { auditService } = await import("../audit/audit.service");
    const { action, actorId, targetType, targetId, correlationId, page, limit } = req.query as any;

    const result = await auditService.queryAuditLogs({
      action: action ? String(action) : undefined,
      actorId: actorId ? String(actorId) : undefined,
      targetType: targetType ? String(targetType) : undefined,
      targetId: targetId ? String(targetId) : undefined,
      correlationId: correlationId ? String(correlationId) : undefined,
      page: page ? parseInt(String(page), 10) : 1,
      limit: limit ? parseInt(String(limit), 10) : 50,
    });

    res.status(200).json({ success: true, data: result });
  } catch (error: any) {
    handleAdminError(error, req, res);
  }
};

export const getAllJobs = async (req: Request, res: Response): Promise<void> => {
  try {
    const customerId = typeof req.query.customer_id === "string" ? req.query.customer_id : undefined;
    const jobs = await adminService.getAllJobs(customerId);
    res.status(200).json({ success: true, data: jobs });
  } catch (error: any) {
    handleAdminError(error, req, res);
  }
};

export const getFlaggedWorkers = async (req: Request, res: Response): Promise<void> => {
  try {
    const workers = await adminService.getFlaggedWorkers();
    res.status(200).json({ success: true, data: workers });
  } catch (error: any) {
    handleAdminError(error, req, res);
  }
};

export const suspendWorker = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params as any;
    const payload: SuspendWorkerReq = req.body;
    const adminId = (req as AuthenticatedRequest).user?.id || "unknown-admin";

    const result = await adminService.suspendWorker(id, payload, adminId);

    res.status(200).json({ success: true, data: result });
  } catch (error: any) {
    handleAdminError(error, req, res);
  }
};

export const getWorkerDocuments = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params as any;
    const documents = await adminService.getWorkerDocuments(id);
    res.status(200).json({ success: true, data: documents });
  } catch (error: any) {
    handleAdminError(error, req, res);
  }
};

export const getWorkerDocumentAccess = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id, documentId } = req.params as any;
    const adminId = (req as AuthenticatedRequest).user?.id || "unknown-admin";
    const accessDto = await adminService.getWorkerDocumentAccess(adminId, id, documentId);
    res.status(200).json({ success: true, data: accessDto });
  } catch (error: any) {
    handleAdminError(error, req, res);
  }
};

