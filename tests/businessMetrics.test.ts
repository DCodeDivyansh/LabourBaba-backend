import request from "supertest";
import { app } from "../src/server";
import { metricsService } from "../src/metrics/metrics.service";

describe("Issue 47 - Business Metrics & Prometheus Exposition", () => {
  beforeEach(() => {
    metricsService.reset();
  });

  describe("Core Business Counters & Histograms", () => {
    it("increments counters and observes latency histograms safely", () => {
      metricsService.recordJobCreated();
      metricsService.recordDispatchAttempt();
      metricsService.recordDispatchSuccess(5, 120);
      metricsService.recordDispatchAccept(1500);
      metricsService.recordBookingCreated();
      metricsService.recordBookingCompleted();
      metricsService.recordNotificationAttempt("fcm");
      metricsService.recordNotificationSuccess("fcm");
      metricsService.recordLocationUpdate();
      metricsService.recordLocationCleanup(150, 45);

      const output = metricsService.formatPrometheus();

      expect(output).toContain("jobs_created_total 1");
      expect(output).toContain("dispatch_attempts_total 1");
      expect(output).toContain("dispatch_success_total 1");
      expect(output).toContain("dispatch_accept_total 1");
      expect(output).toContain("booking_created_total 1");
      expect(output).toContain("booking_completed_total 1");
      expect(output).toContain('notification_attempts_total{channel="fcm"} 1');
      expect(output).toContain('notification_success_total{channel="fcm"} 1');
      expect(output).toContain("location_updates_total 1");
      expect(output).toContain("location_cleanup_rows_deleted_total 150");
      expect(output).toContain("dispatch_latency_ms_count 1");
      expect(output).toContain("dispatch_accept_latency_ms_count 1");
    });

    it("restricts labels to low-cardinality values to prevent memory leaks", () => {
      metricsService.recordHttpRequest("POST", "/api/auth/send-otp", 200, 15);
      metricsService.recordOtpChallenge("LOGIN");
      metricsService.recordOtpVerification("LOGIN", "success");
      metricsService.recordAuditEvent("WORKER_SUSPENDED", "admin");

      const output = metricsService.formatPrometheus();

      expect(output).toContain('http_requests_total{method="POST",route="/api/auth/send-otp",status="200"} 1');
      expect(output).toContain('otp_challenges_created_total{purpose="LOGIN"} 1');
      expect(output).toContain('otp_verifications_total{purpose="LOGIN",status="success"} 1');
      expect(output).toContain('security_audit_events_total{action="WORKER_SUSPENDED",role="admin"} 1');
    });
  });

  describe("HTTP /metrics Endpoint", () => {
    it("serves metrics in text/plain Prometheus format on GET /metrics", async () => {
      metricsService.recordJobCreated();

      const res = await request(app).get("/metrics");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/plain");
      expect(res.text).toContain("jobs_created_total 1");
    });
  });
});
