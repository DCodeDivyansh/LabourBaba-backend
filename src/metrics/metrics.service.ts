import { logger } from "../utils/logger";

interface MetricLabels {
  [key: string]: string | number;
}

interface HistogramData {
  count: number;
  sum: number;
  buckets: Record<number, number>;
}

export class MetricsService {
  private counters: Map<string, number> = new Map();
  private gauges: Map<string, number> = new Map();
  private histograms: Map<string, { buckets: number[]; data: HistogramData }> = new Map();

  constructor() {
    this.initDefaultHistograms();
  }

  private initDefaultHistograms(): void {
    this.histograms.set("dispatch_latency_ms", {
      buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000],
      data: { count: 0, sum: 0, buckets: {} },
    });
    this.histograms.set("dispatch_candidate_count", {
      buckets: [1, 3, 5, 10, 20, 50],
      data: { count: 0, sum: 0, buckets: {} },
    });
    this.histograms.set("dispatch_accept_latency_ms", {
      buckets: [500, 1000, 2500, 5000, 10000, 30000, 60000],
      data: { count: 0, sum: 0, buckets: {} },
    });
    this.histograms.set("http_request_duration_ms", {
      buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
      data: { count: 0, sum: 0, buckets: {} },
    });
    this.histograms.set("location_cleanup_duration_ms", {
      buckets: [50, 100, 250, 500, 1000, 5000],
      data: { count: 0, sum: 0, buckets: {} },
    });
  }

  private serializeLabels(labels?: MetricLabels): string {
    if (!labels || Object.keys(labels).length === 0) return "";
    const entries = Object.entries(labels)
      .map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`)
      .sort()
      .join(",");
    return `{${entries}}`;
  }

  /**
   * Increments a named counter metric safely.
   */
  incrementCounter(name: string, value: number = 1, labels?: MetricLabels): void {
    try {
      const key = `${name}${this.serializeLabels(labels)}`;
      const current = this.counters.get(key) || 0;
      this.counters.set(key, current + value);
    } catch (err: any) {
      logger.warn(`[METRICS] Failed to increment counter ${name}:`, { error: err.message });
    }
  }

  /**
   * Sets a gauge metric value.
   */
  setGauge(name: string, value: number, labels?: MetricLabels): void {
    try {
      const key = `${name}${this.serializeLabels(labels)}`;
      this.gauges.set(key, value);
    } catch (err: any) {
      logger.warn(`[METRICS] Failed to set gauge ${name}:`, { error: err.message });
    }
  }

  /**
   * Observes a numerical value in a histogram metric.
   */
  observeHistogram(name: string, value: number): void {
    try {
      let histo = this.histograms.get(name);
      if (!histo) {
        histo = {
          buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000],
          data: { count: 0, sum: 0, buckets: {} },
        };
        this.histograms.set(name, histo);
      }

      histo.data.count++;
      histo.data.sum += value;

      for (const bucket of histo.buckets) {
        if (value <= bucket) {
          histo.data.buckets[bucket] = (histo.data.buckets[bucket] || 0) + 1;
        }
      }
    } catch (err: any) {
      logger.warn(`[METRICS] Failed to observe histogram ${name}:`, { error: err.message });
    }
  }

  // --- Convenience Business Metric Methods ---

  recordJobCreated(): void {
    this.incrementCounter("jobs_created_total");
  }

  recordDispatchAttempt(): void {
    this.incrementCounter("dispatch_attempts_total");
  }

  recordDispatchSuccess(candidateCount: number, durationMs: number): void {
    this.incrementCounter("dispatch_success_total");
    this.observeHistogram("dispatch_candidate_count", candidateCount);
    this.observeHistogram("dispatch_latency_ms", durationMs);
  }

  recordDispatchFailure(reason: string = "no_candidates"): void {
    this.incrementCounter("dispatch_failure_total", 1, { reason });
  }

  recordDispatchAccept(latencyMs: number): void {
    this.incrementCounter("dispatch_accept_total");
    this.observeHistogram("dispatch_accept_latency_ms", latencyMs);
  }

  recordBookingCreated(): void {
    this.incrementCounter("booking_created_total");
  }

  recordBookingCancelled(reason?: string): void {
    this.incrementCounter("booking_cancelled_total", 1, { reason: reason ? reason.slice(0, 30) : "unspecified" });
  }

  recordBookingCompleted(): void {
    this.incrementCounter("booking_completed_total");
  }

  recordNotificationAttempt(channel: "fcm" | "socket" = "fcm"): void {
    this.incrementCounter("notification_attempts_total", 1, { channel });
  }

  recordNotificationSuccess(channel: "fcm" | "socket" = "fcm"): void {
    this.incrementCounter("notification_success_total", 1, { channel });
  }

  recordNotificationFailure(channel: "fcm" | "socket" = "fcm", errorType: "transient" | "permanent" = "transient"): void {
    this.incrementCounter("notification_failure_total", 1, { channel, error_type: errorType });
  }

  recordLocationUpdate(): void {
    this.incrementCounter("location_updates_total");
  }

  recordLocationCleanup(deletedRows: number, durationMs: number): void {
    this.incrementCounter("location_cleanup_rows_deleted_total", deletedRows);
    this.observeHistogram("location_cleanup_duration_ms", durationMs);
  }

  recordHttpRequest(method: string, route: string, statusCode: number, durationMs: number): void {
    // Normalizing route to avoid high cardinality
    const normalizedRoute = route.split("?")[0].replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id");
    this.incrementCounter("http_requests_total", 1, {
      method,
      route: normalizedRoute,
      status: String(statusCode),
    });
    this.observeHistogram("http_request_duration_ms", durationMs);
  }

  recordOtpChallenge(purpose: string): void {
    this.incrementCounter("otp_challenges_created_total", 1, { purpose });
  }

  recordOtpVerification(purpose: string, status: "success" | "failed" | "locked"): void {
    this.incrementCounter("otp_verifications_total", 1, { purpose, status });
  }

  recordAuditEvent(action: string, actorRole: string): void {
    this.incrementCounter("security_audit_events_total", 1, { action, role: actorRole });
  }

  /**
   * Formats all collected metrics in standard Prometheus exposition format.
   */
  formatPrometheus(): string {
    const lines: string[] = [];

    // Format counters
    for (const [key, val] of this.counters.entries()) {
      lines.push(`${key} ${val}`);
    }

    // Format gauges
    for (const [key, val] of this.gauges.entries()) {
      lines.push(`${key} ${val}`);
    }

    // Format histograms
    for (const [name, histo] of this.histograms.entries()) {
      let cumulative = 0;
      for (const bucket of histo.buckets) {
        cumulative += histo.data.buckets[bucket] || 0;
        lines.push(`${name}_bucket{le="${bucket}"} ${cumulative}`);
      }
      lines.push(`${name}_bucket{le="+Inf"} ${histo.data.count}`);
      lines.push(`${name}_sum ${histo.data.sum}`);
      lines.push(`${name}_count ${histo.data.count}`);
    }

    return lines.join("\n") + "\n";
  }

  /**
   * Resets all metrics (primarily for test environments).
   */
  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    for (const histo of this.histograms.values()) {
      histo.data.count = 0;
      histo.data.sum = 0;
      histo.data.buckets = {};
    }
  }
}

export const metricsService = new MetricsService();
