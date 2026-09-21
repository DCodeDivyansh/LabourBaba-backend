import request from "supertest";
import { app } from "../src/server";
import { requestTimeout } from "../src/middlewares/requestTimeout";
import express from "express";

describe("Issue 43 - HTTP Security Hardening", () => {
  describe("Security Headers (Helmet)", () => {
    it("attaches critical production security headers to HTTP responses", async () => {
      const res = await request(app).get("/health/live");

      expect(res.status).toBe(200);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-dns-prefetch-control"]).toBe("off");
      expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
      expect(res.headers["strict-transport-security"]).toBeDefined();
    });
  });

  describe("CORS Allowlist Enforcement", () => {
    it("allows registered origins with credentials", async () => {
      const res = await request(app)
        .get("/health/live")
        .set("Origin", "https://labourbaba.com");

      expect(res.status).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBe("https://labourbaba.com");
      expect(res.headers["access-control-allow-credentials"]).toBe("true");
    });

    it("rejects unauthorized untrusted origins with 403 / CORS rejection", async () => {
      const res = await request(app)
        .get("/health/live")
        .set("Origin", "https://malicious-attacker-domain.xyz");

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });
  });

  describe("Body Size Limits & Raw Webhook Verification", () => {
    it("accepts valid JSON payload within 1MB body limit", async () => {
      const res = await request(app)
        .post("/api/auth/send-otp")
        .send({ phone: "+919876543210", type: "login" });

      // Should reach endpoint logic (200 or validation/rate-limit, but not 413 payload too large)
      expect(res.status).not.toBe(413);
    });

    it("rejects oversized JSON payloads exceeding 1MB", async () => {
      const oversizedPayload = {
        data: "X".repeat(1.5 * 1024 * 1024), // 1.5MB
      };

      const res = await request(app)
        .post("/api/auth/send-otp")
        .send(oversizedPayload);

      expect(res.status).toBe(413);
    });
  });

  describe("Request Timeout Enforcement", () => {
    it("terminates long-running requests that exceed deadline with 504 Gateway Timeout", async () => {
      const testApp = express();
      testApp.use(requestTimeout({ timeoutMs: 50 })); // 50ms test timeout
      testApp.get("/slow-endpoint", (_req, _res) => {
        // Intentionally do not respond to trigger timeout
      });

      const res = await request(testApp).get("/slow-endpoint");

      expect(res.status).toBe(504);
      expect(res.body).toEqual({
        success: false,
        error: {
          code: "REQUEST_TIMEOUT",
          message: "The request timed out before the server could process it.",
        },
      });
    });
  });
});
