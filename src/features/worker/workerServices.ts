import prisma from "../../config/prisma";
import { CreateWorkerReq, UpdateWorkerProfileReq, UpdateWorkerLocationReq, UpdateWorkerOnlineStatusReq, UploadWorkerDocumentReq, RegisterWorkerDeviceReq } from "../../type/api_req.type";
import { workerLocationService } from "../worker_location/worker_location.service";
import { workerDeviceService } from "../worker_device/worker_device.service";
import { hashPassword, normalizePhoneToE164 } from "../../utils/authUtils";
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
import { skillService } from "../skill/skill.service";

export const workerService = {
  async register(payload: CreateWorkerReq) {
    const phone = normalizePhoneToE164(payload.phone);
    const existingWorker = await prisma.worker.findUnique({
      where: { phone },
    });
    if (existingWorker) {
      const err: any = new Error("Worker with this phone number already exists");
      err.code = "PHONE_ALREADY_REGISTERED";
      throw err;
    }

    // Resolve canonical skill ID
    let canonicalSkillId = payload.skill_category_id;
    if (!canonicalSkillId && payload.skill_type) {
      const resolved = await skillService.resolveSkillId(payload.skill_type);
      if (resolved) canonicalSkillId = resolved;
    }

    if (!canonicalSkillId) {
      const err: any = new Error("Valid skill_category_id or resolvable skill_type is required");
      err.statusCode = 400;
      throw err;
    }

    const hashedPassword = await hashPassword(payload.password);
    try {
      const worker = await prisma.worker.create({
        data: {
          name: payload.name,
          skill_category_id: canonicalSkillId,
          phone,
          password: hashedPassword,
          skill_type: payload.skill_type || "General",
          aadhaar_last4: payload.aadhaar_last4,
          device_token: payload.device_token,
        },
        select: workerSelfSelect,
      });

      // Populate worker_skill relation
      if (worker.id && worker.skill_category_id && typeof (prisma as any).worker_skill?.upsert === "function") {
        try {
          await (prisma as any).worker_skill.upsert({
            where: {
              worker_id_skill_id: {
                worker_id: worker.id,
                skill_id: worker.skill_category_id,
              },
            },
            create: {
              worker_id: worker.id,
              skill_id: worker.skill_category_id,
            },
            update: {},
          });
        } catch (wsErr: any) {
          console.warn(`[workerService] Could not write initial worker_skill: ${wsErr?.message}`);
        }
      }

      return toWorkerSelfDTO(worker);
    } catch (createErr: any) {
      if (createErr.code === "P2002") {
        const err: any = new Error("Worker with this phone number already exists");
        err.code = "PHONE_ALREADY_REGISTERED";
        throw err;
      }
      throw createErr;
    }
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
    const updateData: any = { ...payload };
    if (payload.phone) {
      updateData.phone = normalizePhoneToE164(payload.phone);
    }
    if ((payload as any).skill_category_id) {
      updateData.skill_category_id = (payload as any).skill_category_id;
    }
    try {
      const updated = await prisma.worker.update({
        where: { id: workerId },
        data: updateData,
        select: workerSelfSelect,
      });

      // Update worker_skill if skill_category_id changed
      if (updateData.skill_category_id && typeof (prisma as any).worker_skill?.upsert === "function") {
        try {
          await (prisma as any).worker_skill.upsert({
            where: {
              worker_id_skill_id: {
                worker_id: workerId,
                skill_id: updateData.skill_category_id,
              },
            },
            create: {
              worker_id: workerId,
              skill_id: updateData.skill_category_id,
            },
            update: {},
          });
        } catch (wsErr: any) {
          console.warn(`[workerService] Could not write worker_skill on update: ${wsErr?.message}`);
        }
      }

      return toWorkerSelfDTO(updated);
    } catch (updateErr: any) {
      if (updateErr.code === "P2002") {
        const err: any = new Error("Phone number is already in use by another worker");
        err.code = "PHONE_ALREADY_REGISTERED";
        throw err;
      }
      throw updateErr;
    }
  },

  async getSkills(workerId: string) {
    return skillService.getWorkerSkills(workerId);
  },

  async addSkills(workerId: string, skillIds: string[]) {
    return skillService.assignWorkerSkills(workerId, skillIds);
  },

  async removeSkill(workerId: string, skillId: string) {
    await skillService.removeWorkerSkill(workerId, skillId);
    return skillService.getWorkerSkills(workerId);
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
