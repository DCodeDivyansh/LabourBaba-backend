# Production Release Runbook (Issue 79)

## Pre-Release Verification Checklist
- [x] All automated test suites green (`npm test`).
- [x] TypeScript typecheck passed with zero errors (`npm run typecheck`).
- [x] Security audit scan clean (`npm audit`).
- [x] All database migrations verified via `npx prisma migrate status`.
- [x] Production secrets present in Secret Store (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `JWT_SECRET`, `DATABASE_URL`, `REDIS_URL`).
- [x] Zero-downtime rolling deployment tested on Staging.

## Deployment Execution Steps

```
                  DEPLOYMENT SEQUENCE
                  ───────────────────
   1. Database Snapshot / pg_dump (Pre-migration safety)
                        │
                        ▼
   2. Run Migration: npx prisma migrate deploy
                        │
                        ▼
   3. Deploy Container Artifact (Docker / K8s Rolling Update)
                        │
                        ▼
   4. Start BullMQ Workers & Outbox Processors
                        │
                        ▼
   5. Verify Health: GET /health (DB, Redis, PostGIS, Workers)
                        │
                        ▼
   6. Execute Production Smoke Tests
                        │
                        ▼
   7. Enable Active Ingress / Traffic Routing
```

### 1. Database Pre-Migration Backup
```bash
pg_dump -h $DB_HOST -U $DB_USER -d $DB_NAME -Fc -f "/backups/labourbaba_predeploy_$(date +%Y%m%d_%H%M%S).dump"
```

### 2. Apply Schema Migrations
```bash
npx prisma migrate deploy
```

### 3. Application Launch & Health Check
```bash
curl -f http://localhost:5000/health
```

## Rollback & Forward-Fix Matrix

| Failure Mode | Trigger Condition | Remediation Action | Authorization Required |
|---|---|---|---|
| **Health Check Failure** | `/health` returns non-200 post-boot | Revert container image to previous release tag (`vCurrent - 1`) | On-Call Lead / Release Eng |
| **Outbox Delivery Stall** | `notification_outbox` lag > 500 items | Scale outbox worker replica count; inspect FCM quota | Backend Lead |
| **Payment Webhook Errors** | `recordWebhookSignatureFailure` spikes | Verify Razorpay dashboard webhook configuration & secret match | Security Lead |
| **Database Schema Incompatibility** | Migration fails or breaks queries | Apply forward-fix migration patch; DO NOT run destructive rollback | DB Admin & Tech Lead |
