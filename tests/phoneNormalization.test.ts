import request from "supertest";
import { app } from "../src/server";
import prisma from "../src/config/prisma";
import { normalizePhoneToE164, normalizePhone } from "../src/utils/authUtils";
import { defaultMockSmsProvider } from "../src/providers/sms/mockSmsProvider";
import { setSmsProvider } from "../src/providers/sms/smsProviderFactory";
import { resetMemoryRateLimiter } from "../src/middlewares/otpRateLimiter";

jest.mock("../src/config/prisma", () => {
  return {
    __esModule: true,
    default: {
      customer: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
      worker: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
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
      $transaction: jest.fn(),
    },
  };
});

describe("Issue #12: Canonicalize Phone Identity (E.164)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetMemoryRateLimiter();
    setSmsProvider(defaultMockSmsProvider);
    defaultMockSmsProvider.clear();

    (prisma.refresh_session.create as jest.Mock).mockResolvedValue({
      id: "a1b2c3d4-e5f6-4890-a234-56789abcdef0",
      expires_at: new Date(Date.now() + 30 * 86400000),
      user_id: "test-user-id",
      user_role: "customer",
    });
  });

  describe("1. Unit Tests: normalizePhoneToE164 & normalizePhone", () => {
    it("should canonicalize various valid Indian phone formats to standard E.164", () => {
      const canonical = "+919876543210";
      expect(normalizePhoneToE164("+919876543210")).toBe(canonical);
      expect(normalizePhoneToE164("+91 98765 43210")).toBe(canonical);
      expect(normalizePhoneToE164("+91-98765-43210")).toBe(canonical);
      expect(normalizePhoneToE164("+91 (98765) 43210")).toBe(canonical);
      expect(normalizePhoneToE164("+91.98765.43210")).toBe(canonical);
      expect(normalizePhoneToE164("  +91 98765-43210  ")).toBe(canonical);
      // Alias check
      expect(normalizePhone("+91 98765 43210")).toBe(canonical);
    });

    it("should canonicalize valid international numbers from other countries", () => {
      // US number
      expect(normalizePhoneToE164("+1 (415) 555-2671")).toBe("+14155552671");
      expect(normalizePhoneToE164("+1-415-555-2671")).toBe("+14155552671");
      // UK number
      expect(normalizePhoneToE164("+44 7911 123456")).toBe("+447911123456");
    });

    it("should reject ambiguous numbers lacking country code", () => {
      expect(() => normalizePhoneToE164("9876543210")).toThrow();
      expect(() => normalizePhoneToE164("09876543210")).toThrow();
      try {
        normalizePhoneToE164("9876543210");
      } catch (err: any) {
        expect(err.code).toBe("INVALID_PHONE_NUMBER");
      }
    });

    it("should reject empty, whitespace, non-string, or malformed inputs", () => {
      expect(() => normalizePhoneToE164("")).toThrow();
      expect(() => normalizePhoneToE164("   ")).toThrow();
      expect(() => normalizePhoneToE164(null as any)).toThrow();
      expect(() => normalizePhoneToE164(undefined as any)).toThrow();
      expect(() => normalizePhoneToE164("+91abc12345")).toThrow();
      expect(() => normalizePhoneToE164("invalid_phone")).toThrow();
      expect(() => normalizePhoneToE164("+9999999999999999")).toThrow();
    });
  });

  describe("2. Customer Registration & Duplicate Prevention", () => {
    it("should canonicalize phone number on customer signup", async () => {
      (prisma.customer.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.customer.create as jest.Mock).mockResolvedValue({
        id: "11111111-2222-3333-4444-555555555555",
        phone: "+919876543210",
        name: "Test Customer",
        created_at: new Date(),
      });

      const res = await request(app)
        .post("/api/clients/signup")
        .send({
          name: "Test Customer",
          phone: "+91 98765 43210",
          password: "password123",
        });

      expect(res.status).toBe(201);
      expect(prisma.customer.findUnique).toHaveBeenCalledWith({
        where: { phone: "+919876543210" },
      });
      expect(prisma.customer.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            phone: "+919876543210",
            name: "Test Customer",
          }),
        })
      );
    });

    it("should reject duplicate customer signup when differently formatted phone resolves to same canonical E.164", async () => {
      (prisma.customer.findUnique as jest.Mock).mockResolvedValue({
        id: "11111111-2222-3333-4444-555555555555",
        phone: "+919876543210",
        name: "Existing Customer",
      });

      const res = await request(app)
        .post("/api/clients/signup")
        .send({
          name: "Duplicate Attempt",
          phone: "+91-98765-43210", // formatted differently
          password: "password123",
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("PHONE_ALREADY_REGISTERED");
      expect(prisma.customer.create).not.toHaveBeenCalled();
    });

    it("should handle P2002 race condition on customer signup with 409", async () => {
      (prisma.customer.findUnique as jest.Mock).mockResolvedValue(null);
      const p2002Error: any = new Error("Unique constraint failed");
      p2002Error.code = "P2002";
      (prisma.customer.create as jest.Mock).mockRejectedValue(p2002Error);

      const res = await request(app)
        .post("/api/clients/signup")
        .send({
          name: "Concurrent Customer",
          phone: "+91 98765 43210",
          password: "password123",
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("PHONE_ALREADY_REGISTERED");
    });
  });

  describe("3. Customer Login Canonical Equivalence", () => {
    it("should allow customer login using differently formatted phone string", async () => {
      const bcrypt = require("bcrypt");
      const hashedPassword = await bcrypt.hash("password123", 10);

      (prisma.customer.findUnique as jest.Mock).mockResolvedValue({
        id: "11111111-2222-3333-4444-555555555555",
        phone: "+919876543210",
        name: "Test Customer",
        password: hashedPassword,
        deleted_at: null,
      });

      const res = await request(app)
        .post("/api/clients/login")
        .send({
          phone: "+91 (98765) 43210", // formatted with parens and space
          password: "password123",
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(prisma.customer.findUnique).toHaveBeenCalledWith({
        where: { phone: "+919876543210" },
      });
    });
  });

  describe("4. Worker Registration, Update & Duplicate Prevention", () => {
    it("should canonicalize phone on worker registration", async () => {
      (prisma.worker.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.worker.create as jest.Mock).mockResolvedValue({
        id: "22222222-3333-4444-8555-666666666666",
        phone: "+919876543211",
        name: "Test Worker",
        skill_type: "Plumber",
        verification_status: "pending",
      });

      const res = await request(app)
        .post("/api/workers/registerWorker")
        .send({
          name: "Test Worker",
          skill_category_id: "c1b2c3d4-e5f6-4890-a234-56789abcdef0",
          phone: "+91 98765-43211",
          password: "password123",
          skill_type: "Plumber",
        });

      expect(res.status).toBe(201);
      expect(prisma.worker.findUnique).toHaveBeenCalledWith({
        where: { phone: "+919876543211" },
      });
      expect(prisma.worker.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            phone: "+919876543211",
          }),
        })
      );
    });

    it("should reject worker registration if phone format resolves to existing canonical phone", async () => {
      (prisma.worker.findUnique as jest.Mock).mockResolvedValue({
        id: "22222222-3333-4444-8555-666666666666",
        phone: "+919876543211",
      });

      const res = await request(app)
        .post("/api/workers/registerWorker")
        .send({
          name: "Duplicate Worker",
          skill_category_id: "c1b2c3d4-e5f6-4890-a234-56789abcdef0",
          phone: "+91.98765.43211",
          password: "password123",
          skill_type: "Plumber",
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("PHONE_ALREADY_REGISTERED");
    });

    it("should canonicalize phone and handle duplicates during worker profile update", async () => {
      const { signAccessToken } = require("../src/utils/authUtils");
      const token = signAccessToken({
        id: "22222222-3333-4444-5555-666666666666",
        role: "worker",
      });

      (prisma.worker.update as jest.Mock).mockResolvedValue({
        id: "22222222-3333-4444-5555-666666666666",
        phone: "+919876543299",
        name: "Updated Worker",
        skill_type: "Electrician",
      });

      const res = await request(app)
        .patch("/api/workers/me")
        .set("Authorization", `Bearer ${token}`)
        .send({
          phone: "+91 98765 43299",
        });

      expect(res.status).toBe(200);
      expect(prisma.worker.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "22222222-3333-4444-5555-666666666666" },
          data: expect.objectContaining({
            phone: "+919876543299",
          }),
        })
      );
    });

    it("should reject worker login with malformed phone number", async () => {
      const res = await request(app)
        .post("/api/workers/login")
        .send({
          phone: "9876543210", // lacking +91
          password: "password123",
        });

      expect(res.status).toBe(400); // Caught by Zod validation
    });
  });

  describe("5. OTP Flow Equivalence & Cross-Representation Verification", () => {
    it("should send OTP and store challenge with canonical E.164 phone", async () => {
      const findFirstMock = jest.fn().mockResolvedValue(null);
      const createMock = jest.fn().mockResolvedValue({
        id: "otp-uuid-1",
        phone: "+919876543210",
        purpose: "login",
        status: "ACTIVE",
      });

      (prisma.$transaction as jest.Mock).mockImplementation(async (cb) => {
        const tx = {
          otp_challenge: {
            findFirst: findFirstMock,
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
            create: createMock,
          },
        };
        return cb(tx);
      });

      const res = await request(app)
        .post("/api/auth/send-otp")
        .send({
          phone: "+91 98765 43210",
          type: "login",
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(findFirstMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            phone: "+919876543210",
            purpose: "login",
          }),
        })
      );
    });

    it("should verify OTP sent in one format using another format of the same phone", async () => {
      const bcrypt = require("bcrypt");
      const hashedOtp = await bcrypt.hash("123456", 10);

      (prisma.otp_challenge.findFirst as jest.Mock).mockResolvedValue({
        id: "otp-uuid-1",
        phone: "+919876543210",
        purpose: "login",
        otp_hash: hashedOtp,
        attempt_count: 0,
        status: "ACTIVE",
      });

      (prisma.otp_challenge.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.customer.findUnique as jest.Mock).mockResolvedValue({
        id: "cust-1",
        phone: "+919876543210",
        name: "OTP Customer",
        deleted_at: null,
      });
      (prisma.worker.findUnique as jest.Mock).mockResolvedValue(null);

      (prisma.$transaction as jest.Mock).mockImplementation(async (cb) => {
        const tx = {
          otp_challenge: {
            findFirst: jest.fn().mockResolvedValue({
              id: "otp-uuid-1",
              phone: "+919876543210",
              purpose: "login",
              otp_hash: hashedOtp,
              attempt_count: 0,
              status: "ACTIVE",
            }),
            update: jest.fn(),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
          customer: {
            findUnique: jest.fn().mockResolvedValue({
              id: "cust-1",
              phone: "+919876543210",
              name: "OTP Customer",
              deleted_at: null,
            }),
          },
          worker: {
            findUnique: jest.fn().mockResolvedValue(null),
          },
        };
        return cb(tx);
      });

      const res = await request(app)
        .post("/api/auth/verify-otp")
        .send({
          phone: "+91 (98765) 43210", // Different format on verify
          otp: "123456",
          type: "login",
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user.phone).toBe("+919876543210");
    });
  });

  describe("6. Rate Limiting Canonical Phone Key Equivalence", () => {
    it("should share the same rate limiting bucket across equivalent phone representations", async () => {
      // 5 requests allowed per phone in 60 mins
      (prisma.$transaction as jest.Mock).mockImplementation(async (cb) => {
        const tx = {
          otp_challenge: {
            findFirst: jest.fn().mockResolvedValue(null),
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
            create: jest.fn().mockResolvedValue({
              id: "otp-uuid",
              phone: "+919876543210",
              purpose: "login",
              status: "ACTIVE",
            }),
          },
        };
        return cb(tx);
      });

      // Send 5 requests with varying phone formats
      const formats = [
        "+919876543210",
        "+91 98765 43210",
        "+91-98765-43210",
        "+91 (98765) 43210",
        "+91.98765.43210",
      ];

      for (const fmt of formats) {
        const res = await request(app)
          .post("/api/auth/send-otp")
          .send({ phone: fmt, type: "login" });
        expect(res.status).toBe(200);
      }

      // 6th request with yet another format must be rate-limited
      const rateLimitedRes = await request(app)
        .post("/api/auth/send-otp")
        .send({ phone: "  +91 98765-43210  ", type: "login" });

      expect(rateLimitedRes.status).toBe(429);
      expect(rateLimitedRes.body.code).toBe("OTP_RATE_LIMITED");
    });
  });
});

