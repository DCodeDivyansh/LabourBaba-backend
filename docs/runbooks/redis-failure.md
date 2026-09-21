# Runbook: Redis Cache & Queue Failure

## Overview
- **Alert**: `RedisUnavailable`
- **Severity**: Critical
- **Trigger**: Readiness probe failing Redis ping check (`/health/ready` returns Redis unhealthy).
- **User Impact**: BullMQ queue job processing halts; rate limiting falls back to local in-memory store; refresh session token operations degrade.

---

## 1. Initial Triage
1. **Check Redis Endpoint**:
   - Check Upstash / ElastiCache connectivity and network egress.
2. **Review Rate Limiter Logs**:
   - Verify rate limiter fail-safe in-memory fallback logs: `[RATE_LIMIT] Redis check failed... falling back to memory`.

## 2. Likely Causes
- **TLS / Certificate Handshake Issue**: Network timeout to managed Redis.
- **Quota / Rate Limit Exceeded**: Upstash request cap reached.

## 3. Mitigation & Recovery
1. **Fail-Safe Operation**: Application automatically continues serving core auth/booking APIs with local in-memory fallback.
2. **Restore Connection**: Reconfigure `REDIS_URL` or reset Redis token if credentials rotated.
