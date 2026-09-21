# Runbook: Elevated HTTP 5xx Error Rate

## Overview
- **Alert**: `Elevated5xxRate`
- **Severity**: Critical
- **Trigger**: >5% of HTTP requests returned 5xx status codes over a 5-minute rolling window.
- **User Impact**: Customers and workers experience degraded app functionality, failed bookings, or API errors.

---

## 1. Initial Triage
1. **Check Readiness Health Probe**:
   ```bash
   curl -i http://localhost:5000/health/ready
   ```
2. **Inspect Structured Error Logs**:
   - Filter logs by `level: "ERROR"` and `statusCode: 500`.
   - Identify common `requestId`, `route`, or unhandled `AppError` domains.

## 2. Likely Causes
- **Database Connection Pool Exhaustion**: PostgreSQL connection pool reached maximum limit (`DATABASE_URL`).
- **Downstream Provider Outage**: External dependencies (e.g. Firebase, Upstash) timing out during synchronous request processing.
- **Unhandled Exceptions / Regression**: Recent deployment introducing null pointer exceptions.

## 3. Mitigation & Recovery
1. **Verify Database Health**:
   - Confirm active connections: `SELECT count(*) FROM pg_stat_activity WHERE state = 'active';`
2. **Check Redis Connectivity**:
   - Check if Redis client is failing commands.
3. **Rollback**:
   - If error correlates directly with a recent deployment, trigger blue/green rollback to last known stable container image.
