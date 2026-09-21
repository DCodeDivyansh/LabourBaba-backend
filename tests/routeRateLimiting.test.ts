import {
  createRateLimiter,
  incrementRateLimit,
  hashIdentifier,
  resetAllMemoryRateLimiters
} from "../src/middlewares/rateLimiter";
import { Request, Response, NextFunction } from "express";

describe("Issue 42 - Route-Specific Multi-Dimensional Rate Limiting", () => {
  beforeEach(() => {
    resetAllMemoryRateLimiters();
  });

  describe("Identifier Hashing & Privacy", () => {
    it("hashes sensitive identifiers (phone, IP, user ID) to avoid leaking PII into Redis keys", () => {
      const phone = "+919876543210";
      const hashed = hashIdentifier(phone);

      expect(hashed).toHaveLength(16);
      expect(hashed).not.toContain("9876543210");
      expect(hashIdentifier(phone)).toBe(hashed); // Deterministic
    });
  });

  describe("Rate Limit Invariants & Threshold Enforcement", () => {
    it("allows requests below threshold and blocks requests exceeding limit with 429", async () => {
      const limiter = createRateLimiter({
        windowSeconds: 60,
        maxLimit: 3,
        keyPrefix: "test_limit",
        errorMessage: "Rate limit exceeded",
        dimension: "ip",
      });

      const req = {
        ip: "192.168.1.100",
        headers: {},
        socket: {},
      } as unknown as Request;

      const next = jest.fn();
      const statusMock = jest.fn().mockReturnThis();
      const jsonMock = jest.fn();
      const setHeaderMock = jest.fn();

      const res = {
        status: statusMock,
        json: jsonMock,
        setHeader: setHeaderMock,
      } as unknown as Response;

      // First 3 requests should pass
      await limiter(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);

      await limiter(req, res, next);
      expect(next).toHaveBeenCalledTimes(2);

      await limiter(req, res, next);
      expect(next).toHaveBeenCalledTimes(3);

      // 4th request exceeds maxLimit of 3
      await limiter(req, res, next);
      expect(next).toHaveBeenCalledTimes(3); // Next not called
      expect(statusMock).toHaveBeenCalledWith(429);
      expect(setHeaderMock).toHaveBeenCalledWith("Retry-After", expect.any(String));
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: "RATE_LIMITED",
            message: "Rate limit exceeded",
          }),
        })
      );
    });

    it("isolates rate limit buckets between different users / workers", async () => {
      const limiter = createRateLimiter({
        windowSeconds: 60,
        maxLimit: 2,
        keyPrefix: "test_user_limit",
        dimension: "user",
      });

      const reqUserA = { user: { id: "user-A" }, headers: {}, socket: {} } as unknown as Request;
      const reqUserB = { user: { id: "user-B" }, headers: {}, socket: {} } as unknown as Request;

      const next = jest.fn();
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), setHeader: jest.fn() } as unknown as Response;

      // User A makes 2 requests (reaches limit)
      await limiter(reqUserA, res, next);
      await limiter(reqUserA, res, next);
      expect(next).toHaveBeenCalledTimes(2);

      // User A's 3rd request is blocked
      await limiter(reqUserA, res, next);
      expect(next).toHaveBeenCalledTimes(2);

      // User B makes request and should succeed independently
      await limiter(reqUserB, res, next);
      expect(next).toHaveBeenCalledTimes(3);
    });
  });

  describe("Multi-Dimensional Keys", () => {
    it("supports custom keyGenerator for compound dimensions (phone + IP)", async () => {
      const limiter = createRateLimiter({
        windowSeconds: 60,
        maxLimit: 2,
        keyPrefix: "test_compound",
        keyGenerator: (r: Request) => [
          `ratelimit:test:ip:${hashIdentifier(r.ip || "127.0.0.1")}`,
          `ratelimit:test:phone:${hashIdentifier((r.body as any)?.phone || "")}`,
        ],
      });

      const req = {
        ip: "10.0.0.1",
        body: { phone: "+919999988888" },
        headers: {},
        socket: {},
      } as unknown as Request;

      const next = jest.fn();
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), setHeader: jest.fn() } as unknown as Response;

      await limiter(req, res, next);
      await limiter(req, res, next);
      expect(next).toHaveBeenCalledTimes(2);

      // 3rd attempt hits rate limit
      await limiter(req, res, next);
      expect(next).toHaveBeenCalledTimes(2);
    });
  });
});
