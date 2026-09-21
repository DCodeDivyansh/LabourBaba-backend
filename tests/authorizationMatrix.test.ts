import request from "supertest";
import { app } from "../src/server";
import prisma from "../src/config/prisma";
import { signAccessToken } from "../src/utils/authUtils";
import { UserRole } from "../src/type/userRole";

describe("Issue 51 - Comprehensive Authorization Matrix & ABAC Security", () => {
  // Principals
  const CUSTOMER_A_ID = "00000000-0000-4001-a000-000000000001";
  const CUSTOMER_B_ID = "00000000-0000-4001-a000-000000000002";
  const SUSPENDED_CUSTOMER_ID = "00000000-0000-4001-a000-000000000003";

  const WORKER_A_ID = "00000000-0000-4001-b000-000000000001";
  const WORKER_B_ID = "00000000-0000-4001-b000-000000000002";
  const SUSPENDED_WORKER_ID = "00000000-0000-4001-b000-000000000003";

  const ADMIN_ID = "00000000-0000-4001-c000-000000000001";

  // Resources
  const JOB_A_ID = "00000000-0000-4001-d000-000000000001";
  const JOB_B_ID = "00000000-0000-4001-d000-000000000002";
  const REQ_A_ID = "00000000-0000-4001-e000-000000000001";
  const REQ_B_ID = "00000000-0000-4001-e000-000000000002";
  const BOOKING_A_ID = "00000000-0000-4001-f000-000000000001";
  const BOOKING_B_ID = "00000000-0000-4001-f000-000000000002";
  const DOCUMENT_A_ID = "00000000-0000-4001-9000-000000000001";

  // Tokens
  let tokenCustomerA: string;
  let tokenCustomerB: string;
  let tokenSuspendedCustomer: string;
  let tokenWorkerA: string;
  let tokenWorkerB: string;
  let tokenSuspendedWorker: string;
  let tokenAdmin: string;

  beforeAll(async () => {
    // Generate Tokens
    tokenCustomerA = signAccessToken({ id: CUSTOMER_A_ID, role: UserRole.CUSTOMER, phone: "+919800000001", name: "Customer A" });
    tokenCustomerB = signAccessToken({ id: CUSTOMER_B_ID, role: UserRole.CUSTOMER, phone: "+919800000002", name: "Customer B" });
    tokenSuspendedCustomer = signAccessToken({ id: SUSPENDED_CUSTOMER_ID, role: UserRole.CUSTOMER, phone: "+919800000003", name: "Suspended Customer" });

    tokenWorkerA = signAccessToken({ id: WORKER_A_ID, role: UserRole.WORKER, phone: "+919700000001", name: "Worker A" });
    tokenWorkerB = signAccessToken({ id: WORKER_B_ID, role: UserRole.WORKER, phone: "+919700000002", name: "Worker B" });
    tokenSuspendedWorker = signAccessToken({ id: SUSPENDED_WORKER_ID, role: UserRole.WORKER, phone: "+919700000003", name: "Suspended Worker" });

    tokenAdmin = signAccessToken({ id: ADMIN_ID, role: UserRole.ADMIN, phone: "+919600000001", name: "Admin User" });

    // Ensure Skill Category
    let category = await prisma.skill_category.findFirst();
    if (!category) {
      category = await prisma.skill_category.create({
        data: { name: "GeneralHelper", description: "Helper category" },
      });
    }

    // Seed Customers
    await prisma.customer.upsert({
      where: { id: CUSTOMER_A_ID },
      update: { phone: "+919800000001" },
      create: { id: CUSTOMER_A_ID, phone: "+919800000001", name: "Customer A", password: "hash" },
    });
    await prisma.customer.upsert({
      where: { id: CUSTOMER_B_ID },
      update: { phone: "+919800000002" },
      create: { id: CUSTOMER_B_ID, phone: "+919800000002", name: "Customer B", password: "hash" },
    });
    await prisma.customer.upsert({
      where: { id: SUSPENDED_CUSTOMER_ID },
      update: { phone: "+919800000003", deleted_at: new Date() },
      create: { id: SUSPENDED_CUSTOMER_ID, phone: "+919800000003", name: "Suspended Customer", password: "hash", deleted_at: new Date() },
    });

    // Seed Workers
    await prisma.worker.upsert({
      where: { id: WORKER_A_ID },
      update: { phone: "+919700000001", skill_category_id: category.id, verification_status: "verified" },
      create: { id: WORKER_A_ID, phone: "+919700000001", name: "Worker A", password: "hash", skill_type: "Helper", skill_category_id: category.id, verification_status: "verified" },
    });
    await prisma.worker.upsert({
      where: { id: WORKER_B_ID },
      update: { phone: "+919700000002", skill_category_id: category.id, verification_status: "verified" },
      create: { id: WORKER_B_ID, phone: "+919700000002", name: "Worker B", password: "hash", skill_type: "Helper", skill_category_id: category.id, verification_status: "verified" },
    });
    await prisma.worker.upsert({
      where: { id: SUSPENDED_WORKER_ID },
      update: { phone: "+919700000003", skill_category_id: category.id, verification_status: "suspended", deleted_at: new Date() },
      create: { id: SUSPENDED_WORKER_ID, phone: "+919700000003", name: "Suspended Worker", password: "hash", skill_type: "Helper", skill_category_id: category.id, verification_status: "suspended", deleted_at: new Date() },
    });

    // Seed Worker Document
    await prisma.worker_document.upsert({
      where: { id: DOCUMENT_A_ID },
      update: { worker_id: WORKER_A_ID },
      create: { id: DOCUMENT_A_ID, worker_id: WORKER_A_ID, document_type: "AADHAAR", status: "pending", file_url: "docs/aadhaar_a.pdf" },
    });

    // Seed Jobs & Requirements
    await prisma.job.upsert({
      where: { id: JOB_A_ID },
      update: { customer_id: CUSTOMER_A_ID },
      create: { id: JOB_A_ID, customer_id: CUSTOMER_A_ID, status: "OPEN" },
    });
    await prisma.job_requirement.upsert({
      where: { id: REQ_A_ID },
      update: { job_id: JOB_A_ID, skill_id: category.id },
      create: { id: REQ_A_ID, job_id: JOB_A_ID, skill_id: category.id, skill_type: "Helper", worker_count_needed: 2, worker_count_filled: 1, status: "OPEN" },
    });

    await prisma.job.upsert({
      where: { id: JOB_B_ID },
      update: { customer_id: CUSTOMER_B_ID },
      create: { id: JOB_B_ID, customer_id: CUSTOMER_B_ID, status: "OPEN" },
    });
    await prisma.job_requirement.upsert({
      where: { id: REQ_B_ID },
      update: { job_id: JOB_B_ID, skill_id: category.id },
      create: { id: REQ_B_ID, job_id: JOB_B_ID, skill_id: category.id, skill_type: "Helper", worker_count_needed: 1, worker_count_filled: 1, status: "OPEN" },
    });

    // Seed Bookings
    await prisma.booking.upsert({
      where: { id: BOOKING_A_ID },
      update: { customer_id: CUSTOMER_A_ID, worker_id: WORKER_A_ID, job_id: JOB_A_ID, requirement_id: REQ_A_ID },
      create: { id: BOOKING_A_ID, customer_id: CUSTOMER_A_ID, worker_id: WORKER_A_ID, job_id: JOB_A_ID, requirement_id: REQ_A_ID, status: "CONFIRMED" },
    });
    await prisma.booking.upsert({
      where: { id: BOOKING_B_ID },
      update: { customer_id: CUSTOMER_B_ID, worker_id: WORKER_B_ID, job_id: JOB_B_ID, requirement_id: REQ_B_ID },
      create: { id: BOOKING_B_ID, customer_id: CUSTOMER_B_ID, worker_id: WORKER_B_ID, job_id: JOB_B_ID, requirement_id: REQ_B_ID, status: "CONFIRMED" },
    });
  });

  afterAll(async () => {
    await prisma.booking.deleteMany({ where: { id: { in: [BOOKING_A_ID, BOOKING_B_ID] } } }).catch(() => {});
    await prisma.job_requirement.deleteMany({ where: { id: { in: [REQ_A_ID, REQ_B_ID] } } }).catch(() => {});
    await prisma.job.deleteMany({ where: { id: { in: [JOB_A_ID, JOB_B_ID] } } }).catch(() => {});
    await prisma.worker_document.deleteMany({ where: { id: DOCUMENT_A_ID } }).catch(() => {});
    await prisma.worker.deleteMany({ where: { id: { in: [WORKER_A_ID, WORKER_B_ID, SUSPENDED_WORKER_ID] } } }).catch(() => {});
    await prisma.customer.deleteMany({ where: { id: { in: [CUSTOMER_A_ID, CUSTOMER_B_ID, SUSPENDED_CUSTOMER_ID] } } }).catch(() => {});
    await prisma.$disconnect();
  });

  describe("1. Anonymous Request Rejection", () => {
    it("rejects unauthenticated requests to protected endpoints with 401", async () => {
      const res = await request(app).get(`/api/bookings/${BOOKING_A_ID}`);
      expect(res.status).toBe(401);
    });

    it("rejects unauthenticated requests to admin endpoints with 401", async () => {
      const res = await request(app).get("/api/admin/workers");
      expect(res.status).toBe(401);
    });
  });

  describe("2. Resource Ownership & Privacy (ABAC)", () => {
    it("allows Customer A to access their own booking A", async () => {
      const res = await request(app)
        .get(`/api/bookings/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${tokenCustomerA}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(BOOKING_A_ID);
    });

    it("allows Worker A to access booking A where they are assigned", async () => {
      const res = await request(app)
        .get(`/api/bookings/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${tokenWorkerA}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(BOOKING_A_ID);
    });

    it("rejects Customer B from accessing Customer A's booking A (404/403)", async () => {
      const res = await request(app)
        .get(`/api/bookings/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${tokenCustomerB}`);

      expect([403, 404]).toContain(res.status);
    });

    it("rejects Worker B from accessing Worker A's booking A (404/403)", async () => {
      const res = await request(app)
        .get(`/api/bookings/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${tokenWorkerB}`);

      expect([403, 404]).toContain(res.status);
    });

    it("allows Admin to access any booking for operational management", async () => {
      const res = await request(app)
        .get(`/api/bookings/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${tokenAdmin}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(BOOKING_A_ID);
    });
  });

  describe("3. Role-Based Access Control (RBAC)", () => {
    it("rejects Customer trying to access Admin endpoints with 403", async () => {
      const res = await request(app)
        .get("/api/admin/workers")
        .set("Authorization", `Bearer ${tokenCustomerA}`);

      expect(res.status).toBe(403);
    });

    it("rejects Worker trying to access Admin endpoints with 403", async () => {
      const res = await request(app)
        .get("/api/admin/workers")
        .set("Authorization", `Bearer ${tokenWorkerA}`);

      expect(res.status).toBe(403);
    });

    it("allows Admin to access admin endpoints", async () => {
      const res = await request(app)
        .get("/api/admin/workers")
        .set("Authorization", `Bearer ${tokenAdmin}`);

      expect(res.status).toBe(200);
    });
  });

  describe("4. Identity Spoofing & Body Manipulation Protection", () => {
    it("prevents Customer A from spoofing Customer B's identity in request payload", async () => {
      const res = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${tokenCustomerA}`)
        .send({
          customerId: CUSTOMER_B_ID, // Maliciously trying to create job for Customer B
          latitude: 28.6139,
          longitude: 77.2090,
          requirements: [{ skill_type: "Helper", worker_count_needed: 1, rate_per_day: 500 }],
        });

      if (res.status === 201) {
        // Must be assigned to authenticated Customer A, NOT spoofed Customer B
        expect(res.body.data.customer_id).toBe(CUSTOMER_A_ID);
        // Clean up created job
        await prisma.job_requirement.deleteMany({ where: { job_id: res.body.data.id } }).catch(() => {});
        await prisma.job.delete({ where: { id: res.body.data.id } }).catch(() => {});
      } else {
        expect(res.status).toBeLessThan(500);
      }
    });
  });

  describe("5. Input Validation & Error Safety", () => {
    it("returns safe 400 Bad Request on malformed UUID parameters, never 500", async () => {
      const res = await request(app)
        .get("/api/bookings/malformed-uuid-123")
        .set("Authorization", `Bearer ${tokenAdmin}`);

      expect([400, 404]).toContain(res.status);
    });

    it("returns safe 404 on non-existent valid UUID", async () => {
      const nonExistentUuid = "00000000-0000-4000-a000-999999999999";
      const res = await request(app)
        .get(`/api/bookings/${nonExistentUuid}`)
        .set("Authorization", `Bearer ${tokenAdmin}`);

      expect(res.status).toBe(404);
    });
  });
});
