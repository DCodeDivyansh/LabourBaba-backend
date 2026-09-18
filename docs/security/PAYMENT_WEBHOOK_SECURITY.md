# Payment Webhook Security

## Purpose

This document describes the security architecture implemented for the Razorpay payment webhook endpoint in LabourBaba.

A payment webhook receives an HTTP POST from Razorpay announcing that a payment has been captured, failed, or another event has occurred. Trusting this call without verification would allow an attacker who can reach the webhook endpoint to:

- Forge a successful payment event for a booking they have not paid for.
- Mark arbitrary payments as completed without any real money movement.
- Trigger financial side effects (booking completion, worker payments) fraudulently.

The webhook must therefore enforce four independent controls:

```text
Raw request
    ↓
Cryptographic signature verification
    ↓
Provider event identity / idempotency
    ↓
Atomic payment state transition
```

---

## Threat Model

| Threat | Description | Mitigated By |
|---|---|---|
| **Forged webhook** | Attacker sends a crafted POST to /api/payments/webhook with a fake payment.captured payload | HMAC-SHA256 signature verification against raw bytes |
| **Missing signature** | Attacker omits the X-Razorpay-Signature header | Controller rejects with 401 before calling service |
| **Modified payload** | Attacker intercepts a valid Razorpay signature and replaces the payload body | Signature is verified against raw bytes; any byte change invalidates the HMAC |
| **Replayed valid event** | Attacker replays a legitimately signed webhook captured earlier | Database uniqueness constraint on (provider, providerEventId) |
| **Concurrent duplicate delivery** | Razorpay delivers the same event twice simultaneously (common on retries) | Unique constraint; only one concurrent INSERT can succeed |
| **Unknown order** | Valid Razorpay signature but the order_id references an unknown LabourBaba payment | Payment reconciliation: findUnique fails → FAILED webhook event, no state change |
| **Amount mismatch** | Provider event amount differs from LabourBaba's stored expected amount | Explicit amount comparison before state transition |
| **Currency mismatch** | Provider currency differs from expected INR | Explicit currency comparison before state transition |
| **Missing secret misconfiguration** | RAZORPAY_WEBHOOK_SECRET not set in staging/development | Fail-closed: acknowledge without processing, no payment mutation |

---

## Request Flow

```text
Razorpay
   ↓
POST /api/payments/webhook
   ↓
CORS (server-to-server — no Origin)
   ↓
express.json verify callback (server.ts)
   → req.rawBody = Buffer (exact bytes before parsing)
   ↓
paymentController.handleWebhookHandler
   → extract X-Razorpay-Signature header
   → reject 401 if header missing (before calling service)
   → pass rawBody: Buffer + signature to paymentServices.handleWebhook
   ↓
paymentServices.handleWebhook
   → obtain RAZORPAY_WEBHOOK_SECRET from environment
   → if secret missing → return 200 ACK, no mutation (FAIL-CLOSED)
   → verifyWebhookSignature(rawBody, signature, secret)
   →   HMAC-SHA256 of exact raw bytes, timing-safe comparison
   → if invalid → throw PaymentError 401 WEBHOOK_INVALID_SIGNATURE
   → JSON.parse(rawBody.toString('utf8'))  ← parse ONLY after signature confirmed
   → extract eventType, payment entity fields
   → deriveWebhookEventId(eventType, paymentEntityId, orderId)
   ↓
processPaymentCaptured / processPaymentFailed
   → prisma.$transaction(async (tx) => {
       1. tx.paymentWebhookEvent.create(PROCESSING)
          ← unique constraint; P2002 → duplicate delivery → return 200
       2. tx.payment.findUnique(razorpay_order_id)
          ← no match → update event FAILED, return 200 ACK
       3. validate amount & currency
          ← mismatch → update event FAILED, return 200 ACK
       4. tx.payment.updateMany(WHERE status=PENDING, SET status=COMPLETED/FAILED)
          ← count=0 → already transitioned
       5. tx.paymentWebhookEvent.update(PROCESSED, processedAt=now)
     })
     COMMIT (atomic)
   ↓
Post-commit: return { success: true, message }
```

---

## Idempotency Design

### Why per-event identity matters

If we only used the payment record's current status (`if (status === COMPLETED) return`) as our idempotency guard, two simultaneously delivered webhooks could both read `PENDING`, both pass the check, and both write `COMPLETED`. This is a classic TOCTOU race condition.

We solve this with a dedicated `payment_webhook_event` table and a database-unique constraint.

### Idempotency identity per event type

| Razorpay Event | `providerEventId` | Rationale |
|---|---|---|
| `payment.captured` | `paymentEntity.id` (e.g. `pay_abc123`) | Razorpay's payment entity ID is stable across retries; the same capture event always has the same `pay_xxx` ID |
| `payment.failed` | `orderId + ":failed"` | Avoids colliding with a future `pay_xxx` on the same order if the payment later succeeds |
| Other events | `orderId + ":" + eventType` | Deterministic fallback; unique per order+event combination |

The `provider` field is always `"razorpay"` for the current integration.

**Critical property:** The identity is:
- **Stable**: Razorpay reuses the same `pay_xxx` ID when retrying delivery.
- **Deterministic**: computed only from fields in the event, not from random values or timestamps.
- **Unique**: distinguishes legitimately different events on the same order.

### Database invariant

```prisma
@@unique([provider, providerEventId])
```

This constraint is enforced at the PostgreSQL level, independent of:
- Application logic
- Number of Node.js processes
- Number of PM2 workers
- Number of EC2 instances
- Process restarts

Two concurrent INSERTs with the same `(provider, providerEventId)` will result in one succeeding and one receiving a `P2002 Unique constraint violation`. The application maps `P2002` to a safe idempotent 200 response.

---

## Atomic Transaction Boundary

The entire event claim + payment transition + event finalization happens inside a single `prisma.$transaction`:

```
BEGIN
  INSERT payment_webhook_event(PROCESSING)  ← claim event
  SELECT payment WHERE razorpay_order_id=?  ← find payment
  UPDATE payment WHERE id=? AND status=PENDING  ← conditional transition
  UPDATE payment_webhook_event SET status=PROCESSED  ← finalize
COMMIT
```

**Crash semantics:**
- If the process dies before `COMMIT`, the transaction rolls back automatically.
- The `payment_webhook_event` row is not persisted.
- Razorpay will redeliver the webhook.
- The retry starts the entire flow from scratch (INSERT succeeds this time).
- No stale `PROCESSING` row will block future retries.

**Duplicate delivery semantics:**
- If `INSERT payment_webhook_event` raises `P2002`, the event was already committed.
- The service returns `{ success: true, message: "Duplicate event — already processed" }`.
- Razorpay receives HTTP 200 and stops retrying.

---

## Payment State Transition Safety

The payment state transition uses a conditional update:

```typescript
const result = await tx.payment.updateMany({
  where: {
    id: localPayment.id,
    status: PaymentStatus.PENDING,  // ← condition
  },
  data: { status: PaymentStatus.COMPLETED, razorpay_payment_id: ... },
});
// result.count === 1 → this request performed the transition
// result.count === 0 → already transitioned (idempotent)
```

This eliminates the TOCTOU race between reading `payment.status` and writing it.

### Legal state transitions

| Current State | Event | New State | Allowed |
|---|---|---|---|
| `PENDING` | `payment.captured` | `COMPLETED` | ✅ |
| `PENDING` | `payment.failed` | `FAILED` | ✅ |
| `COMPLETED` | `payment.captured` | `COMPLETED` | ✅ idempotent (count=0) |
| `COMPLETED` | `payment.failed` | `FAILED` | ❌ blocked by WHERE condition |
| `FAILED` | `payment.captured` | `COMPLETED` | ❌ blocked by WHERE condition |
| `REFUNDED` | any | any | ❌ blocked by WHERE condition |

A `COMPLETED` payment receiving a later `payment.failed` event is safely rejected — the `WHERE status=PENDING` clause matches nothing, `count=0`, and the service returns idempotent 200.

---

## Secret Management

### Required environment variable

```text
RAZORPAY_WEBHOOK_SECRET
```

Obtain from the Razorpay Dashboard → Webhooks → Secret.

### Requirements

- **Never** hard-code the secret in source code.
- **Never** commit the secret to Git.
- Store in a secret manager (AWS Secrets Manager, Doppler, Vault, GCP Secret Manager).
- Minimum recommended length: 32 characters.

### Production behavior

`assertProductionPaymentConfig()` (called at startup in `server.ts`) will throw and exit the process if `RAZORPAY_WEBHOOK_SECRET` is missing or contains a known-insecure placeholder value. The server never starts.

### Non-production / missing-secret behavior (FAIL-CLOSED)

If `RAZORPAY_WEBHOOK_SECRET` is missing in any environment (including `development` or `test`):

- The webhook endpoint returns `HTTP 200` (provider-compatible acknowledgement).
- **No payment state is mutated.**
- **No webhook event row is written.**
- A `[SECURITY]` warning is logged.

This is intentionally fail-closed: missing configuration must never result in unauthenticated payment processing. A staging server where the secret is not provisioned cannot be exploited.

### Secret rotation

1. Generate a new secret in Razorpay Dashboard → Webhooks.
2. Update the secret in your secret manager.
3. Deploy the updated secret to the application (rolling deployment).
4. During the rollover window, Razorpay may sign with the old secret. Old signatures will briefly fail until all instances reload.
5. Monitor for `WEBHOOK_INVALID_SIGNATURE` errors during rollover.
6. Once all instances are running the new secret, deactivate the old Razorpay webhook secret.

### What is never logged

- The value of `RAZORPAY_WEBHOOK_SECRET`
- The X-Razorpay-Signature header value
- Any authorization credentials
- Access tokens or refresh tokens
- Complete sensitive webhook payload

---

## Security Logging

All security events are logged with the prefix `[paymentService][SECURITY]` so they can be easily filtered in log aggregation systems.

| Event | Level | What is logged | What is NOT logged |
|---|---|---|---|
| Missing webhook secret | `WARN` | Configuration warning | Secret value |
| Invalid signature | `WARN` | Route, provider, outcome | Secret, signature value, payload |
| Duplicate event | `INFO` | provider, providerEventId | Payment details |
| Unknown order | `ERROR` | razorpayOrderId | PII, secret |
| Amount mismatch | `ERROR` | amounts (paise), paymentId, orderId | Secret, customer data |
| Currency mismatch | `ERROR` | currencies, paymentId | Secret, customer data |
| Payment captured | `INFO` | paymentId, razorpayPaymentId | N/A |

---

## Testing

The following test scenarios are implemented in `tests/paymentSecurity.test.ts`.

### Signature Tests (S1–S8)

| ID | Scenario | Expected |
|---|---|---|
| S1 | Valid signature | 200 accepted |
| S2 | Missing X-Razorpay-Signature | 401 |
| S3 | Invalid signature | 401, no DB mutation |
| S4 | Modified payload + original signature | Real crypto fails |
| S5 | Wrong webhook secret | Real crypto fails |
| S6 | Non-hex signature | Real crypto returns false |
| S7 | Wrong signature length | Real crypto returns false |
| S8 | Empty signature or secret | Returns false |

### Raw Body Tests (A1–A4)

| ID | Scenario | Expected |
|---|---|---|
| A1/A2 | Spy on verifyWebhookSignature | Receives Buffer, not re-serialized string |
| A3 | Tampered payload (changed amount) | Real crypto fails |
| A4 | Whitespace formatting difference | Real crypto fails (proves raw bytes used) |

### Replay Tests (R1–R3)

| ID | Scenario | Expected |
|---|---|---|
| R1 | Same event delivered twice | First: transition. Second: P2002 → 200 duplicate |
| R2 | Same event delivered many times | Only one transition |
| R3 | Concurrent duplicate delivery | One succeeds, one gets P2002 → both 200 |

### Payment Integrity (P1–P7)

| ID | Scenario | Expected |
|---|---|---|
| P1 | Unknown provider order | 200 ack, no mutation |
| P3 | Amount mismatch | 200 ack with mismatch message, no COMPLETED |
| P4 | Currency mismatch | 200 ack with mismatch message |
| P5/P6 | Valid event | Exactly one PENDING→COMPLETED |
| P7 | Already-completed + duplicate | Idempotent 200, no second update |

### Configuration Tests (Cfg1–Cfg4)

| ID | Scenario | Expected |
|---|---|---|
| Cfg2 | Missing secret (any env) | 200 ACK, no DB writes |
| Cfg3 | Invalid signature response | Secret not in response body |
| Cfg4 | Invalid signature logged | Secret not in logs |

---

## Operational Guidance

### Investigating invalid-signature events

Filter logs for: `[paymentService][SECURITY] Razorpay webhook signature verification failed`

Causes:
- Razorpay sending events before the secret is configured (startup race)
- Secret rotation in progress
- Forged/attacker requests
- Configuration mismatch (wrong secret for the webhook URL in Razorpay Dashboard)

Check: Razorpay Dashboard → Webhooks → verify the Secret matches `RAZORPAY_WEBHOOK_SECRET` in your secret manager.

### Investigating payment-mismatch events

Filter logs for: `[paymentService][SECURITY] AMOUNT MISMATCH` or `CURRENCY MISMATCH`

These events indicate the amount or currency Razorpay captured differs from what LabourBaba stored when creating the order. This should never happen under normal operation. Manual review is required before marking such payments as completed.

### Investigating PROCESSING webhook events that never reach PROCESSED

If the process crashes mid-transaction, the transaction rolls back automatically — there should be no stale `PROCESSING` rows. If you find any (which could happen from a manual DB edit or a bug), they are safe to delete or mark `FAILED` for re-delivery.
