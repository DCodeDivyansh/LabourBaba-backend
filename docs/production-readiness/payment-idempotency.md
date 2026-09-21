# LabourBaba Backend — Payment Idempotency & Concurrency Guide

## Overview
Payment operations in LabourBaba are distributed operations interacting with external payment gateways (Razorpay). 

To prevent financial loss, double billing, or inconsistent state under network retries and concurrency, the payment subsystem implements strict idempotency protocols.

---

## 1. Payment Order Creation Protocol

```
Client -> POST /api/payments/order
             │
             ▼
1. Derive Deterministic Idempotency Key: `payment_intent:booking:<booking_id>`
2. Acquire Redis/PostgreSQL Intent Lock:
   - Check if an active `payment` record exists for `booking_id`.
   - If `PENDING` payment exists with valid `razorpay_order_id`, return existing order.
3. If new, create local `payment` record with status `PENDING` inside a transaction.
4. Call Razorpay API (`orders.create`) with idempotency headers.
5. Update local record with `razorpay_order_id`.
6. Release lock & return order details to client.
```

---

## 2. Webhook Ingestion & Signature Verification

- **Fail-Closed Verification**: The raw request body buffer is verified against `RAZORPAY_WEBHOOK_SECRET` using HMAC SHA-256 before any JSON parsing or database mutation.
- **Idempotency Key**: `webhook:razorpay:<event_id>` stored in `webhook_event` table with a unique constraint.
- **Duplicate Handling**: Duplicate deliveries are acknowledged with 200 OK immediately without re-executing state transitions.
- **Amount & Currency Reconciliation**:
  - `captured_amount` must match expected `booking.total_price * 100` (paise).
  - `currency` must strictly match `INR`.
  - Any discrepancy transitions the payment to `QUARANTINED` and triggers an urgent administrator audit event.

---

## 3. Atomic Refund Claiming

Two concurrent refund requests (e.g. customer clicking twice or admin retry) must never result in duplicate provider refunds.

```
UPDATE payment
SET status = 'REFUND_PENDING', updated_at = NOW()
WHERE id = $paymentId AND status = 'COMPLETED';
```
- Only if `affected_rows == 1`, the worker executes `razorpay.payments.refund()`.
- On success: transitions to `REFUNDED` and writes to `notification_outbox`.
- On failure: transitions to `REFUND_FAILED` for administrator review.
