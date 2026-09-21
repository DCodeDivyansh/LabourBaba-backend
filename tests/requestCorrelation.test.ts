import request from "supertest";
import { app } from "../src/server";
import { getRequestContext, runWithRequestContext } from "../src/utils/requestContext";
import { logger } from "../src/utils/logger";

describe("Issue 41 - End-to-End Request & Correlation ID Propagation", () => {
  describe("Ingress Request ID & Sanitization", () => {
    it("generates a UUID request_id and correlation_id when headers are omitted", async () => {
      const res = await request(app).get("/health/live");

      expect(res.status).toBe(200);
      expect(res.headers["x-request-id"]).toBeDefined();
      expect(res.headers["x-correlation-id"]).toBeDefined();
      expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(res.headers["x-correlation-id"]).toBe(res.headers["x-request-id"]);
    });

    it("accepts and propagates valid incoming X-Correlation-ID and X-Request-ID headers", async () => {
      const customReqId = "req-client-12345";
      const customCorrId = "corr-flow-abcde";

      const res = await request(app)
        .get("/health/live")
        .set("X-Request-ID", customReqId)
        .set("X-Correlation-ID", customCorrId);

      expect(res.status).toBe(200);
      expect(res.headers["x-request-id"]).toBe(customReqId);
      expect(res.headers["x-correlation-id"]).toBe(customCorrId);
    });

    it("sanitizes oversized or malformed incoming IDs and generates fresh UUIDs", async () => {
      const oversizedId = "a".repeat(200);
      const malformedId = "bad<invalid>$injection#@*";

      const res = await request(app)
        .get("/health/live")
        .set("X-Request-ID", oversizedId)
        .set("X-Correlation-ID", malformedId);

      expect(res.status).toBe(200);
      expect(res.headers["x-request-id"]).not.toBe(oversizedId);
      expect(res.headers["x-correlation-id"]).not.toBe(malformedId);
      expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });
  });

  describe("AsyncLocalStorage Request Context", () => {
    it("runs within an explicit asynchronous request context and resolves getRequestContext()", async () => {
      const ctx = {
        requestId: "req-async-001",
        correlationId: "corr-async-001",
        userId: "usr-123",
      };

      await runWithRequestContext(ctx, async () => {
        const current = getRequestContext();
        expect(current).toBeDefined();
        expect(current?.requestId).toBe("req-async-001");
        expect(current?.correlationId).toBe("corr-async-001");
        expect(current?.userId).toBe("usr-123");
      });
    });

    it("logger automatically captures correlation context from AsyncLocalStorage", async () => {
      const spy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);

      await runWithRequestContext(
        {
          requestId: "req-log-test",
          correlationId: "corr-log-test",
        },
        async () => {
          logger.info("Contextual message");
        }
      );

      expect(spy).toHaveBeenCalled();
      const output = JSON.parse(spy.mock.calls[0][0].toString());
      expect(output.request_id).toBe("req-log-test");
      expect(output.correlation_id).toBe("corr-log-test");

      spy.mockRestore();
    });
  });
});
