# Payment Remediation — Issues 61–70 Production-Grade Architecture & Verification

## 1. Existing Architecture Analysis
Before remediation, the payment subsystem contained critical gaps across provider synchronization, state transitions, refund workflows, and webhook validation:
- Payment amounts were checked at order creation, but lacked a unified schema for provider-side refund tracking and mismatch quarantine.
- Webhook signature verification needed strict guarantee of processing unparsed raw body bytes before application middleware.
- Refund operations were local state mutations (`status = REFUNDED`) without calling the live Razorpay Refund API (`razorpay.payments.refund(...)`) or tracking provider refund IDs.
- Payment transitions were uncentralized and lacked an explicit state transition machine enforcing immutable terminal states.
- There was no automated reconciliation worker for sweeping stale pending orders when webhooks were delayed, dropped, or reordered.

## 2. Problems Discovered
1. **Local-Only Refunds**: The previous refund endpoint updated local status to `REFUNDED` without executing real provider refunds or persisting `razorpay_refund_id`.
2. **Missing Quarantine Mechanism**: Webhook amount or currency mismatches had no formal database quarantine fields, preventing operator visibility without dropping raw event state.
3. **Absence of Background Reconciliation**: Payments that were paid on Razorpay but whose webhooks failed to arrive (due to network partition or provider retry exhaustion) remained stuck in `PENDING` indefinitely.
4. **Prisma Schema Gaps**: The `payment` table lacked fields for `razorpay_refund_id`, `refund_amount`, `refund_status`, `refund_reason`, `quarantine_reason`, and timestamps for reconciliation indexing.

## 3. Issue 61 — Server-Derived Amount
- **Invariant**: The payable amount is calculated authoritatively by the backend from `job_requirement.rate_per_day * 100` (paise). Any client-supplied amount in the request body, query string, or headers is completely ignored.
- **Monetary Units**: Standardized exclusively to integer **Paise** (1 INR = 100 Paise).
- **Rounding Rules**: Integer arithmetic with deterministic conversion; rates must be positive finite numbers.
- **Tests**: Validated in `tests/paymentPricingAndLifecycle.test.ts` and `tests/paymentSecurity.test.ts` (Sections 4 & 5).

## 4. Issue 62 — Razorpay Order Lifecycle
- **Implementation**: `razorpayCreateOrder` in `src/providers/razorpay/razorpayProvider.ts` invokes the real Razorpay Orders API (`razorpay.orders.create`) with receipt reference (booking ID) and metadata notes.
- **Persistence**: Persists `razorpay_order_id`, `amount`, `currency`, `status: PENDING`, and `idempotency_key = bookingId`.
- **Failure & Timeout Handling**: Provider errors or timeouts result in 502/504 errors without corrupting local records. Duplicate creation requests return the existing `PENDING` order idempotently.
- **Tests**: Validated in `tests/paymentPricingAndLifecycle.test.ts`.

## 5. Issue 63 — Webhook Signature Verification
- **Implementation**: Webhooks receive raw unparsed buffer bytes captured via Express verification middleware (`req.rawBody`).
- **Signature Algorithm**: HMAC-SHA256 computed over raw buffer bytes with `timingSafeEqual` comparison against `x-razorpay-signature`.
- **Execution Order**: Signature verification occurs *strictly before* any database lookup or state mutation. Invalid signatures are rejected with 401.
- **Tests**: Validated in `tests/paymentWebhookAndReconciliation.test.ts` and `tests/paymentSecurity.test.ts` (Sections 13 & 14).

## 6. Issue 64 — Webhook Idempotency
- **Implementation**: The database table `PaymentWebhookEvent` enforces a composite unique constraint `@@unique([provider, providerEventId])`.
- **Transactional Claim**: When a webhook arrives, `paymentWebhookEvent.create` claims the event transactionally. Concurrent identical requests trigger a unique constraint violation (P2002), which returns a safe provider response (`Duplicate event — already processed`) without repeating side effects.
- **Tests**: Validated in `tests/paymentWebhookAndReconciliation.test.ts` and `tests/paymentWebhookConcurrency.test.ts`.

## 7. Issue 65 — Amount/Currency Reconciliation
- **Implementation**: When `payment.captured` arrives:
  1. Provider amount is verified against `localPayment.amount`.
  2. Provider currency is verified against `localPayment.currency`.
- **Mismatch Quarantine**: On mismatch, the payment is **NEVER** marked `COMPLETED`. Instead, `quarantine_reason` is updated, the webhook event status is set to `FAILED`, and an audit log + error metric are emitted.
- **Tests**: Validated in `tests/paymentWebhookAndReconciliation.test.ts` and `tests/paymentSecurity.test.ts` (Section 16).

## 8. Issue 66 — Real Refund Lifecycle
- **Implementation**: `refundPayment` calls `razorpayCreateRefund` via `razorpay.payments.refund(paymentId, payload)`.
- **State Lifecycle**:
  - `COMPLETED` -> `REFUND_PENDING` (prior to external call).
  - On provider success: `REFUND_PENDING` -> `REFUNDED`, persisting `razorpay_refund_id`, `refund_amount`, and `refund_status`.
  - On provider error: `REFUND_PENDING` -> `REFUND_FAILED`, persisting `refund_reason`.
- **Tests**: Validated in `tests/paymentRefundsAndAuthorization.test.ts`.

## 9. Issue 67 — Refund Authorization
- **Implementation**:
  - `CUSTOMER`: Can refund **ONLY** their own booking. Unrelated bookings are rejected with 403.
  - `WORKER`: Strictly forbidden from refunding customer payments (403).
  - `ADMIN`: Permitted to refund eligible payments for dispute resolution.
  - `Lifecycle Guard`: Refunds permitted only on `COMPLETED` or retryable `REFUND_FAILED` payments; `PENDING` or `FAILED` payments are rejected (409).
- **Tests**: Validated in `tests/paymentRefundsAndAuthorization.test.ts` and `tests/paymentSecurity.test.ts` (Section 20).

## 10. Issue 68 — Payment State Machine
Centralized state transitions via `transitionPaymentStatus(tx, paymentId, fromStatus, toStatus)`.

| From Status | Allowed To Statuses | Notes |
|:---|:---|:---|
| `PENDING` | `COMPLETED`, `FAILED` | Provider webhook / reconciliation outcome |
| `COMPLETED` | `REFUND_PENDING` | Customer / Admin initiates refund |
| `REFUND_PENDING` | `REFUNDED`, `REFUND_FAILED` | Provider refund success / failure |
| `REFUND_FAILED` | `REFUND_PENDING` | Retry refund operation |
| `FAILED` | `PENDING` | Retry payment order creation |
| `REFUNDED` | *(Terminal)* | No transitions allowed |

- `COMPLETED -> FAILED` is strictly blocked.
- Tests: Validated in `tests/paymentPricingAndLifecycle.test.ts`.

## 11. Issue 69 — Reconciliation Worker
- **Implementation**: `PaymentReconciliationService` (`src/services/paymentReconciliationService.ts`) and `paymentReconciliationWorker` (`src/workers/paymentReconciliationWorker.ts`).
- **Functionality**:
  - Sweeps `PENDING` payments older than a configurable threshold (default 15 minutes).
  - Queries `razorpay.orders.fetch(orderId)`.
  - If `paid`: verifies amount/currency, transitions to `COMPLETED`, and emits audit log.
  - If attempts > 3 without payment: transitions to `FAILED`.
  - If amount/currency mismatch: sets `quarantine_reason` and alerts.
- **Tests**: Validated in `tests/paymentReconciliationWorker.test.ts`.

## 12. Issue 70 — Concurrency Testing
- **Implementation**: Real PostgreSQL concurrency test sending 10 identical signed webhooks concurrently via `Promise.all`.
- **Invariants Proven**:
  - Exactly 1 `PaymentWebhookEvent` row created.
  - Exactly 1 state transition (`PENDING -> COMPLETED`).
  - Zero deadlocks, zero duplicate notifications, zero uncaught errors.
- **Tests**: Validated in `tests/paymentWebhookConcurrency.test.ts`.

## 13. Database Changes
- **Migration**: `20260921080000_payment_refund_and_reconciliation_hardening`
- **Fields Added to `payment`**:
  - `razorpay_refund_id String?`
  - `refund_amount Int?`
  - `refund_status String?`
  - `refund_reason String?`
  - `quarantine_reason String?`
  - `created_at DateTime @default(now())`
  - `updated_at DateTime @updatedAt`
- **Indices Added**:
  - `@@index([status, created_at])`
  - `@@index([razorpay_payment_id])`

## 14. API Changes
- `POST /api/payments/:bookingId/create-order`: Server derives amount; returns `{ paymentId, razorpayOrderId, amount, currency, status, bookingId }`.
- `POST /api/payments/webhook`: Raw-body verification; acknowledges retries idempotently.
- `GET /api/payments/:bookingId`: Returns authenticated customer/admin payment status.
- `POST /api/payments/:bookingId/refund`: Accepts optional `{ amount, reason }`; triggers real Razorpay refund lifecycle.

## 15. Configuration Changes
Required environment variables in `.env`:
- `RAZORPAY_KEY_ID`: Razorpay API Key ID.
- `RAZORPAY_KEY_SECRET`: Razorpay API Key Secret.
- `RAZORPAY_WEBHOOK_SECRET`: Secret configured in Razorpay Webhook Dashboard.
- `PAYMENT_CURRENCY`: Default `INR`.

## 16. Testing Evidence
All payment test suites pass cleanly:
1. `tests/paymentPricingAndLifecycle.test.ts` (5 tests) — PASS
2. `tests/paymentWebhookAndReconciliation.test.ts` (5 tests) — PASS
3. `tests/paymentRefundsAndAuthorization.test.ts` (6 tests) — PASS
4. `tests/paymentReconciliationWorker.test.ts` (3 tests) — PASS
5. `tests/paymentWebhookConcurrency.test.ts` (2 tests) — PASS
6. `tests/paymentSecurity.test.ts` (76 tests) — PASS
**Total: 97 / 97 Tests Passing**

## 17. Operational Runbook
- **Stuck PENDING Payment**: Inspect `paymentReconciliationWorker` logs. Check if order exists on Razorpay dashboard. If captured, reconciliation worker auto-resolves state on next sweep.
- **Quarantined Payment**: Query `SELECT * FROM payment WHERE quarantine_reason IS NOT NULL`. Check `quarantine_reason` and compare with provider payment logs.
- **Stuck REFUND_PENDING Payment**: Inspect `payment.refund_reason`. If provider timed out, initiate refund retry after verifying bank status.
- **Provider Outage**: Webhook deliveries queued by Razorpay will be processed upon recovery; reconciliation worker sweeps missed orders once provider is back online.

## 18. Security Review
- Zero secrets or credentials exposed in logs or API responses.
- Customer payment isolation strictly enforced at route, controller, and service layers.
- Raw-body signature verification prevents tampered payload attacks.
- Centralized state machine prevents unauthorized status mutations.
