# P3 Issue 5 — Payment Order Creation External-Provider Race

## 1. Status
**FIXED**

---

## 2. Root Cause
In the previous implementation of payment order creation (`src/features/payment/paymentServices.ts`), the flow was structured as follows:
1. Query local database to check if a payment record exists.
2. If no record is found, immediately issue an external network call to Razorpay (`razorpayCreateOrder`).
3. Razorpay creates the provider order and returns a `razorpayOrderId`.
4. Only *after* Razorpay order creation, attempt to create the local `Payment` database row (`prisma.payment.create`).

Because the existence check in step (1) and the database insert in step (4) did not wrap the external provider call atomically, any concurrent requests (e.g. mobile app duplicate taps, automated client retries, or distributed clients racing) simultaneously found no record in step (1). Both callers invoked the Razorpay Orders API, creating duplicate provider orders. While PostgreSQL's unique constraint on `booking_id` stopped the second insert from creating duplicate local rows, the orphaned external Razorpay order had already been created in Razorpay's systems. This resulted in orphaned provider orders, provider/local state divergence, reconciliation ambiguity, and vulnerability to double charges.

---

## 3. Files Analyzed
- `src/features/payment/paymentServices.ts` — Core payment lifecycle, order creation, state transitions, refunds, and webhook processing.
- `src/features/payment/paymentController.ts` — HTTP layer handling order creation requests and standardized error mapping.
- `src/features/payment/paymentRoutes.ts` — Route definitions, authentication, and RBAC middleware.
- `src/providers/razorpay/razorpayProvider.ts` — Razorpay SDK adapter, error normalization, and webhook signature verification.
- `prisma/schema.prisma` — Payment data models, unique constraints (`booking_id`, `idempotency_key`, `razorpay_order_id`), indexes, and status enums.
- `prisma/migrations/*` — Existing database migrations verifying unique constraints and payment lifecycle rules.
- `tests/paymentSecurity.test.ts` — Security, RBAC, pricing, webhook replay, and lifecycle tests.
- `tests/paymentPricingAndLifecycle.test.ts` — End-to-end payment pricing derivation and lifecycle states.
- `tests/paymentWebhookConcurrency.test.ts` — Real PostgreSQL webhook concurrency tests.
- `tests/paymentReconciliationWorker.test.ts` — Background reconciliation sweeps.

---

## 4. Files Changed
1. `src/features/payment/paymentServices.ts`
   - Refactored `createOrder(bookingId, customerId)` to implement the **Intent-First Durable Locking Pattern**.
   - Created the local `Payment` intent row in PostgreSQL (`status: PENDING`, `razorpay_order_id: null`) *before* issuing any external network calls to Razorpay.
   - Designated the winning insert transaction as the sole claimant responsible for calling Razorpay.
   - Handled losing contenders (PostgreSQL `P2002` unique conflict) via bounded asynchronous polling (`maxPollAttempts: 25`, interval: 100ms) against the canonical database record until `razorpay_order_id` is populated.
   - Ensured provider failures transition local intent to `FAILED` with failure telemetry (`quarantine_reason`), allowing subsequent client retries to atomically reclaim the intent via `updateMany`.
2. `tests/paymentOrderConcurrency.test.ts` (NEW)
   - Created a dedicated real PostgreSQL test suite executing 50 simultaneous concurrent requests against `createOrder`.
   - Verified that 50 concurrent requests produce **exactly 1 local payment intent** in PostgreSQL and **exactly 1 call to Razorpay**.
   - Verified all 50 callers resolve to the identical canonical provider order response.
   - Tested sequential retries, provider failure recovery, and cross-customer security boundaries.
3. `tests/paymentSecurity.test.ts`
   - Updated unit test mock fixtures and assertions to reflect the intent-first durable locking pattern.

---

## 5. Architectural Changes
```
                  Incoming Client Request
                             │
                             ▼
               Authenticate & Authorize User
                             │
                             ▼
         Derive Server-Side Authoritative Amount
                 (rate_per_day × 100 paise)
                             │
                             ▼
            Check Existing Local Payment Intent
             ┌───────────────┴───────────────┐
      [Found COMPLETED]                [Not Found / FAILED / In-Flight]
             │                                       │
     Return 409 Conflict                             ▼
                                   Attempt Atomic PostgreSQL INSERT
                                     (status: PENDING, order_id: null)
                                            ┌────────┴────────┐
                                     [Winner (Claimant)] [Loser (P2002 Contender)]
                                            │                 │
                                            │         Poll DB with Bounded Wait
                                            │         (25 attempts × 100ms)
                                            │                 │
                                            ▼                 ▼
                                    Call Razorpay API    Return Canonical
                                            │            Provider Order
                                   ┌────────┴────────┐
                               [Success]          [Failure]
                                   │                 │
                           UPDATE payment       UPDATE status: FAILED
                         (razorpay_order_id)    (quarantine_reason)
                                   │                 │
                                   ▼                 ▼
                            Return Canonical    Return 502 / Error
                             Payment Order
```

---

## 6. Database Changes
The existing schema already possesses the necessary business-level constraints:
- `booking_id String @unique` on `Payment` table.
- `idempotency_key String? @unique` on `Payment` table.
- `razorpay_order_id String? @unique` on `Payment` table.
- Nullable `razorpay_order_id` permitting the preliminary local payment intent to be durably inserted before provider order creation.

PostgreSQL `UNIQUE(booking_id)` acts as the distributed mutex across all backend processes/workers.

---

## 7. Concurrency Protection
1. **Canonical Mutex at Database Boundary**: When 50 concurrent requests target the same booking, all 50 attempt `prisma.payment.create`. PostgreSQL evaluates the unique constraint on `booking_id`: exactly 1 transaction succeeds and returns the created intent row (`isClaimant = true`). The other 49 receive a `P2002` constraint error.
2. **Contender Synchronization**: Losing contenders catch `P2002` and switch to polling the canonical row in PostgreSQL with exponential/bounded backoff. Once the claimant populates `razorpay_order_id`, all 49 contenders read and return the identical order.
3. **No Long-Lived Database Transactions**: The Razorpay HTTP call is performed outside any open database transactions, completely avoiding connection pool starvation.

---

## 8. Provider Idempotency & Failure Scenarios
- **Normal Success**: Intent created in DB -> Razorpay called -> `razorpay_order_id` updated -> canonical order returned.
- **Duplicate Sequential Request**: Read finds existing `PENDING` payment with `razorpay_order_id` -> returns existing order with 0 new provider calls.
- **50 Concurrent Requests**: 1 claimant calls Razorpay; 49 contenders poll PostgreSQL and resolve the identical order ID.
- **Provider Failure**: Claimant catches error -> marks local intent `status: FAILED` with `quarantine_reason` -> contenders time out or detect failure -> client receives 502 -> subsequent retry atomically claims `FAILED` record and retries Razorpay cleanly.
- **Provider Timeout / Partial Failure**: If Razorpay call times out or server crashes before update, the row remains in `PENDING` with `razorpay_order_id: null`. The payment reconciliation worker periodically queries Razorpay for unmatched receipts/bookings, binds the discovered order ID, or safely expires stale intents.
- **Amount & Currency Manipulation**: Amount is derived strictly from server-side `job_requirement.rate_per_day * 100`. Client-supplied amounts or currencies in request payloads are completely ignored.

---

## 9. Tests Added / Modified
1. `tests/paymentOrderConcurrency.test.ts` (Real PostgreSQL Concurrency):
   - `50 simultaneous requests produce EXACTLY 1 local payment intent and EXACTLY 1 provider call` (PASS)
   - `Sequential retry returns existing order with ZERO additional provider calls` (PASS)
   - `Failed provider call transitions local intent to FAILED and subsequent retry succeeds` (PASS)
   - `Customer B cannot create order for Customer A's booking (403)` (PASS)
   - `Order creation is rejected if booking is in non-payable state (409)` (PASS)
2. `tests/paymentSecurity.test.ts` (76/76 PASS)
3. `tests/paymentPricingAndLifecycle.test.ts` (PASS)
4. `tests/paymentWebhookConcurrency.test.ts` (PASS)
5. `tests/paymentWebhookFailClosed.test.ts` (PASS)
6. `tests/paymentWebhookAndReconciliation.test.ts` (PASS)
7. `tests/paymentReconciliationWorker.test.ts` (PASS)
8. `tests/paymentRefundsAndAuthorization.test.ts` (PASS)
9. `tests/paymentAbuseControls.test.ts` (PASS)
10. `tests/paymentOutboxIntegration.test.ts` (PASS)

---

## 10. Concurrency Test Evidence
```
PASS tests/paymentOrderConcurrency.test.ts (7.367 s)
  P3 Issue 5 — Payment Order Creation Real PostgreSQL Concurrency
    1. Real PostgreSQL 50-Request Concurrency Test
      ✓ 50 simultaneous requests produce EXACTLY 1 local payment intent and EXACTLY 1 provider call (2780 ms)
    2. Sequential Retries & Idempotency
      ✓ Sequential retry returns existing order with ZERO additional provider calls (963 ms)
    3. Provider Failure & Subsequent Retry Recovery
      ✓ Failed provider call transitions local intent to FAILED and subsequent retry succeeds (1526 ms)
    4. Security & Authorization Matrix
      ✓ Customer B cannot create order for Customer A's booking (403) (487 ms)
      ✓ Order creation is rejected if booking is in non-payable state (491 ms)

Test Suites: 1 passed, 1 total
Tests:       5 passed, 5 total
```

---

## 11. Command Execution Results
- `npm run migrate:status`: `Database schema is up to date!` (Exit code: 0)
- `npx jest tests/paymentOrderConcurrency.test.ts`: 5/5 PASSED (Exit code: 0)
- `npx jest <all 10 payment test suites>`: 121/121 PASSED (Exit code: 0)
- `npm run typecheck`: 0 errors (Exit code: 0)
- `npm run build`: 0 errors (Exit code: 0)

---

## 12. Final Verdict
**FIXED** — All invariants verified under real PostgreSQL concurrency, retries, provider failures, and regression test suites.
