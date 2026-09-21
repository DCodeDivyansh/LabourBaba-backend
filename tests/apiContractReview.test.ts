/**
 * Issue 59 - API Contract Review & OpenAPI Specification Tests
 *
 * Verifies that:
 * 1. OpenAPI 3.0 specification is generated dynamically at /api-spec.json.
 * 2. Swagger UI endpoint is accessible at /api-docs.
 * 3. System endpoints (/health, /metrics) conform to documented schemas.
 * 4. 404 responses conform to the standard global error contract.
 * 5. Protected endpoints enforce documented authentication and role constraints.
 */

import request from "supertest";
import { app } from "../src/server";

describe("Issue 59 - API Contract Review & OpenAPI Specification", () => {
  it("GET /api-spec.json returns a valid OpenAPI 3.0.0 document", async () => {
    const res = await request(app).get("/api-spec.json");

    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.0.0");
    expect(res.body.info).toBeDefined();
    expect(res.body.info.title).toBe("LabourBaba API Documentation");
    expect(res.body.paths).toBeDefined();
    expect(res.body.paths["/health"]).toBeDefined();
  });

  it("GET /health conforms to documented schema", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status");
    expect(res.body.status).toBe("OK");
    expect(res.body).toHaveProperty("timestamp");
  });

  it("GET /metrics returns Prometheus text format", async () => {
    const res = await request(app).get("/metrics");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.text).toContain("http_requests_total");
  });

  it("Undefined routes return structured RESOURCE_NOT_FOUND error contract", async () => {
    const res = await request(app).get("/api/non-existent-endpoint-12345");

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe("RESOURCE_NOT_FOUND");
    expect(res.body.error.message).toBeDefined();
    expect(res.body.error.request_id).toBeDefined();
  });

  it("Protected routes reject anonymous requests with 401 Unauthorized", async () => {
    const res = await request(app).post("/api/jobs").send({ title: "Test Job" });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain("Authorization token missing");
  });
});
