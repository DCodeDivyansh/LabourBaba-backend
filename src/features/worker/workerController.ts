import { Request, Response } from "express";
import { workerService } from "./workerServices";
import { CreateWorkerReq, LoginWorkerReq, UpdateWorkerProfileReq, UpdateWorkerLocationReq, UpdateWorkerOnlineStatusReq, UploadWorkerDocumentReq } from "../../type/api_req.type";
import { AuthenticatedRequest, UserRole } from "../../middlewares/authMiddleware";
import { comparePassword, generateToken, normalizePhoneToE164 } from "../../utils/authUtils";
import prisma from "../../config/prisma";
import { workerPolicy, assertPolicy, AuthorizationError } from "../../policies";
import { sessionService } from "../auth/session.service";
import { logger } from "../../utils/logger";

const getWorkerId = (req: Request) => {
  return (req as AuthenticatedRequest).user?.id || null;
};

function handleWorkerError(error: any, req: Request, res: Response): void {
  const reqLogger = (req as any).logger || logger;
  if (error instanceof AuthorizationError || error.statusCode === 403) {
    res.status(403).json({ success: false, code: "FORBIDDEN", message: error.message || "Forbidden" });
    return;
  }
  if (error.code === "PHONE_ALREADY_REGISTERED" || error.code === "P2002") {
    res.status(409).json({ success: false, code: "PHONE_ALREADY_REGISTERED", message: "Worker with this phone number already exists" });
    return;
  }
  if (error.code === "INVALID_PHONE_NUMBER") {
    res.status(422).json({ success: false, code: "INVALID_PHONE_NUMBER", message: error.message || "Invalid phone number" });
    return;
  }
  if (typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
    res.status(error.statusCode).json({ success: false, code: error.code || "CLIENT_ERROR", message: error.message });
    return;
  }

  // 500 / Unexpected error: Log server-side with structured logger, return safe generic message
  reqLogger.error("[workerController] Unexpected error:", { error: error?.message, stack: error?.stack });
  res.status(500).json({
    success: false,
    code: "INTERNAL_SERVER_ERROR",
    message: "An unexpected internal error occurred.",
  });
}

export const loginWorker = async (req: Request, res: Response): Promise<void> => {
  try {
    const { phone: rawPhone, password }: LoginWorkerReq = req.body;
    const phone = normalizePhoneToE164(rawPhone);
    const worker = await prisma.worker.findUnique({
      where: { phone },
    });
    if (!worker || worker.deleted_at || worker.verification_status === "suspended") {
      res.status(401).json({ success: false, message: "Invalid phone number or password" });
      return;
    }
    const isPasswordValid = await comparePassword(password, worker.password);
    if (!isPasswordValid) {
      res.status(401).json({ success: false, message: "Invalid phone number or password" });
      return;
    }
    const token = generateToken({
      id: worker.id,
      phone: worker.phone,
      role: UserRole.WORKER,
    });

    // Create server-side refresh session
    const sessionResult = await sessionService.createSession({
      userId: worker.id,
      userRole: UserRole.WORKER,
      userAgent: req.headers["user-agent"],
      ipAddress: req.ip,
    });

    res.status(200).json({
      success: true,
      message: "Worker logged in successfully",
      data: {
        id: worker.id,
        phone: worker.phone,
        name: worker.name,
        skill_type: worker.skill_type,
        verification_status: worker.verification_status,
      },
      token,
      refreshToken: sessionResult.rawToken,
    });
  } catch (error: any) {
    handleWorkerError(error, req, res);
  }
};

export const registerWorker = async (req: Request, res: Response): Promise<void> => {
  try {
    const payload: CreateWorkerReq = req.body;
    const worker = await workerService.register(payload);
    res.status(201).json({ success: true, data: worker });
  } catch (error: any) {
    handleWorkerError(error, req, res);
  }
};

export const getMe = async (req: Request, res: Response): Promise<void> => {
  try {
    const workerId = getWorkerId(req);
    if (!workerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const worker = await workerService.getProfile(workerId);
    res.status(200).json({ success: true, data: worker });
  } catch (error: any) {
    handleWorkerError(error, req, res);
  }
};

export const updateMe = async (req: Request, res: Response): Promise<void> => {
  try {
    const workerId = getWorkerId(req);
    if (!workerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const payload: UpdateWorkerProfileReq = req.body;
    const worker = await workerService.updateProfile(workerId, payload);
    res.status(200).json({ success: true, data: worker });
  } catch (error: any) {
    handleWorkerError(error, req, res);
  }
};

export const updateLocation = async (req: Request, res: Response): Promise<void> => {
  try {
    const workerId = getWorkerId(req);
    if (!workerId) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }

    // Defense-in-depth: reject client-supplied identity in body, query, or params
    if (
      (req.body as any)?.worker_id ||
      (req.body as any)?.workerId ||
      (req.query as any)?.worker_id ||
      (req.query as any)?.workerId ||
      (req.params as any)?.worker_id ||
      (req.params as any)?.workerId
    ) {
      res.status(400).json({
        success: false,
        message: "Client-controlled worker identity is not permitted",
      });
      return;
    }

    const payload: UpdateWorkerLocationReq = req.body;
    const location = await workerService.updateLocation(workerId, payload);
    res.status(200).json({ success: true, data: location });
  } catch (error: any) {
    handleWorkerError(error, req, res);
  }
};

export const updateOnline = async (req: Request, res: Response): Promise<void> => {
  try {
    const workerId = getWorkerId(req);
    if (!workerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const payload: UpdateWorkerOnlineStatusReq = req.body;
    const worker = await workerService.updateOnlineStatus(workerId, payload);
    res.status(200).json({ success: true, data: worker });
  } catch (error: any) {
    handleWorkerError(error, req, res);
  }
};

export const uploadDocuments = async (req: Request, res: Response): Promise<void> => {
  try {
    const actor = (req as AuthenticatedRequest).user;
    if (!actor?.id) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    assertPolicy(workerPolicy.canUploadDocuments(actor, actor.id));

    if (req.body?.worker_id && req.body.worker_id !== actor.id) {
      res.status(400).json({ success: false, message: "Client-controlled worker identity is not permitted" });
      return;
    }

    const payload: UploadWorkerDocumentReq = req.body;
    const document = await workerService.uploadDocument(actor.id, payload);
    res.status(201).json({ success: true, data: document });
  } catch (error: any) {
    handleWorkerError(error, req, res);
  }
};

export const requestUploadUrl = async (req: Request, res: Response): Promise<void> => {
  try {
    const actor = (req as AuthenticatedRequest).user;
    if (!actor?.id) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    assertPolicy(workerPolicy.canUploadDocuments(actor, actor.id));
    const { document_type, file_extension } = req.body;
    const result = await workerService.requestUploadUrl(actor.id, document_type, file_extension);
    res.status(200).json({ success: true, data: result });
  } catch (error: any) {
    handleWorkerError(error, req, res);
  }
};

export const getDocuments = async (req: Request, res: Response): Promise<void> => {
  try {
    const actor = (req as AuthenticatedRequest).user;
    if (!actor?.id) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    assertPolicy(workerPolicy.canReadDocuments(actor, actor.id));
    const documents = await workerService.getDocuments(actor.id);
    res.status(200).json({ success: true, data: documents });
  } catch (error: any) {
    handleWorkerError(error, req, res);
  }
};

export const getDocumentAccess = async (req: Request, res: Response): Promise<void> => {
  try {
    const actor = (req as AuthenticatedRequest).user;
    if (!actor?.id) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const { documentId } = req.params as any;
    const accessDto = await workerService.getDocumentAccessUrl(actor, documentId);
    res.status(200).json({ success: true, data: accessDto });
  } catch (error: any) {
    handleWorkerError(error, req, res);
  }
};

export const getAnalytics = async (req: Request, res: Response): Promise<void> => {
  try {
    const workerId = getWorkerId(req);
    if (!workerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const analytics = await workerService.getAnalytics(workerId);
    res.status(200).json({ success: true, data: analytics });
  } catch (error: any) {
    handleWorkerError(error, req, res);
  }
};

export const getBookings = async (req: Request, res: Response): Promise<void> => {
  try {
    const workerId = getWorkerId(req);
    if (!workerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const bookings = await workerService.getBookings(workerId);
    res.status(200).json({ success: true, data: bookings });
  } catch (error: any) {
    handleWorkerError(error, req, res);
  }
};

export const getEarnings = async (req: Request, res: Response): Promise<void> => {
  try {
    const workerId = getWorkerId(req);
    if (!workerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const earnings = await workerService.getEarnings(workerId);
    res.status(200).json({ success: true, data: { earnings } });
  } catch (error: any) {
    handleWorkerError(error, req, res);
  }
};

export const updateDeviceToken = async (req: Request, res: Response): Promise<void> => {
  try {
    const workerId = (req as any).user?.id;
    if (!workerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }

    if (req.body?.worker_id && req.body.worker_id !== workerId) {
      res.status(400).json({ success: false, message: "Client-controlled worker identity is not permitted" });
      return;
    }

    const { device_token, device_id, platform } = req.body;
    await workerService.updateDeviceToken(workerId, device_token, device_id, platform);
    res.status(200).json({ success: true, message: "Device token updated" });
  } catch (error: any) {
    handleWorkerError(error, req, res);
  }
};

export const registerDevice = async (req: Request, res: Response): Promise<void> => {
  try {
    const workerId = (req as any).user?.id;
    if (!workerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }

    if (req.body?.worker_id && req.body.worker_id !== workerId) {
      res.status(400).json({ success: false, message: "Client-controlled worker identity is not permitted" });
      return;
    }

    const device = await workerService.registerDevice(workerId, req.body);
    res.status(201).json({ success: true, data: device });
  } catch (error: any) {
    handleWorkerError(error, req, res);
  }
};

export const revokeDevice = async (req: Request, res: Response): Promise<void> => {
  try {
    const workerId = (req as any).user?.id;
    if (!workerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }

    const deviceId = (req.params as any)?.deviceId || req.body?.device_id;
    if (!deviceId) {
      res.status(400).json({ success: false, message: "deviceId is required" });
      return;
    }

    const result = await workerService.revokeDevice(workerId, deviceId);
    res.status(200).json({ success: true, data: result, message: "Device revoked successfully" });
  } catch (error: any) {
    handleWorkerError(error, req, res);
  }
};

export const getDevices = async (req: Request, res: Response): Promise<void> => {
  try {
    const workerId = (req as any).user?.id;
    if (!workerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }

    const devices = await workerService.listDevices(workerId);
    res.status(200).json({ success: true, data: devices });
  } catch (error: any) {
    handleWorkerError(error, req, res);
  }
};
