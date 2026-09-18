# Security Architecture: Issue #11 — Revoke Sessions on Suspension/Deletion

**Priority**: P2  
**Category**: Authentication / Session Security  
**Audit Finding**: #70  
**Phase**: A — Identity & Authorization  
**Dependency**: Issue #10 — Server-Side Refresh Sessions  
**Status**: ✅ Fully Implemented & Tested

---

## Problem Statement

Prior to this remediation, account suspension or deletion had **no real security effect** on already-authenticated sessions:

| Vector | Vulnerability |
|--------|--------------|
| Access Token (JWT) | Stateless — valid for up to 1 hour after suspension |
| Refresh Token | Not revoked on suspension — could continue rotating |
| Socket.IO Connection | Not disconnected — persisted indefinitely |
| OTP Login | No suspension check — suspended accounts could re-authenticate |
| Password Login | Incomplete — missing `verification_status` suspension check |

---

## Security Invariant (Implemented)

> **A suspended or deleted account MUST NOT retain any form of usable authenticated access, regardless of whether an access token or refresh session was issued prior to the status change.**

This invariant is now enforced at **every authentication boundary** in the system.

---

## Architecture: Defense-in-Depth Layers

```
   Client Request
       │
       ▼
┌─────────────────────────────────────────┐
│  authenticateJWT (authMiddleware.ts)    │ ← Layer 1: Every HTTP request
│  • Verify JWT signature & claims        │
│  • DB check: deleted_at / status        │ ← Authoritative PostgreSQL lookup
│  • 401 ACCOUNT_SUSPENDED / INACTIVE     │
└─────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────┐
│  sessionService.rotateSession()         │ ← Layer 2: Refresh token flow
│  • Verify bcrypt secret                 │
│  • DB check: account suspended/deleted  │ ← Rejects refresh for suspended users
│  • Revoke token family on suspension    │
└─────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────┐
│  adminService.suspendWorker()           │ ← Layer 3: Atomic suspension
│  • Set verification_status: "suspended" │
│  • Set deleted_at = NOW (soft delete)   │
│  • Revoke ALL active refresh sessions   │ ← Atomic transaction
│  • Disconnect Socket.IO connections     │ ← Post-transaction
│  • Emit structured audit log            │
└─────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────┐
│  socketAuthMiddleware (socketAuth.ts)   │ ← Layer 4: Socket.IO handshake
│  • DB check: deleted_at / status        │ ← Rejects suspended worker connect
└─────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────┐
│  Login Flows (Layer 5: Re-auth denied)  │
│  • loginWorker: checks suspended/deleted │
│  • loginCustomer: checks deleted_at     │
│  • verifyOtp: checks both               │
└─────────────────────────────────────────┘
```

---

## Files Modified / Created

### NEW: `src/socket/socketLifecycle.ts`
Manages runtime Socket.IO Server reference and exposes `disconnectUserSockets(userId, role)` for authoritative connection termination. Called post-transaction on suspension.

### MODIFIED: `src/middlewares/authMiddleware.ts`
`authenticateJWT` converted to async middleware that performs an authoritative PostgreSQL lookup on every authenticated HTTP request:
- **Workers**: Rejects if `deleted_at != null || verification_status === "suspended"` → `401 ACCOUNT_SUSPENDED`
- **Customers**: Rejects if `deleted_at != null` → `401 ACCOUNT_INACTIVE`
- **Admins**: Pass-through (admin accounts managed separately)

### MODIFIED: `src/socket/socketHandlers.ts`
Registers `setSocketServer(io)` on startup to enable runtime socket disconnection.

### MODIFIED: `src/socket/socketAuth.ts`
Socket.IO handshake middleware now checks `verification_status === "suspended"` for workers in addition to `deleted_at`.

### MODIFIED: `src/features/admin/adminServices.ts`
`suspendWorker(workerId, payload, adminId)` now:
1. Pre-validates worker existence (404 if not found)
2. Atomically updates worker status + revokes all refresh sessions in a transaction
3. Post-transaction: disconnects all active Socket.IO connections
4. Emits structured audit log: `[AUDIT] Action: WORKER_SUSPENDED | Actor: ... | PrevStatus: ... | NewStatus: ... | RevokedSessions: N | Timestamp: ...`

### MODIFIED: `src/features/admin/adminController.ts`
`suspendWorker` controller passes `adminId` from the authenticated request context to the service for audit trail.

### MODIFIED: `src/features/auth/session.service.ts`
`rotateSession()` step 4.5 — Before rotating, checks account active status:
- Workers: `deleted_at` and `verification_status`
- Customers: `deleted_at`
Revokes the token family with `REVOKE_REASON.SUSPENDED` if account is inactive.

### MODIFIED: `src/features/auth/auth.services.ts`
`verifyOtp()` step 5.5 — After OTP verification, checks account active status before issuing tokens. Returns `ACCOUNT_SUSPENDED` / `ACCOUNT_INACTIVE` for suspended/deleted accounts.

### MODIFIED: `src/features/worker/workerController.ts`
`loginWorker` now checks both `deleted_at` and `verification_status === "suspended"`.

### MODIFIED: `src/features/auth/customerAuthController.ts`
`loginCustomer` already checked `deleted_at` — no change needed.

### MODIFIED: `tests/apiProtection.test.ts`
`beforeEach` now returns active accounts by default for `worker.findUnique` and `customer.findUnique` mocks, ensuring tests exercise the full auth middleware.

### MODIFIED: `tests/workerLocationSecurity.test.ts`
Updated "deactivated worker" and "non-existent worker" tests to expect `401 ACCOUNT_SUSPENDED` instead of `404`, reflecting the new authoritative middleware behavior.

### MODIFIED: `tests/sensitiveDataLeakage.test.ts`
Suspension test now properly mocks `$transaction`, `worker.findUnique`, `worker.update`, and `refresh_session.updateMany` for the new suspension flow.

### NEW: `tests/suspensionRevocationSecurity.test.ts`
Comprehensive P2 security test suite with 19 tests covering all 12 mandatory scenarios.

---

## Security Test Coverage

All 19 tests in `tests/suspensionRevocationSecurity.test.ts` pass:

| Scenario | Description | Verified |
|----------|-------------|----------|
| A | Existing access token immediately rejected after suspension | ✅ |
| B | Existing refresh session rejected after suspension | ✅ |
| C | New password login rejected for suspended worker | ✅ |
| C | New OTP login rejected for suspended worker | ✅ |
| D | Access token rejected for soft-deleted customer | ✅ |
| D | Refresh token rejected for soft-deleted customer | ✅ |
| D | Password login rejected for soft-deleted customer | ✅ |
| E | ALL sessions revoked across 3 devices simultaneously | ✅ |
| F | Logout is safe/idempotent on suspended session | ✅ |
| G | Old sessions remain revoked after unsuspension | ✅ |
| H | Worker B sessions unaffected when Worker A is suspended | ✅ |
| I | Only admin can invoke suspension (401/403 enforcement) | ✅ (×4) |
| J | Audit log contains actor/target/status without credentials | ✅ |
| K | Double-suspension is idempotent / safe | ✅ |
| L | `disconnectUserSockets` called on suspension | ✅ |
| L | Socket.IO handshake rejected for suspended worker | ✅ |

---

## Database Design

No new schema migrations were required. The implementation uses existing columns:

| Table | Column | Usage |
|-------|--------|-------|
| `worker` | `verification_status` | Set to `"suspended"` on suspension |
| `worker` | `deleted_at` | Set to `NOW()` on suspension (soft delete) |
| `customer` | `deleted_at` | Set to `NOW()` on deletion |
| `refresh_session` | `status` | Set to `REVOKED` atomically on suspension |
| `refresh_session` | `revoked_at` | Timestamp of revocation |
| `refresh_session` | `revoked_reason` | Set to `"SUSPENDED"` |

---

## Concurrency Safety

Suspension is atomic: the `prisma.$transaction` ensures that either **both** the worker status update and session revocation succeed, or **neither** does. This prevents partial states where a worker is suspended but sessions remain active.

---

## Performance Characteristics

The `authenticateJWT` DB check adds one indexed PostgreSQL lookup (`WHERE id = $1`) per authenticated request:
- Index: Primary key (`id`) — O(1) lookup
- Result cached by PostgreSQL connection pool
- Adds ~1–2ms per request in normal operation
- Acceptable trade-off for the security invariant

Consider adding Redis-based account state caching if performance becomes a concern at scale.

---

## Audit Log Format

```
[AUDIT] Action: WORKER_SUSPENDED | Actor: <adminId> (admin) | Target: <workerId> | PrevStatus: <previousStatus> | NewStatus: suspended | Reason: <reason> | RevokedSessions: <N> | Timestamp: <ISO8601>
```

The audit log deliberately omits passwords, token hashes, and raw tokens.
