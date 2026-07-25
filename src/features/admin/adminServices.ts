import prisma from "../../config/prisma";
import { VerifyWorkerDocumentReq, SuspendWorkerReq } from "../../type/api_req.type";

export const adminService = {
  async getWorkers() {
    return await prisma.worker.findMany({
      include: {
        worker_document: true
      }
    });
  },

  async verifyWorkerDocument(workerId: string, payload: VerifyWorkerDocumentReq) {
    // Mock updating the worker verification status based on the document
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
      return await tx.worker.update({
        where: { id: workerId },
        data: { verification_status: workerStatus }
      });
    });
  },

  async getAllJobs() {
    return await prisma.job.findMany({
      include: { customer: true, category: true, job_requirement: true }
    });
  },

  async getFlaggedWorkers() {
    // High decline or timeout count logic
    return await prisma.worker.findMany({
      where: {
        OR: [
          { decline_count: { gt: 5 } },
          { timeout_count: { gt: 5 } }
        ]
      }
    });
  },

  async suspendWorker(workerId: string, payload: SuspendWorkerReq) {
    // Implementation of suspension might just be setting verification_status or a new status column
    // For this mock, we use a deleted_at soft delete, or we can just return success
    return await prisma.worker.update({
      where: { id: workerId },
      data: { verification_status: "suspended", deleted_at: new Date() }
    });
  }
};
