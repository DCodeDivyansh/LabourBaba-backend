# Issue 6 — Protect Booking and Payment Resources

## 1. Status
**RESOLVED**

- **Priority:** P0/P1
- **Category:** Security / Privacy / IDOR
- **Original Audit Mapping:** Audit Findings #16, #20

---

## 2. Executive Summary & Original Audit Findings

Audit Findings #16 and #20 uncovered severe security and privacy gaps regarding booking and payment data in LabourBaba Backend:
1. **Unscoped Payment Inspection (Audit Finding #16):** An authenticated principal could inspect payment records simply by presenting a `booking_id` or `payment_id`, regardless of whether they owned or were legitimately involved in the booking.
2. **Worker Payment Data Leakage (Audit Finding #20):** Assigned workers retrieved customer payment details (amounts, Razorpay order IDs, payment statuses, and transaction metadata) when fetching booking details, violating least-privilege and privacy compliance.
3. **IDOR on Booking Lifecycle Operations:** Booking lifecycle transitions (OTP verification, completion confirmation, worker location streaming) lacked query-scoped pushdown and strict relationship enforcement.
4. **UUID Secrecy as an Authorization Fallback:** Several services retrieved records by raw primary key (`findUnique({ where: { id } })`) and only evaluated permissions post-fetch in application code, risking information leakage and side-channel enumeration.
5. **Express Parameter Bypass:** Routes accepted unvalidated route parameters directly to Prisma, resulting in unhandled database exceptions on malformed identifiers.

---

## 3. Core Security Invariant

> **Non-Negotiable Security Invariant:**
> An authenticated principal may access booking/payment data or execute booking lifecycle actions **only** when explicitly authorized by an established, legitimate business relationship.
> 
> Possession of a booking UUID, payment UUID, order ID, or transaction identifier must **never** be sufficient to read, mutate, or infer the existence of a resource.
> Furthermore, **workers must never receive customer payment data under any circumstance**.

---

## 4. Threat Model & Abuse Scenarios

| Scenario | Threat Description | Pre-Remediation Behavior | Post-Remediation Defense |
|---|---|---|---|
| **Cross-Customer IDOR** | Customer B guesses or intercepts Customer A's `booking_id`. | Returned 200 OK with Customer A's booking and payment details. | `bookingPolicy.scopeRead` filters out booking at SQL level; endpoint returns `404 Not Found`. |
| **Worker Payment Leakage** | Worker A fetches assigned booking details via `GET /api/bookings/:bookingId`. | Response JSON included full `payment` object (amounts, transaction IDs). | `payment: false` Prisma select projection for workers; `toBookingDTO(b, actor)` strips `payment: undefined`. |
| **Worker Direct Payment Access** | Worker A requests `GET /api/payments/:bookingId` or `GET /api/bookings/:bookingId/payment`. | Worker received payment status and gateway order information. | Route rejects with `403 Forbidden` (`requireRole(CUSTOMER, ADMIN)`). |
| **Unassigned Worker Probing** | Worker B probes Worker A's assigned booking. | Possible enumeration of customer contact details and address. | Query-level filter `worker_id: actor.id` yields `null`; endpoint returns `404 Not Found`. |
| **Unauthorized Lifecycle Mutation** | Customer A tries to verify OTP, or Worker A tries to confirm completion. | Controller lacked explicit role/relationship checks. | Worker-only OTP verification enforced by `bookingPolicy.canVerifyOtp`; Customer-only completion confirmed by `bookingPolicy.canConfirmComplete`. |
| **Malformed UUID DoS** | Attacker passes arbitrary strings (e.g. `../`, SQL fragments, random hex). | Express passed raw strings to Prisma, throwing unhandled internal errors. | `validateParams(BookingIdParamSchema)` returns `400 Bad Request` prior to invoking database. |

---

## 5. Canonical Authorization Model

```
                    ┌───────────────────────────────┐
                    │     Incoming HTTP Request     │
                    └───────────────┬───────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────────┐
                    │  validateParams / Body (Zod)  │  ──> 400 Bad Request
                    └───────────────┬───────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────────┐
                    │      authenticateJWT          │  ──> 401 Unauthorized
                    └───────────────┬───────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────────┐
                    │  requireRole(allowedRoles)    │  ──> 403 Forbidden
                    └───────────────┬───────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────────┐
                    │   Service Query Pushdown      │
                    │  (bookingPolicy.scopeRead /   │
                    │   paymentPolicy.scopeRead)    │
                    └───────────────┬───────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────────┐
                    │ Prisma Query with Predicates  │
                    │  CUSTOMER: customer_id = user │
                    │  WORKER:   worker_id = user   │
                    │  ADMIN:    unrestricted       │
                    └───────────────┬───────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
              [Record Found]                 [Record Not Found]
                    │                               │
                    ▼                               ▼
       Assert Policy (`canRead`)             Throw 404 (IDOR-safe)
                    │
                    ▼
       Map via DTO Allowlist
       - If WORKER: payment stripped
                    │
                    ▼
             200 OK JSON
```

### 5.1 Role-Specific Capabilities

#### 1. Customer (`UserRole.CUSTOMER`)
- **Booking Read:** May access bookings where `booking.customer_id === user.id`.
- **Payment Read:** May access payment details for own bookings.
- **Worker Location:** May stream/poll worker location for own active bookings (`bookingPolicy.canGetWorkerLocation`).
- **Completion Confirmation:** May confirm completion for own bookings (`bookingPolicy.canConfirmComplete`).
- **Cancellation:** May cancel own bookings prior to fulfillment.

#### 2. Worker (`UserRole.WORKER`)
- **Booking Read:** May access bookings where `booking.worker_id === user.id`.
- **Payment Read:** **STRICTLY PROHIBITED.** Worker views never contain payment details. Access to payment endpoints is rejected at both routing and policy layers.
- **OTP Verification:** May verify booking arrival/start OTP for assigned bookings (`bookingPolicy.canVerifyOtp`).
- **Completion Initiation:** May trigger completion request for assigned bookings (`bookingPolicy.canCompleteBooking`).

#### 3. Platform Admin (`UserRole.ADMIN`)
- Unrestricted operational visibility across all customer bookings, worker assignments, and payment statuses for compliance, mediation, and support.

---

## 6. Strict Payment Data Minimization for Workers

Workers require operational job information (location, task description, customer phone number upon arrival), but have no legitimate need to see:
- Payment order IDs (`razorpay_order_id`, `razorpay_payment_id`)
- Gateway signature data
- Platform commission breakdown or total customer charge
- Payment timestamps or gateway statuses

This is enforced across three defensive layers:

1. **Database Query Projection Suppression:**
   In `getBookingDetail`:
   ```typescript
   const isWorker = actor.role === UserRole.WORKER;
   const booking = await prisma.booking.findFirst({
     where: whereClause,
     select: {
       ...bookingDetailSafeSelect,
       payment: isWorker ? false : { select: paymentSafeSelect },
     },
   });
   ```

2. **DTO Mapper Boundary:**
   In `toBookingDTO`:
   ```typescript
   const isWorker =
     typeof actor === "object" &&
     actor !== null &&
     String(actor.role).toLowerCase() === "worker";

   return {
     ...
     payment: isWorker || !b.payment ? undefined : toPaymentDTO(b.payment),
   };
   ```

3. **HTTP Route Authorization:**
   Routes `/api/payments/:bookingId` and `/api/bookings/:bookingId/payment` require:
   ```typescript
   requireRole(UserRole.CUSTOMER, UserRole.ADMIN)
   ```
   Workers attempting to access these routes are rejected with `403 Forbidden` before reaching the controller.

---

## 7. Endpoint Architecture & Route Catalog

| Method | Path | Middleware Pipeline | Policy Method | Authorized Roles |
|---|---|---|---|---|
| `GET` | `/api/bookings/:bookingId` | `authenticateJWT`, `validateParams(BookingIdParamSchema)` | `bookingPolicy.scopeRead`, `bookingPolicy.canRead` | Customer, Worker, Admin |
| `GET` | `/api/bookings/:bookingId/payment` | `authenticateJWT`, `requireRole(CUSTOMER, ADMIN)`, `validateParams(BookingIdParamSchema)` | `paymentPolicy.scopeRead`, `paymentPolicy.canRead` | Customer, Admin |
| `GET` | `/api/payments/:bookingId` | `authenticateJWT`, `requireRole(CUSTOMER, ADMIN)`, `validateParams(BookingIdParamSchema)` | `paymentPolicy.scopeRead`, `paymentPolicy.canRead` | Customer, Admin |
| `POST` | `/api/payments/:bookingId/refund` | `authenticateJWT`, `requireRole(CUSTOMER, ADMIN)`, `validateParams(BookingIdParamSchema)` | `paymentPolicy.scopeRead`, `paymentPolicy.canRefund` | Customer, Admin |
| `POST` | `/api/bookings/:bookingId/otp/verify` | `authenticateJWT`, `requireRole(WORKER, ADMIN)`, `validateParams(BookingIdParamSchema)`, `validateBody(VerifyBookingOtpReqSchema)` | `bookingPolicy.canVerifyOtp` | Worker, Admin |
| `POST` | `/api/bookings/:bookingId/complete` | `authenticateJWT`, `requireRole(WORKER, ADMIN)`, `validateParams(BookingIdParamSchema)` | `bookingPolicy.canCompleteBooking` | Worker, Admin |
| `POST` | `/api/bookings/:bookingId/confirm-complete` | `authenticateJWT`, `requireRole(CUSTOMER, ADMIN)`, `validateParams(BookingIdParamSchema)` | `bookingPolicy.canConfirmComplete` | Customer, Admin |
| `POST` | `/api/bookings/:bookingId/cancel` | `authenticateJWT`, `validateParams(BookingIdParamSchema)` | `bookingPolicy.canCancel` | Customer, Worker, Admin |
| `GET` | `/api/bookings/:bookingId/location` | `authenticateJWT`, `validateParams(BookingIdParamSchema)` | `bookingPolicy.canGetWorkerLocation` | Customer, Admin |

---

## 8. Related Access Paths Hardened

Beyond standard REST endpoints, all peripheral pathways exposing booking or payment context were hardened:

1. **Job Booking Rosters (`GET /api/jobs/:jobId/bookings`):**
   When invoking `toBookingDTO(b, actor)`, the authenticated caller's identity is passed, ensuring workers inspecting their own booking in a job list cannot see payment data.
2. **WebSocket Booking Rooms (`join:booking`):**
   In `src/socket/socketHandlers.ts`, the room join event enforces query-level scoping:
   ```typescript
   const booking = await prisma.booking.findFirst({
     where: {
       id: bookingId,
       ...(user.role === UserRole.CUSTOMER ? { customer_id: user.id } : {}),
       ...(user.role === UserRole.WORKER ? { worker_id: user.id } : {}),
     },
   });
   ```
   Unauthorized users are rejected with `403 Forbidden` and disconnected from the room.
3. **In-Booking Chat (`chatServices.ts`):**
   `getMessages` and `sendMessage` verify customer or worker relationship before reading or appending messages.

---

## 9. Verification & Test Suite

The test suite in `tests/bookingPaymentSecurity.test.ts` provides comprehensive, automated regression coverage:

```
PASS tests/bookingPaymentSecurity.test.ts
  Issue #6 — Protect Booking and Payment Resources
    1. GET /api/bookings/:bookingId (Booking Detail)
      √ Customer A CAN retrieve own booking (200 with payment data)
      √ Customer B CANNOT retrieve Customer A's booking (404 IDOR protection)
      √ Worker A (assigned) CAN retrieve booking detail but NEVER receives payment data
      √ Worker B (unrelated worker) CANNOT retrieve Worker A's booking (404 IDOR protection)
      √ Platform Admin CAN retrieve any booking detail
      √ Malformed bookingId returns 400 Bad Request without calling database
      √ Unauthenticated request returns 401 Unauthorized
    2. Payment Status Access Controls
      √ Customer A CAN get payment status via GET /api/payments/:bookingId
      √ Customer A CAN get payment status via canonical GET /api/bookings/:bookingId/payment
      √ Customer B CANNOT access Customer A's payment status (403/404 denied)
      √ Worker A is FORBIDDEN from accessing /api/payments/:bookingId (403)
      √ Worker A is FORBIDDEN from accessing /api/bookings/:bookingId/payment (403)
      √ Platform Admin CAN get payment status via both endpoints
      √ Malformed bookingId on payment route returns 400 Bad Request
    3. Booking Lifecycle Mutations
      √ Worker A CAN verify OTP for assigned booking
      √ Worker B CANNOT verify OTP for Worker A's booking (403/404 denied)
      √ Invalid OTP format (not 6 digits) returns 400 Bad Request
      √ Customer A CAN confirm complete for own booking
      √ Customer B CANNOT confirm complete for Customer A's booking (403/404 denied)
      √ Customer A CAN get worker location for own booking
      √ Customer B CANNOT get worker location for Customer A's booking (403/404)
    4. Service-Layer Direct Authorization Invariants
      √ bookingService.getBookingDetail throws 401 when actor is missing
      √ bookingService.getWorkerLocation throws 401 when actor is missing
      √ bookingService.getBookingDetail strips payment for worker role

Test Suites: 1 passed, 1 total
Tests:       24 passed, 24 total
```

---

## 10. Conclusion & Compliance Invariant

Issue #6 is fully remediated. All booking and payment access paths strictly enforce relationship-based query pushdown, least privilege, parameter validation, and DTO boundary preservation. Data leakage between customers, unrelated workers, and assigned workers is prevented at the database, service, controller, and DTO layers.
