import prisma from "../../config/prisma";
import { VerifyWorkerDocumentReq, SuspendWorkerReq } from "../../type/api_req.type";
import {
  workerAdminSelect,
  toWorkerAdminDTO,
  customerSummarySelect,
  toCustomerSummaryDTO,
} from "../../shared/prismaSelects";

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
    return jobs.map((job: any) => {
      const j = { ...job };
      if (j.customer) {
        j.customer = toCustomerSummaryDTO(j.customer);
      }
      return j;
    });
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

  async suspendWorker(workerId: string, payload: SuspendWorkerReq) {
    const updated = await prisma.worker.update({
      where: { id: workerId },
      data: { verification_status: "suspended", deleted_at: new Date() },
      select: workerAdminSelect,
    });
    return toWorkerAdminDTO(updated);
  }
};

