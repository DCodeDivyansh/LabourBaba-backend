import prisma from "../../config/prisma";
import { VerifyWorkerDocumentReq, SuspendWorkerReq } from "../../type/api_req.type";
import {
  workerAdminSelect,
  toWorkerAdminDTO,
  customerSummarySelect,
  toJobDTO,
  toWorkerDocumentDTO,
  toWorkerDocumentAccessDTO,
} from "../../shared/prismaSelects";
import { storageService } from "../../providers/storage/storage.service";
import { AuthorizationError } from "../../policies";
import { SESSION_STATUS, REVOKE_REASON } from "../auth/session.types";
import { disconnectUserSockets } from "../../socket/socketLifecycle";
import { UserRole } from "../../type/userRole";

export const adminService = {
  async getWorkers() {
    const workers = await prisma.worker.findMany({
      select: workerAdminSelect,
    });
    return workers.map(toWorkerAdminDTO);
  },

  async verifyWorkerDocument(workerId: string, payload: VerifyWorkerDocumentReq) {
    return await prisma.$transaction(async (tx) => {
      // Find pending documents
      const docs = await tx.worker_document.findMany({
        where: { worker_id: workerId, status: "PENDING" }
      });
      if (docs.length === 0) throw new Error("No pending documents for this worker");

      // Update documents
      await tx.worker_document.updateMany({
        where: { worker_id: workerId, status: "PENDING" },
        data: { status: payload.status }
      });

      // Update worker overall status
      const workerStatus = payload.status === "VERIFIED" ? "verified" : "rejected";
      const updated = await tx.worker.update({
        where: { id: workerId },
        data: { verification_status: workerStatus },
        select: workerAdminSelect,
      });
      return toWorkerAdminDTO(updated);
    });
  },

  async getAllJobs(customerId?: string) {
    const whereClause = customerId ? { customer_id: customerId } : undefined;
    const jobs = await prisma.job.findMany({
      where: whereClause,
      include: {
        customer: {
          select: customerSummarySelect,
        },
        job_requirement: true,
      }
    });
    return jobs.map(toJobDTO).filter(Boolean);
  },

  async getFlaggedWorkers() {
    // High decline or timeout count logic
    const workers = await prisma.worker.findMany({
      where: {
        OR: [
          { decline_count: { gt: 5 } },
          { timeout_count: { gt: 5 } }
        ]
      },
      select: workerAdminSelect,
    });
    return workers.map(toWorkerAdminDTO);
  },

  async suspendWorker(workerId: string, payload: SuspendWorkerReq, adminId?: string) {
    // 1. Validate target worker exists
    const existing = await prisma.worker.findUnique({
      where: { id: workerId },
      select: { id: true, verification_status: true, deleted_at: true },
    });

    if (existing === null) {
      throw new AuthorizationError("Worker not found", 404, "WORKER_NOT_FOUND");
    }

    const prevStatus = existing?.verification_status || "pending";
    const suspensionTime = new Date();

    // 2. Atomic transaction: update worker status AND revoke all refresh sessions
    const { updated, revokedCount } = await prisma.$transaction(async (tx) => {
      const workerRow = await tx.worker.update({
        where: { id: workerId },
        data: {
          verification_status: "suspended",
          deleted_at: suspensionTime,
        },
        select: workerAdminSelect,
      });

      const sessionRevocation = tx.refresh_session?.updateMany
        ? await tx.refresh_session.updateMany({
            where: {
              user_id: workerId,
              status: { in: [SESSION_STATUS.ACTIVE, SESSION_STATUS.ROTATED] },
            },
            data: {
              status: SESSION_STATUS.REVOKED,
              revoked_at: suspensionTime,
              revoked_reason: REVOKE_REASON.SUSPENDED,
            },
          })
        : { count: 0 };

      return { updated: workerRow, revokedCount: sessionRevocation.count };
    });

    // 3. Post-transaction: Force disconnect all active Socket.IO connections for the worker
    disconnectUserSockets(workerId, UserRole.WORKER);

    // 4. Emit durable, structured audit log describing the status change
    console.log(
      `[AUDIT] Action: WORKER_SUSPENDED | Actor: ${adminId || "unknown-admin"} (admin) | ` +
      `Target: ${workerId} | PrevStatus: ${prevStatus} | NewStatus: suspended | ` +
      `Reason: ${payload.reason || "Administrative suspension"} | ` +
      `RevokedSessions: ${revokedCount} | Timestamp: ${suspensionTime.toISOString()}`
    );

    return toWorkerAdminDTO(updated);
  },

  async getWorkerDocuments(workerId: string) {
    const docs = await prisma.worker_document.findMany({
      where: { worker_id: workerId },
    });
    return docs.map(toWorkerDocumentDTO).filter(Boolean);
  },

  async getWorkerDocumentAccess(adminId: string, workerId: string, documentId: string) {
    const doc = await prisma.worker_document.findFirst({
      where: { id: documentId, worker_id: workerId },
    });

    if (!doc) {
      throw new AuthorizationError("Document not found for this worker", 404, "DOCUMENT_NOT_FOUND");
    }

    const key = doc.file_url || storageService.generateDocumentKey(doc.worker_id, "pdf");
    const signed = await storageService.getSignedDownloadUrl(key);

    // Durable audit logging of privileged admin access without exposing the signed URL
    console.log(`[AUDIT] Admin ${adminId} viewed document ${documentId} of worker ${workerId} at ${new Date().toISOString()}`);

    return toWorkerDocumentAccessDTO(doc, signed.url, signed.expiresIn);
  }
};

