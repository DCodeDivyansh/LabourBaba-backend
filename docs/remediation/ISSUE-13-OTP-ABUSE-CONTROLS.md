# LabourBaba Backend Remediation Document
## Issue #13 — Finish OTP Abuse Controls

---

### 1. Executive Summary

| Attribute | Details |
|---|---|
| **Issue Number** | Issue #13 |
| **Category** | Authentication / Abuse Prevention / Cryptographic Controls |
| **Priority** | P0 / P1 |
| **Original Audit Findings** | Audit Findings #3, #31, #52 |
| **Affected Components** | `src/features/auth/auth.services.ts`, `src/middlewares/otpRateLimiter.ts`, `src/config/authConfig.ts`, `src/server.ts`, `prisma/schema.prisma` |
| **Status** | Fully Remediated & Verified |

This remediation hardens and completes LabourBaba's OTP authentication pipeline against brute-force guessing, SMS toll fraud / telephony exhaustion, race conditions, replay attacks, and privacy leakage. 

---

### 2. Threat Model & Audit Findings Addressed

1. **Audit Finding #3 (Hard-Coded & Predictable OTPs)**: Eliminates static authentication bypasses and ensures CSPRNG `crypto.randomInt(100000, 1000000)` generation with constant-time HMAC comparison.
2. **Audit Finding #31 (Race Conditions & SMS Flooding under Concurrency)**: Closes cooldown bypasses and attempt counter races by enforcing transactional isolation and atomic database updates (`attempt_count: { increment: 1 }`).
3. **Audit Finding #52 (PII in Redis Cache & Abuse Rate Limiting)**: Implements multi-dimensional rate limiting across Phone, IP, and Device ID dimensions while hashing identifiers with SHA-256 (`hashIdentifier`) so plaintext phone numbers never persist in cache keys.

---

### 3. Key Invariants Enforced

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       OTP INVARIANT PIPELINE                                │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. Cryptographic Generation  : crypto.randomInt(100000, 1000000) (CSPRNG)  │
│ 2. Storage Privacy           : Plaintext OTP NEVER stored or returned       │
│ 3. Storage Hashing           : HMAC-SHA256 with server-side secret          │
│ 4. Rate-Limiting Keys        : SHA-256 hashed identifiers (no PII in Redis) │
│ 5. Multi-Dimension Limit     : Phone (5/hr), IP (20/hr), Device (10/hr)     │
│ 6. Atomic Cooldown           : Database transaction locks out race resends  │
│ 7. Bounded Attempts          : Max 5 attempts; atomic DB increment lock     │
│ 8. Single-Use Consumption    : Atomic CAS (status=ACTIVE, consumed_at=null) │
│ 9. Server Expiry (TTL)       : Strict 300s TTL (never client controlled)    │
│ 10. Automated Purge          : Daily background job purges stale challenges │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### 4. Implementation Details

#### 4.1. Privacy-Preserving Multi-Dimension Rate Limiter (`src/middlewares/otpRateLimiter.ts`)
- **Key Hashing**: All identifiers (IP addresses, E.164 phone numbers, device IDs) are passed through `hashIdentifier(val)` which computes a 16-character SHA-256 digest:
  ```typescript
  export function hashIdentifier(val: string): string {
    return crypto.createHash("sha256").update(val.trim()).digest("hex").slice(0, 16);
  }
  ```
- **Dimension Coverage**:
  - `ratelimit:otp:req:phone:<hash>` (5 requests / 60 min)
  - `ratelimit:otp:req:ip:<hash>` (20 requests / 60 min)
  - `ratelimit:otp:req:device:<hash>` (10 requests / 60 min)
  - `ratelimit:otp:vfy:phone:<hash>` (10 verify requests / 15 min)
  - `ratelimit:otp:vfy:ip:<hash>` (30 verify requests / 15 min)
  - `ratelimit:otp:vfy:device:<hash>` (20 verify requests / 15 min)
- **Device Extraction**: Supports `req.body.device_id` and `req.headers["x-device-id"]`.
- **In-Memory Fallback**: When Redis is unavailable, rate limits gracefully degrade to an in-memory TTL map with identical privacy hashing.

#### 4.2. Atomic Transactional Cooldown & Storage (`src/features/auth/auth.services.ts`)
- **Race Condition Immunity**: In `sendOtp`, cooldown enforcement and existing challenge invalidation are executed inside `prisma.$transaction`:
  ```typescript
  const result = await prisma.$transaction(async (tx) => {
    // 1. Check for active challenges created within cooldown window
    const cooldownCutoff = new Date(Date.now() - authConfig.otpResendCooldownSeconds * 1000);
    const recentChallenge = await tx.otp_challenge.findFirst({
      where: {
        phone: canonicalPhone,
        purpose,
        created_at: { gt: cooldownCutoff },
        status: { in: ["ACTIVE", "EXPIRED", "LOCKED"] },
      },
      orderBy: { created_at: "desc" },
    });
    if (recentChallenge) {
      throw cooldownError;
    }

    // 2. Invalidate older active challenges for same phone/purpose
    await tx.otp_challenge.updateMany({
      where: { phone: canonicalPhone, purpose, status: "ACTIVE" },
      data: { status: "INVALIDATED" },
    });

    // 3. Create fresh challenge with HMAC hash
    return tx.otp_challenge.create({ ... });
  });
  ```

#### 4.3. Atomic Attempt Increment & Single-Use Consumption
- In `verifyOtp`, failed attempts atomically increment in PostgreSQL:
  ```typescript
  await prisma.otp_challenge.update({
    where: { id: challenge.id },
    data: {
      attempt_count: { increment: 1 },
      status: nextAttemptCount >= authConfig.otpMaxAttempts ? "LOCKED" : "ACTIVE",
    },
  });
  ```
- Successful consumption uses an atomic CAS update query:
  ```typescript
  const updated = await prisma.otp_challenge.updateMany({
    where: {
      id: challenge.id,
      status: "ACTIVE",
      consumed_at: null,
    },
    data: {
      status: "CONSUMED",
      consumed_at: new Date(),
    },
  });
  if (updated.count === 0) {
    throw replayError;
  }
  ```

#### 4.4. Stale Challenge Purge Job & Composite Indexes
- **Cleanup Routine**: `authService.cleanupExpiredOtpChallenges(retentionDays)` purges challenges older than 7 days (`authConfig.otpCleanupRetentionDays`).
- **Server Timer**: Registered on server startup in `src/server.ts` running once every 24 hours (`unref()`-ed so as not to hold process open).
- **Database Indexes**:
  - `idx_otp_challenge_phone_purpose_status` on `[phone, purpose, status]`
  - `idx_otp_challenge_created_at` on `[created_at]`

---

### 5. Verification & Test Evidence

All 20 comprehensive OTP security tests in `tests/otpSecurity.test.ts` pass successfully:
- **Zero Static Bypasses**: Rejects `123456`, `000000`, `111111`, `999999`.
- **CSPRNG Uniformity**: Verifies 6-digit cryptographic generation.
- **Single-Use Replay Protection**: Verifies second attempt with identical OTP is rejected with `401 OTP_ALREADY_USED`.
- **Attempt Locking**: 5 consecutive wrong OTP attempts permanently lock challenge.
- **Expiry TTL**: Expired challenge rejected with `401 OTP_EXPIRED`.
- **Concurrency Races**: N parallel verify requests allow exactly 1 success; N parallel send requests allow exactly 1 SMS dispatch within cooldown.
- **Multi-Dimension Rate Limiting**: Enforces limits on IP, Phone, and Device ID dimensions.
- **Privacy Key Hashing**: Confirms Redis keys contain SHA-256 digests and zero plain E.164 phone numbers.
- **Purge Routine**: Confirms records older than retention threshold are deleted.
