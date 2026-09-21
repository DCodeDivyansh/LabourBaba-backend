# Issues 41–45 Remediation Report: Observability, Hardening & Durable Notifications

## Executive Summary
This document provides a comprehensive technical architecture, production invariant specification, and verification report for Issues 41 through 45 of the LabourBaba Production-Grade Remediation Roadmap v2:
- **Issue 41**: Ingress Request ID and Correlation ID generation, AsyncLocalStorage context store, log correlation, and BullMQ / Socket.IO metadata propagation.
- **Issue 42**: Distributed Redis-backed multi-dimensional rate limiting (IP, phone, authenticated user, device) with privacy-preserving key hashing, route-specific thresholds for auth/dispatch/chat, and fail-safe memory fallback.
- **Issue 43**: Production HTTP security hardening with Helmet headers, strict allowlisted CORS, explicit trusted proxy configuration, 30s request deadline timeout, and 1MB body limits with raw buffer retention for webhook HMAC signature verification.
- **Issue 44**: PostgreSQL-backed durable transactional notification outbox (`notification_outbox`), atomic transactional dual-write with business mutations, concurrency-safe claiming, startup reconciliation, and decoupled side effect delivery.
- **Issue 45**: Production FCM delivery lifecycle with strict credential gatekeeper (`assertFcmConfig()`), `WorkerDevice` as the authoritative multi-device push registry, automatic invalid token revocation (`revokeByToken`), and transient error retry classification.

---

## Issue 41 — Request/Correlation IDs
### 1. Root Cause & Architectural Gaps
- **Missing Correlation**: Inbound requests generated fragmented IDs without standard sanitization or propagation into downstream background workers and event streams.
- **Context Loss**: Downstream database and worker logs lacked automatic correlation without explicit parameter plumbing across multiple service layers.

### 2. Implemented Architecture
- **Canonical Request Context (`src/utils/requestContext.ts`)**: Built on Node.js `AsyncLocalStorage<RequestContext>` to store:
  - `requestId`: Unique identifier for the individual HTTP request.
  - `correlationId`: Logical business transaction trace identifier.
  - `userId`, `workerId`, `role`: Authenticated principal metadata.
- **Ingress Middleware (`src/middlewares/requestLogger.ts`)**:
  - Validates and sanitizes incoming `X-Request-ID` and `X-Correlation-ID` headers against `^[a-zA-Z0-9_\-\.]{1,128}$`.
  - Rejects malformed or oversized headers and generates fresh cryptographically secure UUIDv4 identifiers.
  - Attaches `X-Request-ID` and `X-Correlation-ID` to the outgoing HTTP response.
  - Wraps the entire downstream request lifecycle inside `runWithRequestContext()`.
- **Structured Logger Integration (`src/utils/logger.ts`)**:
  - Automatically extracts `requestId` and `correlationId` from `getRequestContext()`.
  - Injects correlation tags into all JSON log entries across the application.
- **Asynchronous Propagation**:
  - Background workers and queue producers forward `correlation_id` in BullMQ job data and Outbox payload metadata.

---

## Issue 42 — Route-Specific Rate Limits
### 1. Root Cause & Architectural Gaps
- **Single-Dimensional Limiting**: Previous rate limits relied solely on raw IP addresses, allowing mobile carrier NAT sharing to block legitimate users while failing to prevent multi-IP brute force attacks on specific phone numbers.
- **Unbounded Key Cardinality**: Attacker-controlled inputs in Redis keys risked memory exhaustion.

### 2. Implemented Architecture (`src/middlewares/rateLimiter.ts`)
- **Multi-Dimensional Limiting**:
  - **Phone Dimension**: Protects `/api/auth/send-otp` and `/api/auth/verify-otp` (e.g., 5 OTP requests per phone per 15 min).
  - **IP Dimension**: Bounded abuse threshold across entire subnets.
  - **User/Worker Dimension**: Authenticated dispatch and chat actions rate limited per authenticated principal (`req.user.id`).
- **Privacy-Preserving SHA-256 Key Hashing**:
  - Raw phone numbers, IPs, and user IDs are normalized and hashed via `sha256(raw).slice(0, 16)` before inclusion in Redis keys (e.g., `ratelimit:auth_otp:phone:a1b2c3d4e5f67890`).
  - Completely eliminates PII exposure in Redis logs and memory dumps.
- **Atomic Enforcement**:
  - Uses atomic Redis `INCR` + `EXPIRE` transactions to prevent race conditions.
  - Returns standard HTTP `429 Too Many Requests` with `Retry-After` header and safe JSON error payload.
- **High Availability & Fail-Safe Fallback**:
  - If Redis experiences a connection hiccup, gracefully falls back to an in-process LRU memory counter to maintain defense without crashing.
- **Preservation of Webhooks**:
  - Razorpay webhooks (`/api/webhooks/razorpay`) bypass generic user limiters and rely strictly on cryptographic HMAC signature verification.

---

## Issue 43 — HTTP Security Hardening
### 1. Root Cause & Architectural Gaps
- Missing standard security headers (HSTS, CSP, Frameguard, XSS Protection).
- Unrestricted JSON payload sizes vulnerable to memory exhaustion DOS.
- Global JSON parsing breaking raw Buffer availability for payment webhook HMAC-SHA256 signature verification.
- Unbounded client connection duration allowing slowloris denial of service.

### 2. Implemented Architecture (`src/server.ts`, `src/middlewares/requestTimeout.ts`)
- **Helmet Security Headers**: Configured across all HTTP responses with strict HSTS, Frameguard (`DENY`), and X-Content-Type-Options (`nosniff`).
- **Strict CORS Allowlist**: Explicitly matches configured production origins (`ALLOWED_ORIGINS` / `FRONTEND_URL`), blocking wildcard credentials combinations.
- **Explicit Proxy Trust**: Set to `process.env.TRUST_PROXY || 1` for accurate client IP resolution behind AWS ALB / Cloudflare without trusting arbitrary client spoofing.
- **Bounded Request Timeout**: Hard 30-second execution deadline (`requestTimeoutMiddleware`) returning HTTP `504 Gateway Timeout`.
- **1MB Body Limits with Raw Buffer Preservation**:
  ```typescript
  express.json({
    limit: "1mb",
    verify: (req: any, _res, buf) => {
      req.rawBody = buf; // Preserves raw Buffer for Razorpay webhook HMAC verification
    },
  });
  ```

---

## Issue 44 — Durable Notification Outbox
### 1. Root Cause & Architectural Gaps
- **Dual-Write Vulnerability**: Notification delivery (FCM, Socket.IO) was invoked directly during business transactions. If FCM timed out or failed, transactions could rollback, or if the database crashed after FCM succeeded, phantom notifications were delivered.

### 2. Implemented Architecture (`src/services/outboxService.ts`, `src/workers/outboxWorker.ts`)
- **Database Schema**:
  ```prisma
  model notification_outbox {
    id              String    @id @default(uuid())
    event_type      String
    aggregate_type  String
    aggregate_id    String
    recipient_type  String
    recipient_id    String
    payload         Json
    status          String    @default("PENDING") // PENDING, PROCESSING, SENT, FAILED
    attempts        Int       @default(0)
    max_attempts    Int       @default(5)
    last_error      String?
    idempotency_key String?   @unique
    correlation_id  String?
    available_at    DateTime  @default(now())
    processed_at    DateTime?
    created_at      DateTime  @default(now())
    updated_at      DateTime  @updatedAt

    @@index([status, available_at])
    @@index([aggregate_type, aggregate_id])
    @@index([recipient_id])
  }
  ```
- **Transactional Atomicity**: Outbox records are inserted *within the same PostgreSQL transaction* as the domain mutation:
  ```typescript
  await prisma.$transaction(async (tx) => {
    await tx.requirement.update({ ... });
    await outboxService.createOutboxEvent(tx, {
      eventType: "incoming_job",
      aggregateType: "requirement",
      aggregateId: requirement.id,
      recipientType: "worker",
      recipientId: worker.id,
      payload: { ... },
      idempotencyKey: `dispatch:${requirement.id}:${worker.id}:wave1`,
      correlationId: getCorrelationId(),
    });
  });
  ```
- **Claiming & Processing Loop**:
  - `claimPendingEvents(limit)` claims pending events with timestamp-based concurrency safety.
  - `processOutboxBatch()` routes events to Socket.IO and FCM asynchronously.
  - Transient failures trigger exponential backoff (`Math.pow(2, attempts) * 1000ms`) and increment attempt count.
  - Permanent failures transition to `FAILED` after reaching `max_attempts`.
- **Crash Recovery & Reconciliation**:
  - On startup and periodic intervals, `reconcileStaleEvents()` reclaims events stuck in `PROCESSING` status for over 5 minutes.

---

## Issue 45 — FCM Delivery Lifecycle
### 1. Root Cause & Architectural Gaps
- **Single-Token Vulnerability**: Legacy systems assumed a single device per worker.
- **Silent Failures & Zombie Tokens**: Unregistered or invalid tokens lingered in the database indefinitely, causing repeated failed calls to Firebase APIs.
- **Missing Production Gatekeeper**: Production boots without valid service credentials ran undetected until the first notification attempt.

### 2. Implemented Architecture (`src/shared/fcm.ts`, `src/features/worker_device/worker_device.service.ts`)
- **Strict Startup Configuration Assertion (`assertFcmConfig()`)**:
  - In `production`, fails fast on startup if neither `FIREBASE_SERVICE_ACCOUNT_JSON`, local service account file, nor `GOOGLE_APPLICATION_CREDENTIALS` is present.
- **WorkerDevice as the Canonical Push Registry**:
  - All push deliveries query `workerDeviceService.getActiveDevices(workerId)`.
  - Supports multiple active devices per worker (Android, iOS, Web).
  - Multi-device delivery is parallelized with `Promise.allSettled`.
- **Automatic Invalid Token Revocation (`isPermanentInvalidTokenError`)**:
  - Detects permanent provider errors (`registration-token-not-registered`, `invalid-registration-token`, `requested entity was not found`).
  - Automatically executes `workerDeviceService.revokeByToken(token)` to mark the device `is_active: false` and set `revoked_at: new Date()`.
- **Partial Multi-Device Failure Resilience**:
  - If a worker has 2 devices and Device A succeeds while Device B has an invalid token, Device A succeeds, Device B is revoked, and the overall dispatch remains resilient.

---

## Verification Test Summary

All test suites were executed against the test environment with PostgreSQL and Redis:

| Test Suite | Focus Area | Status |
|---|---|---|
| `tests/requestCorrelation.test.ts` | Request ID & Correlation ID Ingress, Sanitization & Context | **PASS (5/5)** |
| `tests/routeRateLimiting.test.ts` | Multi-Dimensional Rate Limits, Privacy Hashing, 429 Contract | **PASS (4/4)** |
| `tests/httpSecurityHardening.test.ts` | Helmet Headers, CORS Allowlist, 1MB Limit, Raw Body, Timeout | **PASS (5/5)** |
| `tests/durableNotificationOutbox.test.ts` | Atomic Outbox Transactions, Concurrency Claiming, Retries | **PASS (8/8)** |
| `tests/fcmDeliveryLifecycle.test.ts` | FCM Multi-Device Delivery, Auto-Revocation, Production Guard | **PASS (5/5)** |

### Build & Typecheck Verification
- **TypeScript Typecheck (`npx tsc --noEmit`)**: **PASS (0 errors)**
- **Production Build (`npm run build`)**: **PASS (Clean build)**
- **Database Migration (`20260921060000_add_notification_outbox`)**: **APPLIED & VERIFIED**
