# LabourBaba Backend — Observability & Telemetry Standard

## 1. Metrics & Instrumentation (`/metrics`)
All application metrics are exported in standard Prometheus format using `prom-client`.

### Core Metrics Emitted:
- `http_requests_total{method, route, status}` — Counter
- `http_request_duration_seconds{method, route, status}` — Histogram (p50, p95, p99)
- `dispatch_operations_total{status, skill}` — Counter
- `dispatch_latency_seconds` — Histogram
- `notification_outbox_queue_depth{status}` — Gauge
- `payment_reconciliation_total{status}` — Counter
- `rate_limit_hits_total{type, target}` — Counter

---

## 2. Structured JSON Logging
All application logs are formatted as single-line JSON objects with standard trace context:
```json
{
  "timestamp": "2026-09-22T01:30:00.000Z",
  "level": "INFO",
  "service": "labourbaba-backend",
  "requestId": "97aa2f40-7693-43a9-9a10-9393f20e8c20",
  "correlationId": "97aa2f40-7693-43a9-9a10-9393f20e8c20",
  "message": "HTTP POST /api/bookings/confirm 200 (45ms)",
  "route": "/api/bookings/confirm",
  "method": "POST",
  "statusCode": 200,
  "durationMs": 45,
  "userId": "00000000-0000-4001-c000-000000000001"
}
```

### Sensitive Data Redaction
The logger automatically masks:
- `Authorization: Bearer <token>`
- `password`, `otp`, `secret`
- `refresh_token`, `device_token`, `fcm_token`
- Credit card / Razorpay secret headers

---

## 3. Health & Readiness Probes
- **Liveness**: `GET /health/live` (200 OK if Node event loop is responsive)
- **Readiness**: `GET /health/ready` (200 OK only if PostgreSQL `SELECT 1` and Redis `PING` succeed)
