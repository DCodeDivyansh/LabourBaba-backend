# Migration & Deployment Drill (Issue 76)

## Purpose & Production Standard
LabourBaba rejects ad-hoc manual SQL execution (`prisma db push`) in production environments. All database schema evolutions must be tracked in versioned Prisma migrations, deployable via `npx prisma migrate deploy` in continuous delivery pipelines, and support safe zero-downtime forward migrations.

## Verified Migration History

```
prisma/migrations/
├── 20260218153406_init/
├── 20260301000000_add_customer_verification_status/
├── 20260301000001_add_payout_tables/
├── 20260303000000_add_booking_pricing_fields/
├── 20260315000000_add_job_requirement_tables/
├── 20260318000000_add_notification_outbox/
├── 20260319000000_add_audit_log_table/
├── 20260320000000_add_payment_webhook_events/
└── 20260921080000_payment_refund_and_reconciliation_hardening/
```

## Migration Drill Verification Steps

| Drill Stage | Action Taken | Expected Outcome | Result |
|---|---|---|---|
| **1. Clean Schema Boot** | `npx prisma migrate deploy` on empty DB | All tables, PostGIS extensions, and indexes created cleanly | **PASS** |
| **2. Checksum Integrity** | `npx prisma migrate status` | Migration history in sync with local schema definition | **PASS** |
| **3. PostGIS Verification** | Query `ST_DWithin` / `ST_MakePoint` on worker coordinates | Spatial index (`GIST`) resolves spatial queries with sub-millisecond latency | **PASS** |
| **4. Foreign Key & Unique Constraints** | Validate unique constraint on `PaymentWebhookEvent(providerEventId)` and `Payment(booking_id)` | Prevents duplicate webhook insertions and duplicate active payments | **PASS** |
| **5. Backup & Restore Rehearsal** | `pg_dump -Fc` followed by `pg_restore --clean` | Full data integrity restored without orphaned records | **PASS** |
| **6. Worker Boot Post-Migration** | Start API + BullMQ workers against migrated schema | Schema compatibility validated across all services | **PASS** |

## Forward-Fix Strategy
- **Forward-Fix Principle**: Production database migrations are designed to be additive and backward compatible (e.g. nullable new columns, expanding enums, creating indices concurrently).
- **No Destructive Rollback**: Rolling back destructive migrations in production is prohibited to prevent data loss. Schema corrections must be committed as new migration steps.
