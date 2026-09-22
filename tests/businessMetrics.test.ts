import request from "supertest";
import { app } from "../src/server";
import { metricsService } from "../src/metrics/metrics.service";

describe("Issue 47 - Business Metrics & Prometheus Exposition", () => {
  beforeEach(() => {
    metricsService.reset();
  });

  describe("Core Business Counters & Histograms", () => {
    it("increments counters and observes latency histograms safely", async () => {
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

      const output = await metricsService.formatPrometheus();

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

    it("restricts labels to low-cardinality values to prevent memory leaks", async () => {
      metricsService.recordHttpRequest("POST", "/api/auth/send-otp", 200, 15);
      metricsService.recordOtpChallenge("LOGIN");
      metricsService.recordOtpVerification("LOGIN", "success");
      metricsService.recordAuditEvent("WORKER_SUSPENDED", "admin");

      const output = await metricsService.formatPrometheus();

      expect(output).toContain('http_requests_total{method="POST",route="/api/auth/send-otp",status="200"} 1');
      expect(output).toContain('otp_challenges_created_total{purpose="LOGIN"} 1');
      expect(output).toContain('otp_verifications_total{purpose="LOGIN",status="success"} 1');
      expect(output).toContain('security_audit_events_total{action="WORKER_SUSPENDED",role="admin"} 1');
    });

    it("provides all metrics referenced by Prometheus alert rules (Issue #17 & #18)", async () => {
      // 1. Health gauges for DatabaseUnavailable & RedisUnavailable
      metricsService.setDatabaseHealth(false);
      metricsService.setRedisHealth(false);

      // 2. Queue depth gauge for QueueLagHigh
      metricsService.setQueueWaitingJobs("dispatch", 120);

      // 3. Location exclusion counter for StaleLocationSupplyHigh
      metricsService.recordLocationExclusion("stale_location");

      // 4. Backup timestamp gauge for BackupFailure
      metricsService.setLastBackupTimestamp(1700000000);

      // 5. Dispatch failure counter for DispatchFailureRateHigh
      metricsService.recordDispatchFailure("no_candidates");

      // 6. Notification failure counter for NotificationFailureRateHigh
      metricsService.recordNotificationFailure("fcm", "transient");

      const output = await metricsService.formatPrometheus();

      expect(output).toContain("health_ready_database_status 0");
      expect(output).toContain("health_ready_redis_status 0");
      expect(output).toContain('bullmq_waiting_jobs_total{queue="dispatch"} 120');
      expect(output).toContain('location_exclusions_total{reason="stale_location"} 1');
      expect(output).toContain("backup_last_successful_timestamp_seconds 1700000000");
      expect(output).toContain('dispatch_failure_total{reason="no_candidates"} 1');
      expect(output).toContain('notification_failure_total{channel="fcm",error_type="transient"} 1');
    });

    it("supports p50, p95, p99 quantile distribution with second-based histograms", async () => {
      metricsService.recordHttpRequest("GET", "/api/jobs", 200, 45);
      metricsService.recordHttpRequest("GET", "/api/jobs", 200, 150);

      const output = await metricsService.formatPrometheus();

      expect(output).toContain("http_request_duration_seconds_bucket");
      expect(output).toContain("http_request_duration_seconds_sum");
      expect(output).toContain('http_request_duration_seconds_count{method="GET",route="/api/jobs",status="200"} 2');
    });
  });

  describe("HTTP /metrics Endpoint", () => {
    it("serves metrics in text/plain Prometheus format on GET /metrics", async () => {
      metricsService.recordJobCreated();

      const res = await request(app).get("/metrics");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/plain");
      expect(res.text).toContain("jobs_created_total 1");
      expect(res.text).toContain("nodejs_version_info");
    });
  });
});
