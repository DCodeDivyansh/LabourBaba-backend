# Runbook: Push Notification Delivery Failure

## Overview
- **Alert**: `NotificationFailureRateHigh`
- **Severity**: Warning
- **Trigger**: FCM notification failure rate exceeds 5% over a 5-minute rolling window.
- **User Impact**: Workers do not receive dispatch wave notifications; booking confirmation alerts are delayed.

---

## 1. Initial Triage
1. **Inspect FCM Delivery Logs**:
   - Check `[FCM] Transient error sending push notification` vs `[FCM] Token is invalid/unregistered`.
2. **Review Outbox Table**:
   - Check count of records in `notification_outbox` where `status = 'FAILED'`.

## 2. Likely Causes
- **Firebase Service Outage / API Throttling**: Google Cloud FCM service latency or quota limits.
- **Expired / Unregistered Device Tokens**: High rate of uninstalled mobile apps triggering `registration-token-not-registered`.
- **Invalid Service Account Credentials**: Expired or rotated service account key.

## 3. Mitigation & Recovery
1. **Auto-Token Revocation**: Verify that `workerDeviceService.revokeByToken()` is revoking invalid tokens.
2. **Durable Outbox Retry**: Ensure `outboxWorker` automatically retries transient errors with exponential backoff.
