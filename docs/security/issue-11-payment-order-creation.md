# P0 Issue #11 Remediation: Payment Order Creation Is Mocked

**Severity:** P0 — Release Blocker  
**Primary Code Area:** `src/features/payment/paymentServices.ts`  
**Status:** RESOLVED  
**Date:** 2026-09-18

---

## 1. Finding

The production-readiness audit identified that the payment flow generates order IDs locally using `Math.random()` rather than creating real Razorpay orders. The flow was entirely mocked and could not be trusted for any payment settlement, tracking, or verification.

**Why P0:** Any customer could "pay" for a service by triggering the order endpoint, receive a locally-generated order ID that Razorpay had never seen, and the system would consider the order "created" without any real money movement. Additionally, the webhook endpoint trusted any caller without verifying the Razorpay signature, meaning anyone could mark a payment as COMPLETED by posting to the webhook.

---

## 2. Original Implementation

**File:** `src/features/payment/paymentServices.ts` (pre-remediation)

```typescript
async createOrder(bookingId: string, amount: number) {
  // Mock Razorpay Order Creation
  const orderId = `order_${Math.random().toString(36).substring(7)}`;

  return await prisma.payment.create({
    data: {
      booking_id: bookingId,
      amount: amount,          // ← directly from client (untrusted)
      razorpay_order_id: orderId,  // ← locally generated, NOT from Razorpay
      status: "PENDING"
    }
  });
}
```

**Webhook handler** (`paymentServices.ts`):
```typescript
async handleWebhook(payload: any) {
  // No signature verification — any HTTP caller could mark a payment COMPLETED
  const event = payload.event;
  if (event === "payment.captured") { ... }
}
```

**Controller** (`paymentController.ts`):
```typescript
const { amount } = req.body;  // ← client controlled the payment amount
```

**Routes** (`paymentRoutes.ts`):
```typescript
// No requireRole — workers and admins could create payment orders for any booking
router.post("/:bookingId/create-order", authenticateJWT, validateBody(...), createOrder);
```

---

## 3. Root Cause

A locally generated identifier (regardless of whether it looks like a Razorpay order ID) is **not** evidence that Razorpay has created an order. Evidence of provider-side order existence requires:

1. The backend called the Razorpay API.
2. Razorpay returned an HTTP 200 with a valid `order.id`.
3. The response was validated (amount, currency match).
4. The `order.id` was persisted.

None of these were satisfied. The system was persisting random strings as if they were Razorpay order IDs. No money was ever at stake because checkout could never be completed against a non-existent provider order.

---

## 4. Attack / Business Impact

| Risk | Impact |
|---|---|
| Fake provider order | Payments could be "created" with zero real intent from Razorpay |
| Client-controlled amount | Attacker could set amount=1 to get a provider order for ₹0.01 |
| No RBAC | Any authenticated user (worker, admin) could hit the payment endpoint |
| No ownership | Any customer could target any bookingId |
| Unsigned webhook | Anyone could POST `payment.captured` to mark a payment COMPLETED |
| No order association | Valid webhook from another Razorpay order could complete wrong payment |

---

## 5. New Architecture

```
Customer (CUSTOMER role JWT)
      ↓
POST /api/payments/:bookingId/create-order
      ↓
authenticateJWT  →  requireRole(CUSTOMER)
      ↓
paymentController.createOrderHandler()
  - identity from req.user.id (JWT), never request body
      ↓
paymentService.createOrder(bookingId, customerId)
      ↓
  1. Ownership: booking.findFirst({ id: bookingId, customer_id: customerId })
  2. Booking state: must be in { confirmed, OTP_PENDING, PENDING }
  3. Pricing: rate_per_day (rupees, server-side) × 100 = paise
  4. Idempotency: if PENDING order exists → return it without calling Razorpay
  5. Provider: razorpayProvider.createOrder({ amountPaise, currency: "INR", receipt })
  6. Response validation: order.id ≠ empty, amount match, currency match
  7. DB persist: razorpay_order_id, amount, currency, status=PENDING, idempotency_key=bookingId
      ↓
Client receives: { paymentId, razorpayOrderId, amount, currency, status: "PENDING" }
      ↓
Client initiates Razorpay Checkout using the real razorpayOrderId
      ↓
Razorpay payment gateway
      ↓
Razorpay signs and sends webhook:
  POST /api/payments/webhook
  Header: X-Razorpay-Signature: <hmac-sha256>
      ↓
express.raw({ type: 'application/json' })  ← raw body preserved for HMAC
      ↓
paymentController.handleWebhookHandler()
  - rawBody passed to service unchanged
      ↓
paymentService.handleWebhook(rawBody, signature)
  1. verifyWebhookSignature(rawBody, sig, RAZORPAY_WEBHOOK_SECRET) — HMAC-SHA256
  2. Parse event from verified body
  3. Look up local payment by razorpay_order_id from event
  4. Validate amount + currency match
  5. On payment.captured → status=COMPLETED, razorpay_payment_id stored
  6. On payment.failed  → status=FAILED
  7. Idempotency: skip if already in terminal state
```

---

## 6. Database Changes

### New fields in `payment` model

| Field | Type | Purpose |
|---|---|---|
| `razorpay_payment_id` | `String? @db.VarChar(255)` | Populated by webhook after capture. Null at order creation. |
| `currency` | `String @default("INR")` | ISO 4217 code. Always INR. |
| `idempotency_key` | `String? @unique` | = `booking_id`. Prevents duplicate provider order calls. |

### Migration

File: `prisma/migrations/20260918020000_payment_provider_fields/migration.sql`

- All new columns are nullable with safe defaults.
- Existing payment records get `currency = 'INR'` (via DEFAULT).
- `idempotency_key` is NULL for existing records (unique constraint skips NULLs in PostgreSQL).

### Existing constraints

`booking_id` remains `@unique` (one payment per booking — pre-existing).  
`razorpay_order_id` remains `@unique` (one order ID maps to one local payment).

---

## 7. Razorpay Integration

| Detail | Value |
|---|---|
| SDK | `razorpay` (official npm package, bundled TypeScript types) |
| SDK version | As specified in `package.json` after `npm install razorpay` |
| API called | `razorpay.orders.create({ amount, currency, receipt, notes })` |
| Amount unit | **Paise** (smallest INR unit). 1 rupee = 100 paise. |
| Currency | `"INR"` — hardcoded server-side configuration |
| Receipt field | `bookingId.substring(0, 40)` (Razorpay limit: 40 chars; UUID is 36 chars ✓) |
| Idempotency | Razorpay does not support per-request idempotency keys on `orders.create`. Application-level idempotency via `idempotency_key = bookingId` guards against duplicate DB writes. |
| Webhook verification | HMAC-SHA256 of raw body bytes using `RAZORPAY_WEBHOOK_SECRET` |

### Environment variables

```env
RAZORPAY_KEY_ID       # Razorpay API Key ID     (rzp_test_... or rzp_live_...)
RAZORPAY_KEY_SECRET   # Razorpay API Key Secret
RAZORPAY_WEBHOOK_SECRET  # Set in Razorpay Dashboard → Webhooks
```

Production startup fails if any of these are absent or insecure.

---

## 8. Monetary Unit Decision

`job_requirement.rate_per_day` is stored as an **integer in rupees** (e.g., `500` = ₹500/day).

Razorpay requires amounts in **paise** (smallest INR unit).

Conversion: `amountPaise = rate_per_day × 100`

Example: `rate_per_day = 500` → `amountPaise = 50000` (₹500.00)

This is an **MVP**: 1 day of work = 1 payment. Days can be made configurable in a future iteration. The conversion is tested explicitly in `paymentSecurity.test.ts`.

---

## 9. Idempotency

**What `idempotency_key = bookingId` means:**
- There is at most **one payment order per booking**.
- This is a product-level invariant: each confirmed booking results in at most one Razorpay order.
- If the client retries the create-order endpoint for the same booking:
  - The service checks for an existing PENDING payment with a valid `razorpay_order_id`.
  - If found, it returns the existing order **without calling Razorpay again**.
  - If the existing payment is COMPLETED, a 409 is returned.
  - If the existing payment is FAILED, a new Razorpay order is created (retry).

**Database guard:** `idempotency_key` has `@unique` constraint. Even if application logic fails, the DB will reject a duplicate insert (`P2002`), which is caught and handled gracefully.

**Known gap:** Razorpay does not support idempotency keys on `orders.create`. If two concurrent requests both pass the application-level check simultaneously, two Razorpay orders may be created. The second DB insert will fail with P2002, creating one orphan Razorpay order. This is logged with the orphan `razorpayOrderId` for manual reconciliation via the Razorpay dashboard using the `receipt = bookingId` field.

---

## 10. Failure Handling

| Scenario | Behaviour |
|---|---|
| Provider unavailable | `RazorpayProviderError` thrown → 502, no DB write |
| Provider timeout | Propagated as unexpected error → 500, no DB write |
| Provider returns wrong amount | `PAYMENT_AMOUNT_MISMATCH` → 502, no DB write |
| Provider returns wrong currency | `PAYMENT_CURRENCY_MISMATCH` → 502, no DB write |
| Provider returns empty order ID | `PAYMENT_PROVIDER_RESPONSE_INVALID` → 502, no DB write |
| DB write fails after provider success | Orphan provider order logged (receipt = bookingId), `PAYMENT_PERSISTENCE_FAILED` → 500 |
| Concurrent duplicate request | P2002 caught → existing payment returned |
| Duplicate webhook event | Idempotency check skips re-processing if already in terminal state |
| Webhook missing signature | 401 |
| Webhook invalid signature | 401 `WEBHOOK_INVALID_SIGNATURE` |
| Webhook for different order | 200 acknowledged, no state change |

---

## 11. Security

| Invariant | Enforcement |
|---|---|
| Only customers can create orders | `requireRole(UserRole.CUSTOMER)` on route |
| Booking must be owned by caller | `booking.findFirst({ customer_id: req.user.id })` |
| Amount is server-derived | `rate_per_day × 100` paise; no amount field in request |
| No local random order IDs | `razorpayProvider.createOrder()` calls real API; no `Math.random()` |
| Provider response validated | order.id, amount, currency checked against expected values |
| Webhook signature verified | HMAC-SHA256 on raw body bytes before JSON parsing |
| Webhook order association | `payment.findUnique({ razorpay_order_id })` — only matching order triggers state change |
| Payment ID isolation | `payment.status` set PENDING at creation; only webhook moves to COMPLETED |

---

## 12. Tests Added

**File:** `tests/paymentSecurity.test.ts`

| Group | Tests | Invariant Proved |
|---|---|---|
| Authentication | 3 | Unauthenticated callers get 401 |
| RBAC | 4 | Worker and admin get 403 on all payment routes |
| Ownership | 3 | Customer B cannot access Customer A payment |
| Amount derivation | 7 | Server derives amount; client values are ignored |
| Successful creation | 3 | Real provider ID persisted; credentials not leaked |
| Provider failure | 3 | No payment on provider error, safe response |
| Response validation | 3 | Amount/currency/ID mismatch → rejected |
| State | 2 | Order creation → PENDING, never COMPLETED |
| Idempotency | 3 | Duplicate request returns existing order; no double call |
| Concurrency | 1 | P2002 race handled gracefully |
| Booking state | 5 | Only payable statuses allowed |
| Webhook | 8 | Signature required; captured → COMPLETED; idempotent; order association |
| Payment status | 2 | Ownership enforced on read |
| Refund | 4 | Ownership + lifecycle enforced |
| verifyWebhookSignature unit | 6 | HMAC correctness, timing safety, buffer support |

**Total: 57 tests**

---

## 13. Remaining Findings (Still Open)

| Finding | Status | Notes |
|---|---|---|
| **#14 — Real Razorpay Refund API** | **OPEN** | `refundPayment()` enforces ownership/lifecycle but calls no Razorpay Refund API. Local DB update only. |
| **#20 — Payment lookup exposes other user's data** | **FIXED** as part of #11 | `getPaymentStatus()` now enforces ownership. |
| **#49 — Webhook lacks idempotent event handling** | **PARTIALLY FIXED** | Status-based idempotency implemented; no provider event ID persistence (full event deduplication not added). |
| **#50 — Amount/currency not reconciled** | **FIXED** as part of #11 | Server derives authoritative amount; webhook validates amount/currency match. |
| **#51 — Refund lacks ownership/lifecycle** | **FIXED** as part of #11 | Ownership and lifecycle checks enforced. |
| **#75 — POST operations lack idempotency** | **PARTIALLY FIXED** | idempotency_key = bookingId for order creation. Full HTTP idempotency header system not implemented. |
| **#12 — Webhook trusts request body** | **FIXED** as part of #11 | HMAC-SHA256 verification on raw body. |
| **#13 — Client controls payment amount** | **FIXED** as part of #11 | Amount derived server-side only. |

---

## 14. Verification

```bash
# TypeScript compilation
npm run build
# → Exit code 0

# Payment security test suite
npm test -- --testPathPattern=paymentSecurity
# → All tests pass

# Prisma schema validation
npx prisma validate
# → Prisma schema validated successfully

# Confirm no Math.random / fake order in production payment path
grep -n "Math.random\|orderId =\|order_\${" src/features/payment/
# → No matches (search returns empty)
```
