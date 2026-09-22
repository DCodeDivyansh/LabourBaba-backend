# Standard Operating Procedure (SOP): Database Disaster Recovery & Restoration

## 1. Objectives & Metrics
- **RPO (Recovery Point Objective)**: $\le 24$ hours for daily cold dumps / $\le 5$ minutes with WAL archiving.
- **RTO (Recovery Time Objective)**: $\le 15$ minutes (900 seconds) from recovery declaration to verified application traffic resumption.
- **PostGIS & Geographic Integrity**: 100% PostGIS 3.3+ spatial extension retention and valid `geography(Point, 4326)` columns.
- **Critical Data Integrity**: Zero loss of confirmed bookings, financial audit logs, and user credentials.

---

## 2. Emergency Escalation & Declaration
1. **Incident Trigger**:
   - Catastrophic database corruption or hardware outage reported.
   - Prometheus alert `DatabaseUnavailable` firing continuously for $> 2$ minutes.
2. **Declaration**:
   - Incident Commander (IC) announces recovery mode in `#incident-response`.
   - Point application pods to maintenance mode or stop inbound traffic at ingress/load balancer.

---

## 3. Step-by-Step Restoration Procedure

### Step 1: Obtain the Verified Backup Artifact
Locate the latest backup SQL and SHA-256 checksum file in secure cloud storage or `backups/`:
```bash
# Locate latest backup file
ls -lt backups/backup_*.sql | head -n 1
```

### Step 2: Validate Cryptographic Hash (SHA-256)
Never restore an unverified or corrupted artifact:
```bash
# Verify checksum matches
sha256sum -c backups/backup_<timestamp>.sql.sha256
```
If the checksum does not match, immediately reject the file and fail closed.

### Step 3: Execute Restoration into Isolated Database
Do **NOT** overwrite production in-place without initial isolated validation:
```bash
# Execute isolated restoration runner
npx tsx scripts/restore-db.ts backups/backup_<timestamp>.sql
```

### Step 4: Validate Database Schema & Extensions
Execute post-restore verification queries:
```sql
-- 1. Check PostGIS version
SELECT PostGIS_Version();

-- 2. Verify all core tables exist and have rows
SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';

-- 3. Verify spatial index sanity
SELECT count(*) FROM worker_location WHERE ST_DWithin(coordinates, ST_MakePoint(77.2090, 28.6139)::geography, 5000);
```

### Step 5: Application Smoke Testing
Run the staging smoke test suite against the restored database:
```bash
npm run typecheck
npx jest tests/stagingSmoke.test.ts --runInBand
```

### Step 6: Traffic Switch & Operational Confirmation
1. Update application connection string in Secret Manager or environment variables (`DATABASE_URL`).
2. Restart application pods with rolling update.
3. Verify `/health/ready` returns HTTP 200 on all pods.
4. Record recovery completion timestamp and compute final RTO and RPO metrics.
