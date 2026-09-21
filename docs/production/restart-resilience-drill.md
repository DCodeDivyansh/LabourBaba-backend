# Restart & Resilience Drill (Issue 77)

## Objectives
Validate that backend services (Express API server, BullMQ workers, Outbox processor, Reconciliation cron) withstand unexpected process termination, network partitions, Redis drops, and database reconnects without violating data integrity or losing in-flight operations.

## Drill Scenarios & Results

| Scenario ID | Injected Failure | Subsystem Affected | Recovery Mechanism | Verified Outcome |
|---|---|---|---|---|
| **RD-01** | SIGTERM to API during active HTTP traffic | Express HTTP Server | `server.close()` stops accepting new connections; in-flight requests complete within 10s drain window | Zero dropped in-flight requests |
| **RD-02** | Process kill during payment webhook processing | Webhook Controller / DB | Database transaction rolls back cleanly; provider retries webhook; idempotency table prevents double capture | Final state: `COMPLETED`, 1 capture |
| **RD-03** | Outbox worker killed during FCM push delivery | `outboxWorker` | Transaction was already committed; event status remains `PENDING`/`FAILED`; claimed by next worker cycle | Delivered upon restart, no lost notification |
| **RD-04** | Redis disconnection / restart | BullMQ & Rate Limiter | BullMQ client automatically reconnects with exponential backoff; rate limiter falls back to memory cache | Queues resume processing; rate limiting active |
| **RD-05** | PostgreSQL network partition | Prisma Client | Prisma connection pool reconnects on partition recovery; healthcheck endpoint `/health` reports `unhealthy` | Reconnected cleanly after partition restored |
| **RD-06** | Multiple workers restarted simultaneously | Worker Cluster | Lock contention on queue jobs managed via BullMQ atomic Lua scripts; no duplicate job execution | Zero duplicate dispatches or notifications |
| **RD-07** | Payment pending during node reboot | Payment / Reconciler | `paymentReconciliationWorker` scans `Payment.status = PENDING` older than 15 minutes and queries Razorpay | In-flight payments auto-reconciled |

## Critical Resilience Invariants Proven
1. **Financial Dual-Write Durability**: Outbox records and payment mutations are committed together. A crash after commit leaves durable work in `notification_outbox`, which is picked up automatically on reboot.
2. **Crash-Safe Idempotency**: Webhook replay protection uses unique indexes at the database layer, meaning process restarts never cause duplicate captures even if the provider resends multiple webhooks during reboot.
3. **Graceful Shutdown Protocol**: All services listen to `SIGTERM` and `SIGINT`, shutting down workers, Socket.IO connections, Prisma clients, and Redis instances in an orderly sequence.
