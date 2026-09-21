# LabourBaba Backend — Unified Notification Architecture

## Overview
The LabourBaba notification subsystem implements the **Transactional Outbox Pattern** to ensure strict decoupling of business transactions from external push/WebSocket network side effects.

Direct, synchronous external notifications within business transactions are strictly prohibited.

---

## Architectural Data Flow

```
[ HTTP Client Request ]
           │
           ▼
[ Domain / Business Service ]
           │
           ▼ (Prisma Transaction)
┌────────────────────────────────────────────────────────┐
│ 1. Mutate Business Records (Booking, Job, Payment)     │
│ 2. Insert Mandatory Audit Log (`audit_log`)             │
│ 3. Insert Outbox Event (`notification_outbox`)          │
└────────────────────────────────────────────────────────┘
           │ (Transaction Committed to PostgreSQL)
           ▼
[ Outbox Poller / Worker Process ]
           │
           ▼ (SELECT ... FOR UPDATE SKIP LOCKED)
┌────────────────────────────────────────────────────────┐
│ Claim PENDING rows -> Mark PROCESSING with lease time  │
│ Dispatch Job to BullMQ `notification-queue`            │
└────────────────────────────────────────────────────────┘
           │
           ▼
[ BullMQ Notification Worker ]
           │
     ┌─────┴─────────────────────────┐
     ▼                               ▼
[ FCM Push Delivery ]       [ Socket.IO Realtime Gateway ]
  - Queries `worker_device`     - Emits to room `booking:<id>`
  - Handles token rotation       - Emits to room `user:<id>`
  - Auto-revokes invalid tokens
```

---

## Invariants & Guarantees
1. **Zero Phantom Notifications**: An outbox record only exists if the underlying business transaction successfully committed.
2. **Crash Resilience**: If a worker crashes while processing an outbox row, the lease expires and a subsequent worker safely re-claims the event.
3. **Multi-Device Fanout**: Push notifications target all active devices in `WorkerDevice` registered to the worker.
4. **Invalid Token Cleanup**: Unregistered FCM tokens returned by Firebase Admin SDK automatically revoke the corresponding `WorkerDevice` record.
