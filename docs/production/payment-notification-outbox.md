# Payment Notification Outbox (Issue 71)

## Purpose & Architecture
In the LabourBaba backend, financial transactions must never be coupled to external delivery systems (such as Firebase Cloud Messaging or Socket.IO). A failure in sending a notification must never cause a rollback of a captured payment or completed refund, nor should notification delivery happen before the database commit of the financial state transition.

To satisfy this requirement:
1. **Transactional Dual-Write**: Every payment state transition (`PAYMENT_COMPLETED`, `PAYMENT_FAILED`, `REFUND_COMPLETED`, `REFUND_FAILED`) writes both the domain record mutation (e.g. `Payment`, `PaymentRefund`, `Booking`) and a corresponding row in `notification_outbox` inside the exact same atomic `prisma.$transaction` block.
2. **Asynchronous Outbox Dispatch**: The durable `outboxWorker` continuously claims `PENDING` outbox events, delivers them via multi-channel notification adapters (FCM + Socket.IO), and marks them `DELIVERED`.
3. **Resilient Retry**: If push or websocket delivery experiences transient network failures, exponential backoff is applied up to `maxAttempts: 5`. The financial state in PostgreSQL remains permanently committed and valid.

```
Payment Event (Webhook/Capture/Refund)
                │
                ▼
      ┌────────────────────┐
      │  prisma.$transaction│
      │  - Update Payment   │
      │  - Update Booking   │
      │  - Insert Outbox    │
      └────────────────────┘
                │ COMMIT
                ▼
        [notification_outbox]
                │
                ▼
         outboxWorker
          ├── FCM Push
          └── Socket.IO
```

## Supported Payment Notification Event Types
- `PAYMENT_COMPLETED`: Emitted when an order payment is successfully authorized/captured. Sent to customer (receipt) and assigned worker (payout notification).
- `PAYMENT_FAILED`: Emitted when an authorization fails or webhook reports `payment.failed`. Sent to customer with actionable retry instructions.
- `REFUND_COMPLETED`: Emitted when a refund transition finishes via provider or internal cancellation. Sent to customer with refund reference.
- `REFUND_FAILED`: Emitted when a refund transition encounters an error.

## Idempotency & Duplicate Prevention
- **Aggregate Keying**: Each outbox record specifies `aggregateType: 'PAYMENT'` and `aggregateId: payment.id` with `recipientType` and `recipientId`.
- **Deduplication**: Re-delivered webhooks or duplicate refund attempts do not create duplicate outbox entries because the payment state machine checks existing transitions and exits early if the target state is already reached.

## Security & Payload Minimization
- Outbox payloads contain only high-level identifiers (`paymentId`, `bookingId`, `amount`, `currency`, `providerPaymentId`).
- Provider secrets, signatures, raw payment headers, and auth tokens are strictly omitted from the outbox table.
