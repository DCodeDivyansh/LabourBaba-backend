# Staging Environment Runbook & Parity Specification (Issue #57)

## 1. Overview & Objective
The LabourBaba staging environment is designed to be fully production-like to expose critical infrastructure, concurrency, and dependency failures prior to production deployment.

---

## 2. Infrastructure & Environment Parity Matrix

| Component | Production | Staging | Parity Notes |
| :--- | :--- | :--- | :--- |
| **Node.js** | 22 LTS | 22 LTS | Identical runtime & V8 engine |
| **PostgreSQL** | 17 (Managed/RDS) | 17 (PostGIS Docker/Dedicated) | Identical PostGIS 3.5 spatial extension |
| **Redis** | Redis 7 (Upstash/Managed) | Redis 7 (Container/Dedicated) | Identical data structures, BullMQ queues, rate limits |
| **BullMQ** | 5.x Workers | 5.x Workers | Active dispatch & notification workers |
| **Socket.IO** | 4.8+ (JWT Handshake) | 4.8+ (JWT Handshake) | Role-guarded event channels |
| **FCM** | Firebase Admin SDK (Prod Project) | Firebase Admin SDK (Staging Project) | Separate staging service account & isolated credentials |
| **Prisma ORM** | 7.8 (`prisma migrate deploy`) | 7.8 (`prisma migrate deploy`) | Zero `prisma db push`; migration-only |
| **Container** | Hardened Alpine (UID 1001) | Hardened Alpine (UID 1001) | Non-root execution & `/health` probes |

---

## 3. Staging Deployment Procedure

### Step 1: Pre-Deployment Verification
```bash
# 1. Validate dependencies & lockfile
npm ci

# 2. Strict typecheck
npm run typecheck

# 3. Static security audit
npm run security:scan
```

### Step 2: Database Migration Deployment
```bash
# Apply pending Prisma production migrations
npx prisma migrate deploy

# Verify migration consistency
npx prisma migrate status
```

### Step 3: Container Build & Startup
```bash
# Build hardened Docker container
docker build -t labourbaba-backend:staging .

# Run with staging environment variables
docker run -d --name labourbaba-staging -p 5000:5000 --env-file .env.staging labourbaba-backend:staging
```

### Step 4: Staging Smoke Verification
```bash
# Execute end-to-end marketplace smoke suite
npm run test:smoke
```

---

## 4. Rollback & Forward-Fix Strategy
1. **Migration Rollback / Forward-Fix**: If a schema migration fails or introduces defects, generate a forward-fix migration using `npx prisma migrate dev --name fix_<issue>` in dev and apply via `npx prisma migrate deploy`.
2. **Container Rollback**: Re-tag and deploy the previous stable Docker image tag (`labourbaba-backend:<previous_commit_sha>`).
