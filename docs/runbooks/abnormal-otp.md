# Runbook: Abnormal OTP Verification Failures & Brute Force Defense

## Overview
- **Alert**: `AbnormalOtpAttempts`
- **Severity**: Warning
- **Trigger**: Spike in failed OTP verifications (>20 failed attempts/minute).
- **User Impact**: Potential SMS abuse, phone enumeration, or account takeover attempts.

---

## 1. Initial Triage
1. **Check OTP Audit Logs**:
   - Filter structured logs by `[AUTH_AUDIT]` and identify targeted phone numbers or source IP addresses.
2. **Review Rate Limiting Headers**:
   - Check if `rateLimiter` is issuing HTTP 429 Too Many Requests to offending IPs/phones.

## 2. Likely Causes
- **SMS Brute-Force Bot**: Automated script guessing OTPs.
- **SMS Delivery Lag**: Carrier SMS latency causing users to retry and submit stale OTP codes.

## 3. Mitigation & Recovery
1. **Enforce Phone Challenge Locking**: Verify `otp_challenge` locks after 5 failed attempts (`attempt_count >= 5`).
2. **Block Malicious IP Ranges**: Block offending IPs via Cloudflare / AWS WAF if a distributed attack is observed.
