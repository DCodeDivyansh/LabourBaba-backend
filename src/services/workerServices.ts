import prisma from "../config/prisma";
import { CreateWorkerReq, UpdateWorkerProfileReq, UpdateWorkerLocationReq, UpdateWorkerOnlineStatusReq, UploadWorkerDocumentReq } from "../type/api_req.type";
import { hashPassword } from "../utils/authUtils";
export const workerService = {
  async register(payload: CreateWorkerReq) {
    const hashedPassword = await hashPassword(payload.password);
    return await prisma.worker.create({
      data: {
        name: payload.name,
        skill_category_id: payload.skill_category_id,
        phone: payload.phone,
        password: hashedPassword,
        skill_type: payload.skill_type,
        aadhaar_last4: payload.aadhaar_last4,
        device_token: payload.device_token,
      }
    });
  },

  async getProfile(workerId: string) {
    const worker = await prisma.worker.findUnique({
      where: { id: workerId },
      include: { skill_category: true }
    });
    if (!worker) throw new Error("Worker not found");
    return worker;
  },

  async updateProfile(workerId: string, payload: UpdateWorkerProfileReq) {
    return await prisma.worker.update({
      where: { id: workerId },
      data: payload
    });
  },

  async updateLocation(workerId: string, payload: UpdateWorkerLocationReq) {
    // In a real application, also update redis for fast geo queries
    const worker_location = await prisma.worker_location.create({
      data: {
        worker_id: workerId,
        // PostGIS integration for location_geo omitted for brevity; update longitude/latitude separately if added to model
      }
    });

    await prisma.$executeRaw`
      UPDATE worker_location
      SET location_geo = ST_SetSRID(
        ST_MakePoint(${payload.longitude}, ${payload.latitude}),
        4326
      )::geography
      WHERE id = ${worker_location.id}::uuid;
    `;
    return worker_location;
  },

  async updateOnlineStatus(workerId: string, payload: UpdateWorkerOnlineStatusReq) {
    return await prisma.worker.update({
      where: { id: workerId },
      data: { is_online: payload.is_online }
    });
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
    return await prisma.booking.findMany({
      where: { worker_id: workerId },
      include: { job: true, customer: true, job_requirement: true }
    });
  },

  async getEarnings(workerId: string) {
    const payments = await prisma.payment.findMany({
      where: { booking: { worker_id: workerId }, status: "COMPLETED" },
      include: { booking: true }
    });
    return payments.reduce((acc, curr) => acc + (curr.amount || 0), 0);
  }
};
