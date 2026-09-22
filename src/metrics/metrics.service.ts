import fs from "fs";
import path from "path";
import client, { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from "prom-client";
import { logger } from "../utils/logger";

export interface MetricLabels {
  [key: string]: string | number;
}

export class MetricsService {
  private registry: Registry;
  private dynamicCounters: Map<string, Counter<string>> = new Map();
  private dynamicGauges: Map<string, Gauge<string>> = new Map();
  private dynamicHistograms: Map<string, Histogram<string>> = new Map();

  // Generic and Default Metrics
  public readonly httpRequestsTotal: Counter<string>;
  public readonly httpRequestDurationMs: Histogram<string>;
  public readonly httpRequestDurationSeconds: Histogram<string>;

  // Health Metrics
  public readonly healthReadyDatabaseStatus: Gauge<string>;
  public readonly healthReadyRedisStatus: Gauge<string>;
  public readonly healthReadyStatus: Gauge<string>;

  // BullMQ Queue Metrics
  public readonly bullmqWaitingJobsTotal: Gauge<string>;
  public readonly bullmqActiveJobsTotal: Gauge<string>;
  public readonly bullmqFailedJobsTotal: Gauge<string>;

  // Dispatch Metrics
  public readonly jobsCreatedTotal: Counter<string>;
  public readonly dispatchAttemptsTotal: Counter<string>;
  public readonly dispatchSuccessTotal: Counter<string>;
  public readonly dispatchFailureTotal: Counter<string>;
  public readonly dispatchAcceptTotal: Counter<string>;
  public readonly dispatchLatencyMs: Histogram<string>;
  public readonly dispatchCandidateCount: Histogram<string>;
  public readonly dispatchAcceptLatencyMs: Histogram<string>;

  // Location Metrics
  public readonly locationUpdatesTotal: Counter<string>;
  public readonly locationCleanupRowsDeletedTotal: Counter<string>;
  public readonly locationCleanupDurationMs: Histogram<string>;
  public readonly locationExclusionsTotal: Counter<string>;

  // Notification Metrics
  public readonly notificationAttemptsTotal: Counter<string>;
  public readonly notificationSuccessTotal: Counter<string>;
  public readonly notificationFailureTotal: Counter<string>;

  // OTP & Security Metrics
  public readonly otpChallengesCreatedTotal: Counter<string>;
  public readonly otpVerificationsTotal: Counter<string>;
  public readonly otpDeliveryFailedTotal: Counter<string>;
  public readonly securityAuditEventsTotal: Counter<string>;

  // Payment Metrics
  public readonly paymentsCreatedTotal: Counter<string>;
  public readonly paymentsCapturedTotal: Counter<string>;
  public readonly paymentsCapturedAmountPaiseTotal: Counter<string>;
  public readonly paymentsFailedTotal: Counter<string>;
  public readonly refundsCreatedTotal: Counter<string>;
  public readonly refundsAmountPaiseTotal: Counter<string>;
  public readonly webhookSignatureFailuresTotal: Counter<string>;
  public readonly paymentsQuarantinedTotal: Counter<string>;

  // Booking Metrics
  public readonly bookingCreatedTotal: Counter<string>;
  public readonly bookingCancelledTotal: Counter<string>;
  public readonly bookingCompletedTotal: Counter<string>;

  // Backup Metric
  public readonly backupLastSuccessfulTimestampSeconds: Gauge<string>;

  constructor() {
    this.registry = new Registry();

    // Collect standard process metrics (CPU, memory, event loop lag, handles)
    collectDefaultMetrics({ register: this.registry, prefix: "nodejs_" });

    // HTTP Request Duration & Count
    this.httpRequestsTotal = new Counter({
      name: "http_requests_total",
      help: "Total number of HTTP requests processed by LabourBaba API",
      labelNames: ["method", "route", "status"],
      registers: [this.registry],
    });

    this.httpRequestDurationMs = new Histogram({
      name: "http_request_duration_ms",
      help: "HTTP request latency distribution in milliseconds",
      labelNames: ["method", "route", "status"],
      buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
      registers: [this.registry],
    });

    this.httpRequestDurationSeconds = new Histogram({
      name: "http_request_duration_seconds",
      help: "HTTP request latency in seconds for p50/p95/p99 quantile calculation",
      labelNames: ["method", "route", "status"],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });

    // Health Status Gauges
    this.healthReadyDatabaseStatus = new Gauge({
      name: "health_ready_database_status",
      help: "PostgreSQL Database readiness probe health status (1 = healthy, 0 = unhealthy)",
      registers: [this.registry],
    });
    this.healthReadyDatabaseStatus.set(1);

    this.healthReadyRedisStatus = new Gauge({
      name: "health_ready_redis_status",
      help: "Redis data store readiness probe health status (1 = healthy, 0 = unhealthy)",
      registers: [this.registry],
    });
    this.healthReadyRedisStatus.set(1);

    this.healthReadyStatus = new Gauge({
      name: "health_ready_status",
      help: "Overall application readiness status (1 = ready, 0 = not ready)",
      registers: [this.registry],
    });
    this.healthReadyStatus.set(1);

    // BullMQ Queue Depth Gauges
    this.bullmqWaitingJobsTotal = new Gauge({
      name: "bullmq_waiting_jobs_total",
      help: "Current number of waiting jobs across BullMQ queues",
      labelNames: ["queue"],
      registers: [this.registry],
    });

    this.bullmqActiveJobsTotal = new Gauge({
      name: "bullmq_active_jobs_total",
      help: "Current number of actively processing jobs across BullMQ queues",
      labelNames: ["queue"],
      registers: [this.registry],
    });

    this.bullmqFailedJobsTotal = new Gauge({
      name: "bullmq_failed_jobs_total",
      help: "Total number of failed jobs across BullMQ queues",
      labelNames: ["queue"],
      registers: [this.registry],
    });

    // Dispatch Counters & Histograms
    this.jobsCreatedTotal = new Counter({
      name: "jobs_created_total",
      help: "Total number of marketplace jobs created",
      registers: [this.registry],
    });

    this.dispatchAttemptsTotal = new Counter({
      name: "dispatch_attempts_total",
      help: "Total number of dispatch attempts initiated",
      registers: [this.registry],
    });

    this.dispatchSuccessTotal = new Counter({
      name: "dispatch_success_total",
      help: "Total number of successful dispatches where candidates were notified",
      registers: [this.registry],
    });

    this.dispatchFailureTotal = new Counter({
      name: "dispatch_failure_total",
      help: "Total number of failed dispatch attempts",
      labelNames: ["reason"],
      registers: [this.registry],
    });

    this.dispatchAcceptTotal = new Counter({
      name: "dispatch_accept_total",
      help: "Total number of dispatches accepted by workers",
      registers: [this.registry],
    });

    this.dispatchLatencyMs = new Histogram({
      name: "dispatch_latency_ms",
      help: "Dispatch matching and notification latency in milliseconds",
      buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000],
      registers: [this.registry],
    });

    this.dispatchCandidateCount = new Histogram({
      name: "dispatch_candidate_count",
      help: "Distribution of candidates found per dispatch attempt",
      buckets: [1, 3, 5, 10, 20, 50],
      registers: [this.registry],
    });

    this.dispatchAcceptLatencyMs = new Histogram({
      name: "dispatch_accept_latency_ms",
      help: "Time elapsed from dispatch broadcast to worker acceptance in milliseconds",
      buckets: [500, 1000, 2500, 5000, 10000, 30000, 60000],
      registers: [this.registry],
    });

    // Location Metrics
    this.locationUpdatesTotal = new Counter({
      name: "location_updates_total",
      help: "Total number of worker GPS location pings received",
      registers: [this.registry],
    });

    this.locationCleanupRowsDeletedTotal = new Counter({
      name: "location_cleanup_rows_deleted_total",
      help: "Total number of stale location rows pruned by retention worker",
      registers: [this.registry],
    });

    this.locationCleanupDurationMs = new Histogram({
      name: "location_cleanup_duration_ms",
      help: "Location retention cleanup execution time in milliseconds",
      buckets: [50, 100, 250, 500, 1000, 5000],
      registers: [this.registry],
    });

    this.locationExclusionsTotal = new Counter({
      name: "location_exclusions_total",
      help: "Total number of workers excluded from candidate matching due to location reasons",
      labelNames: ["reason"],
      registers: [this.registry],
    });

    // Notification Metrics
    this.notificationAttemptsTotal = new Counter({
      name: "notification_attempts_total",
      help: "Total notification delivery attempts",
      labelNames: ["channel"],
      registers: [this.registry],
    });

    this.notificationSuccessTotal = new Counter({
      name: "notification_success_total",
      help: "Total successful notification deliveries",
      labelNames: ["channel"],
      registers: [this.registry],
    });

    this.notificationFailureTotal = new Counter({
      name: "notification_failure_total",
      help: "Total failed notification deliveries",
      labelNames: ["channel", "error_type"],
      registers: [this.registry],
    });

    // OTP & Security Metrics
    this.otpChallengesCreatedTotal = new Counter({
      name: "otp_challenges_created_total",
      help: "Total OTP challenges generated",
      labelNames: ["purpose"],
      registers: [this.registry],
    });

    this.otpDeliveryFailedTotal = new Counter({
      name: "otp_delivery_failed_total",
      help: "Total failed OTP SMS deliveries",
      labelNames: ["purpose"],
      registers: [this.registry],
    });

    this.otpVerificationsTotal = new Counter({
      name: "otp_verifications_total",
      help: "Total OTP verification attempts",
      labelNames: ["purpose", "status"],
      registers: [this.registry],
    });

    this.securityAuditEventsTotal = new Counter({
      name: "security_audit_events_total",
      help: "Total security audit log events recorded",
      labelNames: ["action", "role"],
      registers: [this.registry],
    });

    // Payment Metrics
    this.paymentsCreatedTotal = new Counter({
      name: "payments_created_total",
      help: "Total payment intents/orders created",
      registers: [this.registry],
    });

    this.paymentsCapturedTotal = new Counter({
      name: "payments_captured_total",
      help: "Total payments successfully captured",
      registers: [this.registry],
    });

    this.paymentsCapturedAmountPaiseTotal = new Counter({
      name: "payments_captured_amount_paise_total",
      help: "Total amount captured in paise",
      registers: [this.registry],
    });

    this.paymentsFailedTotal = new Counter({
      name: "payments_failed_total",
      help: "Total payment failures",
      labelNames: ["reason"],
      registers: [this.registry],
    });

    this.refundsCreatedTotal = new Counter({
      name: "refunds_created_total",
      help: "Total refunds initiated",
      registers: [this.registry],
    });

    this.refundsAmountPaiseTotal = new Counter({
      name: "refunds_amount_paise_total",
      help: "Total amount refunded in paise",
      registers: [this.registry],
    });

    this.webhookSignatureFailuresTotal = new Counter({
      name: "webhook_signature_failures_total",
      help: "Total invalid payment webhook signature attempts",
      registers: [this.registry],
    });

    this.paymentsQuarantinedTotal = new Counter({
      name: "payments_quarantined_total",
      help: "Total payments placed in quarantine due to mismatch or fraud flags",
      labelNames: ["reason"],
      registers: [this.registry],
    });

    // Booking Metrics
    this.bookingCreatedTotal = new Counter({
      name: "booking_created_total",
      help: "Total bookings confirmed",
      registers: [this.registry],
    });

    this.bookingCancelledTotal = new Counter({
      name: "booking_cancelled_total",
      help: "Total bookings cancelled",
      labelNames: ["reason"],
      registers: [this.registry],
    });

    this.bookingCompletedTotal = new Counter({
      name: "booking_completed_total",
      help: "Total bookings successfully completed",
      registers: [this.registry],
    });

    // Backup Metric
    this.backupLastSuccessfulTimestampSeconds = new Gauge({
      name: "backup_last_successful_timestamp_seconds",
      help: "Unix timestamp in seconds of the last verified database backup",
      registers: [this.registry],
    });
    // Initialize strictly from verified backup metadata if available, otherwise 0.
    // Must NEVER initialize to Date.now() to avoid fake operational confidence (P4 Issue 27).
    let initialBackupTime = 0;
    try {
      const metadataPath = path.resolve(process.cwd(), "backups", "latest_backup_metadata.json");
      if (fs.existsSync(metadataPath)) {
        const data = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
        if (data && typeof data.timestampSeconds === "number") {
          initialBackupTime = data.timestampSeconds;
        }
      }
    } catch {
      initialBackupTime = 0;
    }
    this.backupLastSuccessfulTimestampSeconds.set(initialBackupTime);
  }

  // --- Dynamic Compatibility Helpers ---

  incrementCounter(name: string, value: number = 1, labels?: Record<string, string | number>): void {
    try {
      const sanitizedLabels: Record<string, string> = {};
      if (labels) {
        for (const [k, v] of Object.entries(labels)) {
          sanitizedLabels[k] = String(v);
        }
      }

      // Check known pre-defined counters first
      if (name === "jobs_created_total") return this.jobsCreatedTotal.inc(value);
      if (name === "dispatch_attempts_total") return this.dispatchAttemptsTotal.inc(value);
      if (name === "dispatch_success_total") return this.dispatchSuccessTotal.inc(value);
      if (name === "dispatch_failure_total") return this.dispatchFailureTotal.inc(sanitizedLabels, value);
      if (name === "dispatch_accept_total") return this.dispatchAcceptTotal.inc(value);
      if (name === "booking_created_total") return this.bookingCreatedTotal.inc(value);
      if (name === "booking_cancelled_total") return this.bookingCancelledTotal.inc(sanitizedLabels, value);
      if (name === "booking_completed_total") return this.bookingCompletedTotal.inc(value);
      if (name === "location_updates_total") return this.locationUpdatesTotal.inc(value);
      if (name === "location_cleanup_rows_deleted_total") return this.locationCleanupRowsDeletedTotal.inc(value);
      if (name === "location_exclusions_total") return this.locationExclusionsTotal.inc(sanitizedLabels, value);
      if (name === "notification_attempts_total") return this.notificationAttemptsTotal.inc(sanitizedLabels, value);
      if (name === "notification_success_total") return this.notificationSuccessTotal.inc(sanitizedLabels, value);
      if (name === "notification_failure_total") return this.notificationFailureTotal.inc(sanitizedLabels, value);
      if (name === "otp_challenges_created_total") return this.otpChallengesCreatedTotal.inc(sanitizedLabels, value);
      if (name === "otp_delivery_failed_total") return this.otpDeliveryFailedTotal.inc(sanitizedLabels, value);
      if (name === "otp_verifications_total") return this.otpVerificationsTotal.inc(sanitizedLabels, value);
      if (name === "security_audit_events_total") return this.securityAuditEventsTotal.inc(sanitizedLabels, value);
      if (name === "payments_created_total") return this.paymentsCreatedTotal.inc(value);
      if (name === "payments_captured_total") return this.paymentsCapturedTotal.inc(value);
      if (name === "payments_captured_amount_paise_total") return this.paymentsCapturedAmountPaiseTotal.inc(value);
      if (name === "payments_failed_total") return this.paymentsFailedTotal.inc(sanitizedLabels, value);
      if (name === "refunds_created_total") return this.refundsCreatedTotal.inc(value);
      if (name === "refunds_amount_paise_total") return this.refundsAmountPaiseTotal.inc(value);
      if (name === "webhook_signature_failures_total") return this.webhookSignatureFailuresTotal.inc(value);
      if (name === "payments_quarantined_total") return this.paymentsQuarantinedTotal.inc(sanitizedLabels, value);
      if (name === "http_requests_total") return this.httpRequestsTotal.inc(sanitizedLabels, value);

      // Create or reuse dynamic counter
      let counter = this.dynamicCounters.get(name);
      if (!counter) {
        counter = new Counter({
          name,
          help: `Dynamically registered counter ${name}`,
          labelNames: labels ? Object.keys(labels) : [],
          registers: [this.registry],
        });
        this.dynamicCounters.set(name, counter);
      }
      if (labels && Object.keys(labels).length > 0) {
        counter.inc(sanitizedLabels, value);
      } else {
        counter.inc(value);
      }
    } catch (err: any) {
      logger.warn(`[METRICS] Failed to increment counter ${name}:`, { error: err.message });
    }
  }

  setGauge(name: string, value: number, labels?: Record<string, string | number>): void {
    try {
      const sanitizedLabels: Record<string, string> = {};
      if (labels) {
        for (const [k, v] of Object.entries(labels)) {
          sanitizedLabels[k] = String(v);
        }
      }

      if (name === "health_ready_database_status") return this.healthReadyDatabaseStatus.set(value);
      if (name === "health_ready_redis_status") return this.healthReadyRedisStatus.set(value);
      if (name === "health_ready_status") return this.healthReadyStatus.set(value);
      if (name === "backup_last_successful_timestamp_seconds") return this.backupLastSuccessfulTimestampSeconds.set(value);
      if (name === "bullmq_waiting_jobs_total") return this.bullmqWaitingJobsTotal.set(sanitizedLabels, value);
      if (name === "bullmq_active_jobs_total") return this.bullmqActiveJobsTotal.set(sanitizedLabels, value);
      if (name === "bullmq_failed_jobs_total") return this.bullmqFailedJobsTotal.set(sanitizedLabels, value);

      let gauge = this.dynamicGauges.get(name);
      if (!gauge) {
        gauge = new Gauge({
          name,
          help: `Dynamically registered gauge ${name}`,
          labelNames: labels ? Object.keys(labels) : [],
          registers: [this.registry],
        });
        this.dynamicGauges.set(name, gauge);
      }
      if (labels && Object.keys(labels).length > 0) {
        gauge.set(sanitizedLabels, value);
      } else {
        gauge.set(value);
      }
    } catch (err: any) {
      logger.warn(`[METRICS] Failed to set gauge ${name}:`, { error: err.message });
    }
  }

  observeHistogram(name: string, value: number, labels?: Record<string, string | number>): void {
    try {
      const sanitizedLabels: Record<string, string> = {};
      if (labels) {
        for (const [k, v] of Object.entries(labels)) {
          sanitizedLabels[k] = String(v);
        }
      }

      if (name === "dispatch_latency_ms") return this.dispatchLatencyMs.observe(value);
      if (name === "dispatch_candidate_count") return this.dispatchCandidateCount.observe(value);
      if (name === "dispatch_accept_latency_ms") return this.dispatchAcceptLatencyMs.observe(value);
      if (name === "location_cleanup_duration_ms") return this.locationCleanupDurationMs.observe(value);
      if (name === "http_request_duration_ms") return this.httpRequestDurationMs.observe(sanitizedLabels, value);
      if (name === "http_request_duration_seconds") return this.httpRequestDurationSeconds.observe(sanitizedLabels, value);

      let histo = this.dynamicHistograms.get(name);
      if (!histo) {
        histo = new Histogram({
          name,
          help: `Dynamically registered histogram ${name}`,
          labelNames: labels ? Object.keys(labels) : [],
          registers: [this.registry],
        });
        this.dynamicHistograms.set(name, histo);
      }
      if (labels && Object.keys(labels).length > 0) {
        histo.observe(sanitizedLabels, value);
      } else {
        histo.observe(value);
      }
    } catch (err: any) {
      logger.warn(`[METRICS] Failed to observe histogram ${name}:`, { error: err.message });
    }
  }

  // --- Convenience Business Metric Methods ---

  recordJobCreated(): void {
    this.jobsCreatedTotal.inc();
  }

  recordDispatchAttempt(): void {
    this.dispatchAttemptsTotal.inc();
  }

  recordDispatchSuccess(candidateCount: number, durationMs: number): void {
    this.dispatchSuccessTotal.inc();
    this.dispatchCandidateCount.observe(candidateCount);
    this.dispatchLatencyMs.observe(durationMs);
  }

  recordDispatchFailure(reason: string = "no_candidates"): void {
    this.dispatchFailureTotal.inc({ reason });
  }

  recordDispatchAccept(latencyMs: number): void {
    this.dispatchAcceptTotal.inc();
    this.dispatchAcceptLatencyMs.observe(latencyMs);
  }

  recordBookingCreated(): void {
    this.bookingCreatedTotal.inc();
  }

  recordBookingCancelled(reason?: string): void {
    this.bookingCancelledTotal.inc({ reason: reason ? reason.slice(0, 30) : "unspecified" });
  }

  recordBookingCompleted(): void {
    this.bookingCompletedTotal.inc();
  }

  recordNotificationAttempt(channel: "fcm" | "socket" = "fcm"): void {
    this.notificationAttemptsTotal.inc({ channel });
  }

  recordNotificationSuccess(channel: "fcm" | "socket" = "fcm"): void {
    this.notificationSuccessTotal.inc({ channel });
  }

  recordNotificationFailure(channel: "fcm" | "socket" = "fcm", errorType: "transient" | "permanent" = "transient"): void {
    this.notificationFailureTotal.inc({ channel, error_type: errorType });
  }

  recordLocationUpdate(): void {
    this.locationUpdatesTotal.inc();
  }

  recordLocationCleanup(deletedRows: number, durationMs: number): void {
    this.locationCleanupRowsDeletedTotal.inc(deletedRows);
    this.locationCleanupDurationMs.observe(durationMs);
  }

  recordLocationExclusion(reason: string = "stale_location"): void {
    this.locationExclusionsTotal.inc({ reason });
  }

  recordHttpRequest(method: string, route: string, statusCode: number, durationMs: number): void {
    // Normalizing route to avoid high cardinality (UUIDs -> :id)
    const normalizedRoute = route.split("?")[0].replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id");
    const labels = {
      method,
      route: normalizedRoute,
      status: String(statusCode),
    };
    this.httpRequestsTotal.inc(labels);
    this.httpRequestDurationMs.observe(labels, durationMs);
    this.httpRequestDurationSeconds.observe(labels, durationMs / 1000);
  }

  recordOtpChallenge(purpose: string): void {
    this.otpChallengesCreatedTotal.inc({ purpose });
  }

  recordOtpVerification(purpose: string, status: "success" | "failed" | "locked"): void {
    this.otpVerificationsTotal.inc({ purpose, status });
  }

  recordAuditEvent(action: string, actorRole: string): void {
    this.securityAuditEventsTotal.inc({ action, role: actorRole });
  }

  recordPaymentCreated(): void {
    this.paymentsCreatedTotal.inc();
  }

  recordPaymentCaptured(amountPaise: number): void {
    this.paymentsCapturedTotal.inc();
    this.paymentsCapturedAmountPaiseTotal.inc(amountPaise);
  }

  recordPaymentFailed(reason: string = "unknown"): void {
    this.paymentsFailedTotal.inc({ reason });
  }

  recordRefundCreated(amountPaise: number): void {
    this.refundsCreatedTotal.inc();
    this.refundsAmountPaiseTotal.inc(amountPaise);
  }

  recordWebhookSignatureFailure(): void {
    this.webhookSignatureFailuresTotal.inc();
  }

  recordPaymentQuarantined(reason: string): void {
    this.paymentsQuarantinedTotal.inc({ reason: reason.slice(0, 30) });
  }

  setDatabaseHealth(healthy: boolean): void {
    this.healthReadyDatabaseStatus.set(healthy ? 1 : 0);
  }

  setRedisHealth(healthy: boolean): void {
    this.healthReadyRedisStatus.set(healthy ? 1 : 0);
  }

  setApplicationReady(ready: boolean): void {
    this.healthReadyStatus.set(ready ? 1 : 0);
  }

  setQueueWaitingJobs(queue: string, count: number): void {
    this.bullmqWaitingJobsTotal.set({ queue }, count);
  }

  setLastBackupTimestamp(timestampSeconds: number): void {
    this.backupLastSuccessfulTimestampSeconds.set(timestampSeconds);
  }

  /**
   * Returns Prometheus exposition text output for scraping.
   */
  async formatPrometheus(): Promise<string> {
    try {
      const metadataPath = path.resolve(process.cwd(), "backups", "latest_backup_metadata.json");
      if (fs.existsSync(metadataPath)) {
        const data = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
        if (data && typeof data.timestampSeconds === "number") {
          this.backupLastSuccessfulTimestampSeconds.set(data.timestampSeconds);
        }
      }
    } catch {
      // Non-blocking fallback
    }
    return await this.registry.metrics();
  }

  /**
   * Returns the standard Prometheus Content-Type header.
   */
  getContentType(): string {
    return this.registry.contentType;
  }

  /**
   * Resets all metric values in the registry (useful for test isolation).
   */
  reset(): void {
    this.registry.resetMetrics();
    this.healthReadyDatabaseStatus.set(1);
    this.healthReadyRedisStatus.set(1);
    this.healthReadyStatus.set(1);
    this.backupLastSuccessfulTimestampSeconds.set(0);
  }
}

export const metricsService = new MetricsService();
