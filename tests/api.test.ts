import request from "supertest";
import { app } from "../src/server";
import prisma from "../src/config/prisma";
import { defaultMockSmsProvider } from "../src/providers/sms/mockSmsProvider";
import { hashOTP } from "../src/utils/authUtils";

// Mock the prisma client
jest.mock("../src/config/prisma", () => ({
  __esModule: true,
  default: {
    customer: {
      findUnique: jest.fn(),
    },
    worker: {
      findUnique: jest.fn(),
    },
    otp_challenge: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    refresh_session: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(async (callback) => {
      if (typeof callback === "function") {
        return await callback(prisma);
      }
      return callback;
    }),
  },
}));

import { resetMemoryRateLimiter } from "../src/middlewares/otpRateLimiter";

describe("API Integration Tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    defaultMockSmsProvider.clear();
    resetMemoryRateLimiter();
    (prisma.$transaction as jest.Mock).mockImplementation(async (callback: any) => {
      if (typeof callback === "function") {
        return await callback(prisma);
      }
      return callback;
    });
    ((prisma as any).refresh_session.create as jest.Mock).mockResolvedValue({
      id: "a1b2c3d4-e5f6-4890-a234-56789abcdef0",
      expires_at: new Date(Date.now() + 30 * 86400000),
    });
  });


  describe("GET /health", () => {
    it("should return 200 and status OK", async () => {
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        status: "OK",
        timestamp: expect.any(String),
      });
    });
  });

  describe("POST /api/auth/send-otp", () => {
    it("should return 200 for valid input and dispatch OTP via provider", async () => {
      (prisma.otp_challenge.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.otp_challenge.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
      (prisma.otp_challenge.create as jest.Mock).mockResolvedValue({
        id: "mock-challenge-id",
        phone: "+919876543210",
        purpose: "login",
        status: "ACTIVE",
      });

      const res = await request(app)
        .post("/api/auth/send-otp")
        .send({ phone: "+919876543210", type: "login" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe("OTP sent successfully.");

      // Verify that the mock provider received an OTP
      const sentOtp = defaultMockSmsProvider.getLastOtpFor("+919876543210");
      expect(sentOtp).toBeDefined();
      expect(sentOtp).toMatch(/^\d{6}$/);
    });

    it("should return 400 for invalid phone number", async () => {
      const res = await request(app)
        .post("/api/auth/send-otp")
        .send({ phone: "123", type: "login" });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe("POST /api/auth/verify-otp", () => {
    it("should verify legitimate cryptographically generated OTP and return JWT for existing customer", async () => {
      const mockCustomer = { id: "a1b2c3d4-e5f6-7890-1234-56789abcdef0", phone: "+919876543210", name: "John Doe" };
      const generatedOtp = "849201";
      const hashedOtp = await hashOTP(generatedOtp);

      (prisma.otp_challenge.findFirst as jest.Mock).mockResolvedValue({
        id: "mock-challenge-uuid-1",
        phone: "+919876543210",
        purpose: "login",
        otp_hash: hashedOtp,
        status: "ACTIVE",
        attempt_count: 0,
        consumed_at: null,
        expires_at: new Date(Date.now() + 300000),
        created_at: new Date(),
      });
      (prisma.otp_challenge.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.customer.findUnique as jest.Mock).mockResolvedValue(mockCustomer);

      const res = await request(app)
        .post("/api/auth/verify-otp")
        .send({ phone: "+919876543210", otp: generatedOtp });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty("token");
      expect(res.body.data).toHaveProperty("refreshToken");
      expect(res.body.data.role).toBe("customer");
    });

    it("should return 401 for incorrect OTP", async () => {
      const generatedOtp = "849201";
      const hashedOtp = await hashOTP(generatedOtp);

      (prisma.otp_challenge.findFirst as jest.Mock).mockResolvedValue({
        id: "mock-challenge-uuid-2",
        phone: "+919876543210",
        purpose: "login",
        otp_hash: hashedOtp,
        status: "ACTIVE",
        attempt_count: 0,
        consumed_at: null,
        expires_at: new Date(Date.now() + 300000),
        created_at: new Date(),
      });
      (prisma.otp_challenge.update as jest.Mock).mockResolvedValue({});

      const res = await request(app)
        .post("/api/auth/verify-otp")
        .send({ phone: "+919876543210", otp: "000000" });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe("Invalid OTP");
    });

    it("should reject hard-coded '123456' when it does not match issued OTP challenge", async () => {
      const realOtp = "998877";
      const realHash = await hashOTP(realOtp);

      (prisma.otp_challenge.findFirst as jest.Mock).mockResolvedValue({
        id: "mock-challenge-uuid-3",
        phone: "+919876543210",
        purpose: "login",
        otp_hash: realHash,
        status: "ACTIVE",
        attempt_count: 0,
        consumed_at: null,
        expires_at: new Date(Date.now() + 300000),
        created_at: new Date(),
      });
      (prisma.otp_challenge.update as jest.Mock).mockResolvedValue({});

      const res = await request(app)
        .post("/api/auth/verify-otp")
        .send({ phone: "+919876543210", otp: "123456" });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe("Invalid OTP");
    });
  });
});
