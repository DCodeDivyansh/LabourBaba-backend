import request from "supertest";
import { app } from "../src/server";
import prisma from "../src/config/prisma";
import { hashPassword } from "../src/utils/authUtils";

// Mock the prisma client
jest.mock("../src/config/prisma", () => ({
  __esModule: true,
  default: {
    worker: {
      create: jest.fn(),
      findUnique: jest.fn(),
    },
    refresh_session: {
      create: jest.fn().mockResolvedValue({
        id: "mock-session-id",
        family_id: "mock-family-id",
        expires_at: new Date(Date.now() + 30 * 86400000),
      }),
    },
  },
}));

describe("Worker Authentication API Tests", () => {
  beforeEach(() => {
    ((prisma as any).refresh_session.create as jest.Mock).mockResolvedValue({
      id: "c1b2c3d4-e5f6-4890-a234-56789abcdef0",
      family_id: "family-uuid",
      expires_at: new Date(Date.now() + 30 * 86400000),
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("POST /api/workers/registerWorker", () => {
    it("should successfully register a worker and hash the password", async () => {
      const mockPayload = {
        name: "Test Worker",
        skill_category_id: "c1b2c3d4-e5f6-4890-a234-56789abcdef0",
        phone: "+919999999999",
        password: "securepassword",
        skill_type: "Plumber",
        aadhaar_last4: "1234",
      };

      const mockCreatedWorker = {
        id: "worker-uuid",
        name: mockPayload.name,
        skill_category_id: mockPayload.skill_category_id,
        phone: mockPayload.phone,
        skill_type: mockPayload.skill_type,
        aadhaar_last4: mockPayload.aadhaar_last4,
        verification_status: "pending",
      };

      (prisma.worker.create as jest.Mock).mockResolvedValue(mockCreatedWorker);

      const res = await request(app)
        .post("/api/workers/registerWorker")
        .send(mockPayload);

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(mockCreatedWorker);
      expect(prisma.worker.create).toHaveBeenCalled();
      
      // Verify that prisma.worker.create was called with hashed password
      const callArg = (prisma.worker.create as jest.Mock).mock.calls[0][0];
      expect(callArg.data.password).not.toBe(mockPayload.password);
      expect(callArg.data.password.length).toBeGreaterThan(10);
    });

    it("should return 400 validation error if password is too short", async () => {
      const mockPayload = {
        name: "Test Worker",
        skill_category_id: "c1b2c3d4-e5f6-4890-a234-56789abcdef0",
        phone: "+919999999999",
        password: "123", // too short
        skill_type: "Plumber",
      };

      const res = await request(app)
        .post("/api/workers/registerWorker")
        .send(mockPayload);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe("POST /api/workers/login", () => {
    it("should login successfully with correct credentials and return JWT token", async () => {
      const rawPassword = "securepassword";
      const hashedPassword = await hashPassword(rawPassword);

      const mockWorker = {
        id: "worker-uuid",
        name: "Test Worker",
        phone: "+919999999999",
        password: hashedPassword,
        skill_type: "Plumber",
        verification_status: "pending",
      };

      (prisma.worker.findUnique as jest.Mock).mockResolvedValue(mockWorker);

      const res = await request(app)
        .post("/api/workers/login")
        .send({
          phone: "+919999999999",
          password: rawPassword,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.token).toBeDefined();
      expect(res.body.refreshToken).toBeDefined();
      expect(res.body.data).toEqual({
        id: mockWorker.id,
        phone: mockWorker.phone,
        name: mockWorker.name,
        skill_type: mockWorker.skill_type,
        verification_status: mockWorker.verification_status,
      });
    });

    it("should return 401 for incorrect password", async () => {
      const rawPassword = "securepassword";
      const hashedPassword = await hashPassword(rawPassword);

      const mockWorker = {
        id: "worker-uuid",
        name: "Test Worker",
        phone: "+919999999999",
        password: hashedPassword,
        skill_type: "Plumber",
        verification_status: "pending",
      };

      (prisma.worker.findUnique as jest.Mock).mockResolvedValue(mockWorker);

      const res = await request(app)
        .post("/api/workers/login")
        .send({
          phone: "+919999999999",
          password: "wrongpassword",
        });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe("Invalid phone number or password");
    });

    it("should return 401 for non-existent worker", async () => {
      (prisma.worker.findUnique as jest.Mock).mockResolvedValue(null);

      const res = await request(app)
        .post("/api/workers/login")
        .send({
          phone: "+919999999999",
          password: "anypassword",
        });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });
  });
});
