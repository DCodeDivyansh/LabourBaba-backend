# Issue 13 — Finish OTP Abuse Controls & Distributed Rate Limiting

## 1. Problem Description
OTP challenges represent a critical authentication boundary susceptible to enumeration, brute-force guessing, SMS flooding, replay attacks, and concurrent race conditions.

## 2. Invariants & Implementation
1. **Cryptographic Randomness**: 6-digit OTP generated via `crypto.randomInt(100000, 1000000)` in `src/utils/authUtils.ts`.
2. **Bcrypt Hashing**: Plaintext OTP is hashed via `bcrypt.hash(plainOtp, 10)` before persistence into `otp_challenge.otp_hash`. Plaintext OTP is never persisted or logged.
3. **TTL & Expiry**: Challenges expire in 300s (`authConfig.otpTtlSeconds = 300`).
4. **Attempt Limits**: Maximum 5 verification attempts per challenge. Upon reaching limit, challenge status is set to `LOCKED`.
5. **Atomic Single-Use Consumption**: Successful verification executes an atomic database update `UPDATE otp_challenge SET status = 'CONSUMED', consumed_at = NOW() WHERE id = :id AND status = 'ACTIVE'`. Concurrent verification attempts produce exactly 1 success; all others fail with `OTP_ALREADY_USED` / `OTP_INVALID`.
6. **Resend Cooldown**: 60s cooldown window (`authConfig.otpResendCooldownSeconds = 60`) prevents SMS flooding.
7. **Multi-Dimension Rate Limiting**: Redis-backed distributed rate limiters in `src/middlewares/otpRateLimiter.ts`:
   - IP limit: 10 requests / 15 min
   - Phone limit: 5 requests / 15 min
   - Device limit: 5 requests / 15 min
8. **Logging Redaction**: Phone numbers are masked (`maskPhone`), and OTP tokens are never written to logs.
9. **Stale Challenge Purging**: Background cleanup service `authService.cleanupExpiredOtpChallenges(7)` purges records older than 7 days.

## 3. Test Evidence
- Verified via `tests/otpSecurity.test.ts` (20 tests PASS) & `tests/routeRateLimiting.test.ts` (14 tests PASS).
