# Payment Abuse Controls (Issue 72)

## Purpose & Scope
Financial mutation endpoints are high-value targets for brute-force attacks, card testing, replay exploits, and denial-of-service attempts. The LabourBaba backend enforces strict rate limiting, cryptographic signature verification, and behavioral fraud controls.

## Rate Limiting Architecture

### 1. Payment Order Creation Rate Limiter (`paymentOrderRateLimiter`)
- **Route**: `POST /api/payments/create-order`
- **Window**: 15 minutes
- **Max Requests**: 10 per authenticated user/IP key (`ratelimit:payment:order:${userId || ip}`)
- **Header**: Standard `RateLimit-*` and `Retry-After` headers returned on `429 Too Many Requests`.

### 2. Payment Refund Rate Limiter (`paymentRefundRateLimiter`)
- **Route**: `POST /api/payments/refund`
- **Window**: 15 minutes
- **Max Requests**: 5 per user/IP key (`ratelimit:payment:refund:${userId || ip}`)
- **Fail-Safe Behavior**: Utilizes Redis cluster with automatic fallback to local memory cache to prevent fail-open vulnerabilities during transient Redis network partitions.

### 3. Provider Webhook Ingestion Policy
- **No Global IP Throttling**: Provider webhooks (`POST /api/payments/webhook`) are NOT subjected to aggressive IP rate limiting, as provider retries may originate from shared cloud gateway IP ranges.
- **Cryptographic Gate**: Webhook payloads are verified against the server-side `RAZORPAY_WEBHOOK_SECRET` using constant-time HMAC-SHA256 over the raw body buffer.
- **Security Telemetry**: Repeated invalid signature attempts trigger `recordWebhookSignatureFailure()` metrics and structured security audit warnings (`[SECURITY] Razorpay webhook signature verification failed.`).
- **Database Deduplication**: Each webhook payload is stored in `PaymentWebhookEvent` table with a unique constraint on `providerEventId`, preventing replay attacks.

## Suspicious Refund Detection
- Idempotency checks prevent double refunds on already processed or quarantined transactions.
- Role-based authorization ensures only the booking owner or system admin can trigger refunds.
- Uncaptured or zero-amount payments are rejected immediately without invoking provider APIs.
