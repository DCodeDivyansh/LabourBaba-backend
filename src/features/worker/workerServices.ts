import prisma from "../../config/prisma";
import { CreateWorkerReq, UpdateWorkerProfileReq, UpdateWorkerLocationReq, UpdateWorkerOnlineStatusReq, UploadWorkerDocumentReq, RegisterWorkerDeviceReq } from "../../type/api_req.type";
import { workerLocationService } from "../worker_location/worker_location.service";
import { workerDeviceService } from "../worker_device/worker_device.service";
import { hashPassword } from "../../utils/authUtils";
import {
  workerSelfSelect,
  toWorkerSelfDTO,
  customerSummarySelect,
  bookingSafeSelect,
  toBookingDTO,
  toWorkerDocumentDTO,
  toWorkerDocumentAccessDTO,
  toWorkerAnalyticsDTO,
} from "../../shared/prismaSelects";
import { storageService } from "../../providers/storage/storage.service";
import { workerPolicy, assertPolicy, AuthorizationError, AuthenticatedUser } from "../../policies";

export const workerService = {
  async register(payload: CreateWorkerReq) {
    const hashedPassword = await hashPassword(payload.password);
    const worker = await prisma.worker.create({
      data: {
        name: payload.name,
        skill_category_id: payload.skill_category_id,
        phone: payload.phone,
        password: hashedPassword,
        skill_type: payload.skill_type,
        aadhaar_last4: payload.aadhaar_last4,
        device_token: payload.device_token,
      },
      select: workerSelfSelect,
    });
    return toWorkerSelfDTO(worker);
  },

  async getProfile(workerId: string) {
    const worker = await prisma.worker.findUnique({
      where: { id: workerId },
      select: workerSelfSelect,
    });
    if (!worker) throw new Error("Worker not found");
    return toWorkerSelfDTO(worker);
  },

  async updateProfile(workerId: string, payload: UpdateWorkerProfileReq) {
    const updated = await prisma.worker.update({
      where: { id: workerId },
      data: payload,
      select: workerSelfSelect,
    });
    return toWorkerSelfDTO(updated);
  },

  async updateLocation(workerId: string, payload: UpdateWorkerLocationReq) {
    return workerLocationService.updateLocation(workerId, payload.latitude, payload.longitude);
  },

  async updateDeviceToken(workerId: string, deviceToken: string, deviceId?: string, platform?: string) {
    await workerDeviceService.registerDevice(workerId, {
      device_token: deviceToken,
      device_id: deviceId,
      platform: platform as any,
    });
    return { success: true };
  },

  async registerDevice(workerId: string, payload: RegisterWorkerDeviceReq) {
    return workerDeviceService.registerDevice(workerId, payload);
  },

  async revokeDevice(workerId: string, deviceId: string) {
    return workerDeviceService.revokeDevice(workerId, deviceId);
  },

  async listDevices(workerId: string) {
    return workerDeviceService.listDevices(workerId);
  },

  async updateOnlineStatus(workerId: string, payload: UpdateWorkerOnlineStatusReq) {
    const updated = await prisma.worker.update({
      where: { id: workerId },
      data: { is_online: payload.is_online },
      select: workerSelfSelect,
    });
    return toWorkerSelfDTO(updated);
  },

  async uploadDocument(workerId: string, payload: UploadWorkerDocumentReq) {
    if (payload.worker_id && payload.worker_id !== workerId) {
      throw new AuthorizationError("Cannot upload documents for another worker", 403, "NOT_OWNER");
    }

    // Validate that client is not attaching another worker's private storage key
    const normalizedKey = storageService.normalizeObjectKey(payload.file_url);
    if (normalizedKey.startsWith("workers/") && !normalizedKey.startsWith(`workers/${workerId}/`)) {
      throw new AuthorizationError("Cannot attach document key belonging to another worker", 403, "DOCUMENT_ATTACHMENT_FORBIDDEN");
    }

    const doc = await prisma.worker_document.create({
      data: {
        worker_id: workerId,
        document_type: payload.document_type,
        file_url: normalizedKey || payload.file_url,
        status: "PENDING"
      }
    });
    return toWorkerDocumentDTO(doc);
  },

  async requestUploadUrl(workerId: string, documentType: string, extension?: string) {
    const key = storageService.generateDocumentKey(workerId, extension || "pdf");
    const result = await storageService.getSignedUploadUrl(key, "application/octet-stream");
    return {
      upload_url: result.uploadUrl,
      object_key: result.objectKey,
      expires_in: result.expiresIn,
      expires_at: result.expiresAt,
    };
  },

  async getDocumentAccessUrl(actor: AuthenticatedUser, documentId: string) {
    const doc = await prisma.worker_document.findUnique({
      where: { id: documentId },
    });

    if (!doc) {
      throw new AuthorizationError("Document not found", 404, "DOCUMENT_NOT_FOUND");
    }

    assertPolicy(workerPolicy.canReadDocument(actor, doc));

    const key = doc.file_url || storageService.generateDocumentKey(doc.worker_id, "pdf");
    const signed = await storageService.getSignedDownloadUrl(key);

    return toWorkerDocumentAccessDTO(doc, signed.url, signed.expiresIn);
  },

  async getDocuments(workerId: string) {
    const docs = await prisma.worker_document.findMany({
      where: { worker_id: workerId }
    });
    return docs.map(toWorkerDocumentDTO).filter(Boolean);
  },

  async getAnalytics(workerId: string) {
    const analytics = await prisma.worker_analytics.findUnique({
      where: { worker_id: workerId }
    });
    return toWorkerAnalyticsDTO(analytics);
  },

  async getBookings(workerId: string) {
    const bookings = await prisma.booking.findMany({
      where: { worker_id: workerId },
      select: {
        ...bookingSafeSelect,
        job: true,
        customer: {
          select: customerSummarySelect,
        },
        job_requirement: true,
      },
    });
    return bookings.map(toBookingDTO).filter(Boolean);
  },

  async getEarnings(workerId: string) {
    const payments = await prisma.payment.findMany({
      where: { booking: { worker_id: workerId }, status: "COMPLETED" },
      select: { amount: true },
    });
    return payments.reduce((acc, curr) => acc + (curr.amount || 0), 0);
  }
};

