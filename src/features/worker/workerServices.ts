import prisma from "../../config/prisma";
import { CreateWorkerReq, UpdateWorkerProfileReq, UpdateWorkerLocationReq, UpdateWorkerOnlineStatusReq, UploadWorkerDocumentReq } from "../../type/api_req.type";
import { workerLocationService } from "../worker_location/worker_location.service";
import { hashPassword } from "../../utils/authUtils";
import {
  workerSelfSelect,
  toWorkerSelfDTO,
  customerSummarySelect,
  bookingSafeSelect,
  toBookingDTO,
} from "../../shared/prismaSelects";

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

  async updateDeviceToken(workerId: string, deviceToken: string) {
    await prisma.worker.update({
      where: { id: workerId },
      data: { device_token: deviceToken },
      select: { id: true },
    });
    return { success: true };
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
    return await prisma.worker_document.create({
      data: {
        worker_id: workerId,
        document_type: payload.document_type,
        file_url: payload.file_url,
        status: "PENDING"
      }
    });
  },

  async getDocuments(workerId: string) {
    return await prisma.worker_document.findMany({
      where: { worker_id: workerId }
    });
  },

  async getAnalytics(workerId: string) {
    return await prisma.worker_analytics.findUnique({
      where: { worker_id: workerId }
    });
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
    return bookings.map(toBookingDTO);
  },

  async getEarnings(workerId: string) {
    const payments = await prisma.payment.findMany({
      where: { booking: { worker_id: workerId }, status: "COMPLETED" },
      select: { amount: true },
    });
    return payments.reduce((acc, curr) => acc + (curr.amount || 0), 0);
  }
};

