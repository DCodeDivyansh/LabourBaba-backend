# Runbook: High Dispatch Failure Rate

## Overview
- **Alert**: `DispatchFailureRateHigh`
- **Severity**: Critical
- **Trigger**: Dispatch failure rate exceeds 10% over a 5-minute rolling window.
- **User Impact**: Job requirements remain unfilled; customers experience long wait times without worker assignments.

---

## 1. Initial Triage
1. **Inspect Metrics**:
   - Check `dispatch_failure_total{reason="no_candidates"}` vs other failure reasons.
2. **Review Candidate Selection Logs**:
   - Trace `dispatchCandidate.service.ts` query execution logs.

## 2. Likely Causes
- **Worker Supply Depletion**: No online workers within maximum radius (`MAX_DISPATCH_RADIUS_METERS`).
- **Location Freshness Exclusion**: Workers are online, but their GPS location is older than 15 minutes.
- **Skill Mismatch**: Required skill category has zero verified active workers.

## 3. Mitigation & Recovery
1. **Check Stale Location Supply**: Review `location_exclusions_total` metrics.
2. **Expand Wave Matching Radius**: If configured, enable fallback wave radius expansion.
