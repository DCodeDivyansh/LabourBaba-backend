# Runbook: PostgreSQL Connection Pool Saturation

## Overview
- **Alert**: `DatabasePoolSaturation`
- **Severity**: Critical
- **Trigger**: `database_pool_waiting_clients > 0` for over 1 minute.
- **User Impact**: API request latency spikes, connection timeout errors (500/503), degraded dispatch and booking throughput.

---

## 1. Initial Triage
1. **Inspect Prometheus Pool Metrics**:
   - `database_pool_waiting_clients`: Number of clients blocked waiting for a connection.
   - `database_pool_active_connections`: Number of queries currently holding a connection.
   - `database_pool_max_connections`: Configured process pool limit.
2. **Check PostgreSQL `pg_stat_activity`**:
   ```sql
   SELECT pid, now() - query_start AS duration, state, query
   FROM pg_stat_activity
   WHERE state != 'idle'
   ORDER BY duration DESC;
   ```
3. **Verify Pool Headroom Budget**:
   - Check `src/config/databasePoolConfig.ts` against target instance count.

---

## 2. Likely Causes
- **Slow Queries / Missing Indexes**: Long-running transactions holding pool connections beyond statement timeout.
- **Connection Leak**: Transactions or clients acquired outside Prisma without proper release or error handling.
- **High Traffic Surge**: API traffic exceeding current pool sizing (`DB_POOL_MAX`).
- **Distributed Contention**: Multiple horizontal worker/API instances competing for database slots without Supabase connection pooler / PgBouncer.

---

## 3. Mitigation & Recovery
1. **Kill Long-Running Stalled Queries**:
   ```sql
   SELECT pg_terminate_backend(pid)
   FROM pg_stat_activity
   WHERE state != 'idle' AND now() - query_start > interval '30 seconds';
   ```
2. **Scale Horizontal Instances / Adjust Pool Sizing**:
   - If total PostgreSQL `max_connections` allows headroom, adjust `DB_POOL_MAX` in environment.
3. **Verify Transaction Pooler**:
   - Ensure `DATABASE_URL` connects through Supabase PgBouncer pooler (port 6543) rather than direct session mode (port 5432).
4. **Restart Stalled API/Worker Process**:
   - Trigger rolling restart to drain and reinitialize exhausted connection pools.
