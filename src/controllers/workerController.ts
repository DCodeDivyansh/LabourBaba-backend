import { Request, Response } from "express";
import { workerService } from "../services/workerServices";
import { CreateWorkerReq, LoginWorkerReq, UpdateWorkerProfileReq, UpdateWorkerLocationReq, UpdateWorkerOnlineStatusReq, UploadWorkerDocumentReq } from "../type/api_req.type";
import { AuthenticatedRequest } from "../middlewares/authMiddleware";
import { comparePassword, generateToken } from "../utils/authUtils";
import prisma from "../config/prisma";

const getWorkerId = (req: Request) => {
  return (req as AuthenticatedRequest).user?.id || null;
};

export const loginWorker = async (req: Request, res: Response): Promise<void> => {
  try {
    const { phone, password }: LoginWorkerReq = req.body;
    const worker = await prisma.worker.findUnique({
      where: { phone },
    });
    if (!worker) {
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
      role: "worker",
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
    });
    console.log(token)
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const registerWorker = async (req: Request, res: Response): Promise<void> => {
  try {
    const payload: CreateWorkerReq = req.body;
    const worker = await workerService.register(payload);
    res.status(201).json({ success: true, data: worker });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getMe = async (req: Request, res: Response): Promise<void> => {
  try {
    const workerId = getWorkerId(req);
    if (!workerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const worker = await workerService.getProfile(workerId);
    res.status(200).json({ success: true, data: worker });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
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
    res.status(500).json({ success: false, message: error.message });
  }
};

export const updateLocation = async (req: Request, res: Response): Promise<void> => {
  try {
    const workerId = getWorkerId(req);
    if (!workerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    console.log(req.body)
    const payload: UpdateWorkerLocationReq = req.body;
    const location = await workerService.updateLocation(workerId, payload);
    res.status(200).json({ success: true, data: location });
  } catch (error: any) {
    console.log(error.message)
    res.status(500).json({ success: false, message: error.message });
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
    res.status(500).json({ success: false, message: error.message });
  }
};

export const uploadDocuments = async (req: Request, res: Response): Promise<void> => {
  try {
    const workerId = getWorkerId(req);
    if (!workerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const payload: UploadWorkerDocumentReq = req.body;
    const document = await workerService.uploadDocument(workerId, payload);
    res.status(201).json({ success: true, data: document });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getDocuments = async (req: Request, res: Response): Promise<void> => {
  try {
    const workerId = getWorkerId(req);
    if (!workerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const documents = await workerService.getDocuments(workerId);
    res.status(200).json({ success: true, data: documents });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getAnalytics = async (req: Request, res: Response): Promise<void> => {
  try {
    const workerId = getWorkerId(req);
    if (!workerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const analytics = await workerService.getAnalytics(workerId);
    res.status(200).json({ success: true, data: analytics });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getBookings = async (req: Request, res: Response): Promise<void> => {
  try {
    const workerId = getWorkerId(req);
    if (!workerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const bookings = await workerService.getBookings(workerId);
    res.status(200).json({ success: true, data: bookings });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getEarnings = async (req: Request, res: Response): Promise<void> => {
  try {
    const workerId = getWorkerId(req);
    if (!workerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const earnings = await workerService.getEarnings(workerId);
    res.status(200).json({ success: true, data: { earnings } });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const updateDeviceToken = async (req: Request, res: Response): Promise<void> => {
  try {
    const workerId = (req as any).user?.id;
    if (!workerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const { device_token } = req.body;
    await workerService.updateDeviceToken(workerId, device_token);
    res.status(200).json({ success: true, message: "Device token updated" });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};
