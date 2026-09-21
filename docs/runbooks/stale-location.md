# Runbook: Stale Location Supply & Worker Location Exclusions

## Overview
- **Alert**: `StaleLocationSupplyHigh`
- **Severity**: Warning
- **Trigger**: More than 50 workers excluded from dispatch waves due to stale GPS fixes (>15 minutes old).
- **User Impact**: Dispatch engine fails to match available nearby workers, leading to false "no workers available" states.

---

## 1. Initial Triage
1. **Check Location Freshness Telemetry**:
   - Query `locationFreshnessTelemetry.getMetrics()`.
2. **Review Mobile Worker GPS Sync**:
   - Verify if mobile workers' background GPS location updates are reaching `POST /api/worker_location/add`.

## 2. Likely Causes
- **Mobile OS Background Aggressive Sleep / Power Saving**: Android/iOS killing background location sync services.
- **Worker App Network Connectivity**: Workers in poor connectivity areas unable to push GPS beacons.

## 3. Mitigation & Recovery
1. **Push Background Wakeup Beacons via FCM**: Trigger silent data-only push notifications to wake up worker client GPS sync.
2. **Monitor Retention Cleanup**: Ensure `locationRetentionService` has not deleted active current worker records.
