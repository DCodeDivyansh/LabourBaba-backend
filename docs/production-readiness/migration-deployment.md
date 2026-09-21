# LabourBaba Backend — Migration & Deployment Protocol

## Overview
Production database migrations must be strictly versioned, deterministic, and executed without downtime or data loss. 

`prisma db push` is strictly prohibited in staging and production environments.

---

## 1. Production Migration Deployment Standard

### Migration Execution Command
```bash
npx prisma migrate deploy
```

### Pre-Deployment Checklist
1. **Full Database Snapshot**: Trigger snapshot backup before applying migrations.
2. **Backward Compatibility**: Ensure new schema changes are non-destructive (e.g. adding nullable columns before backfilling).
3. **PostGIS Extension Check**: Verify `CREATE EXTENSION IF NOT EXISTS postgis;` is included in base migrations.

---

## 2. Zero-Downtime Deployment Sequence

```
1. Run Pre-Migration Script -> `npx prisma migrate deploy`
2. Spin up new container instances running new release candidate
3. Verify `/health/ready` passes on new instances (Postgres + Redis checks pass)
4. Shift traffic via Load Balancer / Ingress to new instances
5. Drain and terminate old instances
```

---

## 3. Forward-Fix & Rollback Strategy
- In the event of an unexpected schema migration defect:
  - **Preferred**: Forward-fix with an incremental migration patch.
  - **Emergency Rollback**: Restore database from pre-deployment snapshot using `scripts/restore-db.ts` and revert code release.
