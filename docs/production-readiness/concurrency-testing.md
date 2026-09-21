# LabourBaba Backend — Concurrency Testing & Invariant Proofs

## Overview
To guarantee data integrity under high contention and distributed deployments, LabourBaba maintains real PostgreSQL and Redis concurrency test suites.

---

## Concurrency Test Suites & Results

### 1. Dispatch & Overbooking Concurrency (`tests/dispatchConcurrency.test.ts`)
- **Scenario**: 10 workers concurrently accept a 2-slot Job Requirement.
- **Invariant Verified**:
  - Exactly 2 bookings created (`status = 'CONFIRMED'`).
  - Remaining 8 workers receive `409 Conflict` or `410 Gone`.
  - Final requirement status is `FILLED`.

### 2. Payment Order Deduplication (`tests/paymentOrderConcurrency.test.ts`)
- **Scenario**: 50 concurrent payment creation requests for the same booking.
- **Invariant Verified**:
  - Exactly 1 Razorpay order created.
  - Exactly 1 local `payment` record stored.
  - All 50 concurrent requests resolve to the identical `razorpay_order_id`.

### 3. Refund Race Protection (`tests/refundConcurrency.test.ts`)
- **Scenario**: Concurrent refund requests against a completed payment.
- **Invariant Verified**:
  - Atomic conditional update grants ownership to exactly 1 request.
  - Exactly 1 external refund issued to Razorpay.
  - Second request returns 409 Conflict.

### 4. Distributed Outbox Claiming (`tests/outboxDistributedConcurrency.test.ts`)
- **Scenario**: 5 parallel worker loops claiming the same batch of 20 pending outbox events.
- **Invariant Verified**:
  - Zero duplicate message deliveries.
  - `FOR UPDATE SKIP LOCKED` guarantees non-overlapping claims.
