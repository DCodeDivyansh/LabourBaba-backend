# P3 Issue 6 Remediation: Protect Booking and Payment Resources

**Priority:** P0/P1  
**Category:** Security / Privacy / Authorization  
**Relevant Audit Findings:** Audit #16 & #20  
**Roadmap Issue:** Issue 6 — Protect booking and payment resources  
**Status:** **FIXED**

---

## 1. Executive Summary

In a multi-sided marketplace platform (LabourBaba), booking and payment entities contain confidential business, personally identifiable (PII), and financial data—including customer identity, assigned worker identity, OTP secrets, monetary transaction amounts, payment states, and external provider references.

Prior to this remediation, booking detail queries in `bookingServices.ts` and payment queries in `paymentServices.ts` relied on querying resources directly by client-supplied UUIDs before checking authorization or fallback querying unowned rows. This anti-pattern ("fetch-first-authorize-later") created IDOR/BOLA exposure risks and timing/enumeration oracles.

This remediation enforces **relationship-based access control with query predicate pushdown** at the database layer across all booking, payment, and job endpoints, guarantees response DTO sanitization (including complete redaction of financial/payment data for workers), and proves these invariants with both unit and real PostgreSQL integration tests.

---

## 2. Security Invariants & Authorization Model

```
       Authenticated Principal (req.user)
                       |
                       v
         Role Authorization (Middleware)
                       |
                       v
      Relationship-Based Authorization Policy
                       |
                       v
 Database Pushdown Predicate (WHERE id = ? AND customer_id = ?)
                       |
                       v
      DTO-Safe Response (Sensitive fields redacted)
```

### Access Control Matrix

| Resource / Action | Route / Service | Customer Access | Worker Access | Admin Access | Database Scoping Filter |
|---|---|---|---|---|---|
| **Booking Detail** | `GET /api/bookings/:id` | Own bookings only (`customer_id = req.user.id`) | Legitimately assigned bookings only (`worker_id = req.user.id`) | Full administrative access | `{ id: bookingId, customer_id: actor.id }` / `{ id: bookingId, worker_id: actor.id }` |
| **Payment Status** | `GET /api/payments/:id` or `GET /api/bookings/:id/payment` | Own booking payments only (`booking: { customer_id: actor.id }`) | **DENIED (403)** — Payment data completely inaccessible | Explicit policy permitted | `{ booking_id: id, booking: { customer_id: actor.id } }` |
| **Payment Creation** | `POST /api/payments/:id/create-order` | Own booking only; authoritative server-derived pricing | **DENIED (403)** | **DENIED (403)** | `{ id: bookingId, customer_id: actor.id }` |
| **Payment Refund** | `POST /api/payments/:id/refund` | Own booking in refundable lifecycle state | **DENIED (403)** | Explicit policy permitted | Scoped `findFirst` + `paymentPolicy.canRefund` |
| **OTP Verification** | `POST /api/bookings/:id/otp/verify` | **DENIED (403)** | Assigned worker only (`worker_id = actor.id`) | Explicit policy permitted | `SELECT ... WHERE id = $1 AND worker_id = $2 FOR UPDATE` |
| **Complete Booking** | `POST /api/bookings/:id/complete` | **DENIED (403)** | Assigned worker only (`worker_id = actor.id`) | Explicit policy permitted | `{ id: bookingId, worker_id: actor.id }` |
| **Confirm Completion** | `POST /api/bookings/:id/confirm-complete` | Owning customer only (`customer_id = actor.id`) | **DENIED (403)** | Explicit policy permitted | `{ id: bookingId, customer_id: actor.id }` |
| **Cancel Booking** | `POST /api/bookings/:id/cancel` | Owning customer only | Assigned worker only | Explicit policy permitted | `SELECT ... WHERE id = $1 AND (customer_id = $2 OR worker_id = $2) FOR UPDATE` |
| **Track Worker Location** | `GET /api/bookings/:id/location` | Owning customer only | **DENIED (403)** | Explicit policy permitted | `{ id: bookingId, customer_id: actor.id }` |

---

## 3. Detailed Root Causes & Remediations

### 3.1 Pushdown Query Scoping (Eliminating "Fetch-First-Authorize-Later")
* **Original Vulnerability:** `bookingService.getBookingDetail` and mutation functions fetched records by `id` directly without ownership predicates, and subsequently attempted authorization checks in memory.
* **Remediation:** Pushed authorization predicates directly into SQL/Prisma `where` clauses via `bookingPolicy.scopeRead(actor, bookingId)` and `paymentPolicy.scopeRead(actor, bookingId)`. Unowned records are never fetched from disk for the requesting actor.

### 3.2 Worker Financial Data Redaction
* **Original Vulnerability:** Direct payment endpoints and booking detail responses could leak financial transaction metadata (amounts, provider transaction IDs, order receipts) to workers.
* **Remediation:**
  1. `getPaymentStatus` and `refundPayment` explicitly reject requests from `UserRole.WORKER` with `403 Forbidden`.
  2. `bookingService.getBookingDetail` excludes the `payment` relation from the Prisma select clause for workers (`payment: isWorker ? false : { select: paymentSafeSelect }`).
  3. `toBookingDTO(b, actor)` enforces that `payment` is strictly `undefined` whenever `actor.role === UserRole.WORKER`.

### 3.3 State-Changing Mutations & Concurrency
* **Row-level locking (`FOR UPDATE`):** In `verifyOtp` and `cancelBooking`, raw SQL row locks are parameterized with actor ownership constraints (`AND worker_id = $2::uuid` or `AND (customer_id = $2::uuid OR worker_id = $2::uuid)`), preventing concurrent race mutations from crossing user boundaries.
* **Transactional State Machines:** Transitions in `bookingStateService` and `paymentServices` enforce valid state transitions atomically.

### 3.4 DTO Safety & Field Allowlisting
* Response payloads are strictly shaped by `toBookingDTO`, `toWorkerLocationDTO`, `toJobDTO`, and `toJobRequirementDTO`. Sensitive internal fields (e.g. `otp_hash`, `password_hash`, `device_token`, provider secrets) are never included in DTO output interfaces.

---

## 4. Files Modified & Added

1. **[src/features/booking/bookingServices.ts](file:///e:/LabourBaba/LabourBaba-backend/src/features/booking/bookingServices.ts)**
   - Replaced un-scoped queries with pushdown `bookingPolicy.scopeRead`.
   - Updated `verifyOtp`, `completeBooking`, `confirmComplete`, `cancelBooking`, and `getWorkerLocation` to enforce strict ownership predicates.
   - Enforced worker payment exclusion at database select and DTO generation stages.
2. **[src/features/payment/paymentServices.ts](file:///e:/LabourBaba/LabourBaba-backend/src/features/payment/paymentServices.ts)**
   - Hardened `getPaymentStatus` and `refundPayment` with `paymentPolicy.scopeRead` pushdown and explicit worker rejection (`403 Forbidden`).
3. **[src/features/jobs/job.services.ts](file:///e:/LabourBaba/LabourBaba-backend/src/features/jobs/job.services.ts)**
   - Hardened `getJobDetail`, `getJobRequirements`, and `getJobBookings` with `jobPolicy.scopeRead` pushdown queries.
4. **[src/features/jobs/jobReqServices.ts](file:///e:/LabourBaba/LabourBaba-backend/src/features/jobs/jobReqServices.ts)**
   - Hardened `getRequirementDetail` with `requirementPolicy.scopeRead` pushdown queries.
5. **[tests/bookingAndPaymentResourceProtectionReal.test.ts](file:///e:/LabourBaba/LabourBaba-backend/tests/bookingAndPaymentResourceProtectionReal.test.ts)** (NEW)
   - Comprehensive real PostgreSQL integration test suite testing Customer A/B isolation, Worker A/B isolation, Admin access, mutation boundaries, and UUID tampering.

---

## 5. Verification & Test Evidence

### 5.1 Real PostgreSQL Integration Tests
Test suite: `tests/bookingAndPaymentResourceProtectionReal.test.ts`
- Customer A reads own booking -> **PASSED (200 with DTO)**
- Customer A reading Customer B booking -> **PASSED (404/403 Denied)**
- Customer B reading Customer A booking -> **PASSED (404/403 Denied)**
- Customer A reads own payment status -> **PASSED (200 with DTO)**
- Customer A reading Customer B payment status -> **PASSED (404/403 Denied)**
- Customer B reading Customer A payment status -> **PASSED (404/403 Denied)**
- Assigned Worker A reads assigned booking -> **PASSED (200 with payment strictly redacted)**
- Unrelated Worker B reading Booking A -> **PASSED (404/403 Denied)**
- Worker A attempting payment status -> **PASSED (403 Forbidden)**
- Worker A attempting refund -> **PASSED (403 Forbidden)**
- Admin reads Booking A & Booking B -> **PASSED (200 Authorized)**
- Admin reads Payment A & Payment B -> **PASSED (200 Authorized)**
- Worker B verifying OTP on Booking A -> **PASSED (403/404 Denied)**
- Worker B completing Booking A -> **PASSED (403/404 Denied)**
- Customer B confirming completion on Booking A -> **PASSED (403/404 Denied)**
- Customer B cancelling Booking A -> **PASSED (403/404 Denied)**
- Customer B tracking worker location on Booking A -> **PASSED (403/404 Denied)**
- Customer A tracking worker location on own Booking A -> **PASSED (200 Authorized)**
- Non-existent / tampered UUID queries -> **PASSED (404 Cleanly returned)**

### 5.2 Test Execution Results Summary
```
Test Suites: 5 passed, 5 total
Tests:       182 passed, 182 total
- tests/bookingAndPaymentResourceProtectionReal.test.ts: 23 passed
- tests/bookingPaymentSecurity.test.ts: 24 passed
- tests/paymentSecurity.test.ts: 76 passed
- tests/crossResourceSecurity.test.ts: 26 passed
- tests/jobDetailRequirementSecurity.test.ts: 33 passed

TypeScript Check (`npm run typecheck`): PASSED (0 errors)
Production Build (`npm run build`): PASSED
```
