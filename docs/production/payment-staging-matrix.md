# Payment Staging Test Matrix (Issue 73)

## Overview
To guarantee production release readiness, all 20 required payment lifecycle, edge-case, concurrency, and failure scenarios are tested against both mock provider adapters and real staging configurations.

## Scenario Matrix & Results

| Scenario ID | Scenario Name | Trigger / Input | Expected Final State | Audit & Outbox Result | Test Result |
|---|---|---|---|---|---|
| **PS-01** | Create payment order | Valid booking + amount | `Payment.status = PENDING`, `orderId` generated | Audit event logged | **PASS** |
| **PS-02** | Successful capture | `payment.captured` webhook | `Payment.status = COMPLETED`, `Booking.paymentStatus = PAID` | `PAYMENT_COMPLETED` outbox created | **PASS** |
| **PS-03** | Failed payment | `payment.failed` webhook | `Payment.status = FAILED`, `Booking.paymentStatus = FAILED` | `PAYMENT_FAILED` outbox created | **PASS** |
| **PS-04** | Delayed webhook | Webhook arriving post-client polling | Idempotent transition to `COMPLETED` | No duplicate outbox | **PASS** |
| **PS-05** | Duplicate webhook | Re-delivery of same `event.id` | HTTP 200 returned, ignored | DB unique constraint enforced | **PASS** |
| **PS-06** | Invalid signature | Tampered `x-razorpay-signature` | HTTP 400 Bad Request | Security warning logged | **PASS** |
| **PS-07** | Tampered payload | Body modified after signature | HTTP 400 Bad Request | Signature mismatch captured | **PASS** |
| **PS-08** | Amount mismatch | Webhook amount != local amount | Payment quarantined (`QUARANTINED`), manual review | Security anomaly emitted | **PASS** |
| **PS-09** | Currency mismatch | Non-INR webhook currency | Quarantined / rejected | Metric incremented | **PASS** |
| **PS-10** | Provider timeout (Order) | 504 Gateway Timeout on Razorpay | HTTP 502/504 returned, booking remains pending | No dirty state | **PASS** |
| **PS-11** | Provider timeout (Verify) | Timeout during manual verify | Handled gracefully, pending reconciliation | Reconciler resolves later | **PASS** |
| **PS-12** | Refund execution | Customer cancellation | `Payment.status = REFUNDED`, `PaymentRefund.status = COMPLETED` | `REFUND_COMPLETED` outbox emitted | **PASS** |
| **PS-13** | Duplicate refund | Second refund request | HTTP 409 Conflict / rejected | No double refund | **PASS** |
| **PS-14** | Refund provider failure | Razorpay refund API returns 500 | `PaymentRefund.status = FAILED` | Outbox failure recorded | **PASS** |
| **PS-15** | Refund delayed outcome | Asynchronous webhook update | `refund.processed` updates DB state | Asynchronous update verified | **PASS** |
| **PS-16** | Stale pending reconciliation | Payment in `PENDING` > 15m | `paymentReconciliationWorker` auto-captures or fails | Reconciled audit event | **PASS** |
| **PS-17** | Notification failure | FCM/Socket.IO unreachable | Payment remains `COMPLETED` | Outbox event retries | **PASS** |
| **PS-18** | Notification retry | Outbox retry attempt | Outbox marked `DELIVERED` on success | No rollback of payment | **PASS** |
| **PS-19** | Process crash in pending | SIGTERM during pending state | Reconciler claims on reboot | Zero lost payments | **PASS** |
| **PS-20** | Webhook during restart | Webhook delivered during API boot | Worker/DB recovers transactionally | Idempotency intact | **PASS** |

## Automated Test Suite
- Automated test implementation located at `tests/paymentStagingMatrix.test.ts`.
- All 20 scenarios validated under concurrent in-band execution.
