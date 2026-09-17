# Security Analysis: Remediation of P0 Vulnerability — Admin Authorization Is Not Actually RBAC

## 1. Executive Summary

This document details the security audit, root cause analysis, architecture redesign, and automated test validation for the remediation of **Finding #1 — Admin authorization is not actually RBAC (Severity: P0)**.

The critical security invariant established by this fix is:
> **Possession of a valid JWT alone never confers administrative privileges. All administrative operations strictly enforce cryptographic server-side role verification (`requireRole(UserRole.ADMIN)`).**

---

## 2. Root Cause Analysis

Prior to this remediation, administrative privilege in `src/features/admin/adminController.ts` was checked using:

```typescript
const isAdmin = (req: Request) => {
  // Verify that the request has been authenticated via JWT
  return !!(req as any).user;
};
```

And in each admin handler:
```typescript
if (!isAdmin(req)) {
  res.status(401).json({ success: false, message: "Unauthorized" });
  return;
}
```

### Why This Caused a Severe Privilege Escalation Vulnerability:
1. **Authentication Was Conflated With Authorization**: The check `!!req.user` merely asserted that a JWT token was present and had a valid signature. It did not inspect *who* the principal was or *what roles* they possessed.
2. **Every User Was an Administrator**: Since customer signup/login and worker login legitimately issue signed JWTs containing `{ id, phone, role: "customer" }` or `{ id, phone, role: "worker" }`, any customer or worker with a valid token satisfied `!!req.user === true`.
3. **Admin Routes Lacked Role-Based Route Guards**: In `src/features/admin/adminRoutes.ts`, routes were only guarded by `authenticateJWT`.
4. **Incorrect HTTP Status Codes**: Even if `isAdmin` returned false, it returned `401 Unauthorized` (indicating missing or invalid authentication) instead of `403 Forbidden` (indicating authenticated identity with insufficient authorization).

---

## 3. Attack Scenarios

### Scenario A: Malicious Worker Modifying Verification Status
1. An unverified or rejected worker signs into the mobile app via `POST /api/workers/login`.
2. The server returns a valid JWT signed with `JWT_SECRET`, containing `role: "worker"`.
3. The attacker copies this JWT and issues a request to:
   ```http
   PATCH /api/admin/workers/<attacker_worker_id>/verify HTTP/1.1
   Host: api.labourbaba.com
   Authorization: Bearer <attacker_worker_jwt>
   Content-Type: application/json

   {
     "status": "VERIFIED"
   }
   ```
4. `authenticateJWT` verified the signature and set `req.user`.
5. `adminController.verifyWorker` ran `isAdmin(req)` which returned `true` because `req.user` existed.
6. The worker successfully marked their own unverified Aadhaar document as `VERIFIED` and activated their account.

### Scenario B: Customer Suspending Legitimate Workers
1. A rogue customer signs up via `POST /api/clients/signup`.
2. The customer obtains a valid JWT with `role: "customer"`.
3. The customer issues a request to:
   ```http
   POST /api/admin/workers/<competitor_worker_id>/suspend HTTP/1.1
   Host: api.labourbaba.com
   Authorization: Bearer <customer_jwt>
   Content-Type: application/json

   {
     "reason": "Arbitrary suspension"
   }
   ```
4. Because `!!req.user` was true, the endpoint suspended the innocent worker from the platform.

---

## 4. Architecture Changes & RBAC Model

### A. Strongly-Typed Role System
Created `src/type/userRole.ts`:
```typescript
export enum UserRole {
  CUSTOMER = "customer",
  WORKER = "worker",
  ADMIN = "admin",
}

export function isValidUserRole(role: unknown): role is UserRole {
  return typeof role === "string" && Object.values(UserRole).includes(role as UserRole);
}

export interface AuthenticatedUser {
  id: string;
  phone?: string;
  role: UserRole;
}
```

### B. Boundary Validation at JWT Ingestion
In `src/middlewares/authMiddleware.ts`:
- Validates the token's cryptographic signature via `verifyToken()`.
- Validates and normalizes `decoded.role` against `UserRole` via `isValidUserRole()`.
- Rejects missing, malformed, or unrecognized role strings immediately with `401 Unauthorized`.
- Guarantees that `req.user.role` is strictly of type `UserRole`.

### C. Centralized `requireRole` Middleware
Implemented in `src/middlewares/authMiddleware.ts`:
```typescript
export function requireRole(...allowedRoles: UserRole[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        message: "Authentication required",
      });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      console.warn(
        `[SECURITY] Authorization failed: user ${req.user.id} with role '${req.user.role}' attempted to access route requiring [${allowedRoles.join(", ")}]`
      );
      res.status(403).json({
        success: false,
        message: "Forbidden: Insufficient permissions",
      });
      return;
    }

    next();
  };
}
```

### D. Route-Level & Router-Level Admin Protection
In `src/features/admin/adminRoutes.ts`:
- Applied `router.use(authenticateJWT, requireRole(UserRole.ADMIN))` at the router level.
- Applied explicit `authenticateJWT, requireRole(UserRole.ADMIN)` on every route definition:
  - `GET /workers`
  - `PATCH /workers/:id/verify`
  - `GET /jobs`
  - `GET /flagged`
  - `POST /workers/:id/suspend`
- Protected adjacent platform administration endpoint:
  - `POST /api/skill/add` guarded with `authenticateJWT, requireRole(UserRole.ADMIN)`.

### E. Elimination of `isAdmin()`
- Completely removed `isAdmin()` from `adminController.ts`.
- Removed inline `if (!isAdmin(req))` checks from handlers, preventing divergence or regressions.
- Added structured audit logging on state-changing operations (`verifyWorker`, `suspendWorker`) recording admin ID, action, target worker ID, and timestamp without logging credentials or PII.

---

## 5. JWT Role Authority & Stale-Token Considerations

### Authority Model
- The signed JWT is an asymmetric/symmetric cryptographic assertion of the principal's identity and assigned role at token generation time.
- The server validates the token signature using `JWT_SECRET`. Since the signing key is kept secret on the server, clients cannot forge or elevate roles.

### Revocation & Demotion Considerations
In a pure stateless JWT model, if an administrator is demoted or terminated, previously issued access tokens remain valid until their expiration (`exp`).
To manage this window:
1. **Short-Lived Access Tokens**: Tokens should have a short lifespan (e.g. 15 minutes to 1 hour), requiring refresh tokens for continued access.
2. **Revocation Strategy**: For real-time invalidation of privileged credentials, a Redis-based blocklist or checking a `token_version` / `updated_at` claim against the database on critical admin actions is recommended.

---

## 6. Threat Model & Mitigated Attack Vectors

| Attack Vector | Vulnerability State Before Fix | Mitigated State After Fix |
| :--- | :--- | :--- |
| **Customer calls admin route** | Allowed (HTTP 200) | Blocked at middleware with HTTP 403 Forbidden |
| **Worker calls admin route** | Allowed (HTTP 200) | Blocked at middleware with HTTP 403 Forbidden |
| **Unauthenticated attacker calls admin route** | HTTP 401 Unauthorized | HTTP 401 Unauthorized |
| **Role Spoofing via query (`?role=admin`)** | N/A (was already allowed) | Blocked with HTTP 403 Forbidden (query ignored) |
| **Role Spoofing via body (`{ role: "admin" }`)** | N/A (was already allowed) | Blocked with HTTP 403 Forbidden (body ignored) |
| **Tampered JWT signature** | HTTP 401 | Blocked with HTTP 401 Unauthorized |
| **Forged role in JWT (`role: "superuser"`)** | Accepted as authenticated | Blocked at JWT boundary with HTTP 401 Unauthorized |
| **State mutation by unauthorized actor** | Database updated | Blocked with HTTP 403; **database state untouched** |

---

## 7. Automated Test Matrix

The authorization matrix was verified via automated integration tests in `tests/apiProtection.test.ts`:

| Test Scenario | Route | Expected | Actual | DB Mutation Occurred? |
| :--- | :--- | :---: | :---: | :---: |
| Unauthenticated | `GET /api/admin/workers` | 401 | 401 | No |
| Customer Token | `GET /api/admin/workers` | 403 | 403 | No |
| Worker Token | `GET /api/admin/workers` | 403 | 403 | No |
| Customer + `?role=admin` | `GET /api/admin/workers` | 403 | 403 | No |
| Worker + `?role=admin` | `GET /api/admin/workers` | 403 | 403 | No |
| Admin Token | `GET /api/admin/workers` | 200 | 200 | N/A (read-only) |
| Unauthenticated | `PATCH /api/admin/workers/:id/verify` | 401 | 401 | No |
| Customer Token | `PATCH /api/admin/workers/:id/verify` | 403 | 403 | **Verified No** |
| Worker Token | `PATCH /api/admin/workers/:id/verify` | 403 | 403 | **Verified No** |
| Customer + body `role: admin` | `PATCH /api/admin/workers/:id/verify` | 403 | 403 | **Verified No** |
| Admin Token | `PATCH /api/admin/workers/:id/verify` | 200 | 200 | **Verified Yes** |
| Unauthenticated | `GET /api/admin/jobs` | 401 | 401 | No |
| Customer Token | `GET /api/admin/jobs` | 403 | 403 | No |
| Worker Token | `GET /api/admin/jobs` | 403 | 403 | No |
| Admin Token | `GET /api/admin/jobs` | 200 | 200 | N/A (read-only) |
| Unauthenticated | `GET /api/admin/flagged` | 401 | 401 | No |
| Customer Token | `GET /api/admin/flagged` | 403 | 403 | No |
| Worker Token | `GET /api/admin/flagged` | 403 | 403 | No |
| Admin Token | `GET /api/admin/flagged` | 200 | 200 | N/A (read-only) |
| Unauthenticated | `POST /api/admin/workers/:id/suspend` | 401 | 401 | No |
| Customer Token | `POST /api/admin/workers/:id/suspend` | 403 | 403 | **Verified No** |
| Worker Token | `POST /api/admin/workers/:id/suspend` | 403 | 403 | **Verified No** |
| Worker + body `role: admin` | `POST /api/admin/workers/:id/suspend` | 403 | 403 | **Verified No** |
| Admin Token | `POST /api/admin/workers/:id/suspend` | 200 | 200 | **Verified Yes** |
| Tampered JWT signature | `GET /api/admin/workers` | 401 | 401 | No |
| Invalid / unknown role claim | `GET /api/admin/workers` | 401 | 401 | No |
| Missing role claim | `GET /api/admin/workers` | 401 | 401 | No |
| Expired Token | `GET /api/admin/workers` | 401 | 401 | No |
| Customer Token | `POST /api/skill/add` | 403 | 403 | No |
| Worker Token | `POST /api/skill/add` | 403 | 403 | No |
| Admin Token | `POST /api/skill/add` | 200 | 200 | Yes |

---

## 8. Remaining Adjacent Security Findings (Out of Scope)

While this remediation completely eliminates the P0 admin RBAC vulnerability, the production readiness audit highlighted other authorization concerns across the backend that remain open for future fixes:

1. **Object-Level Access Control (IDOR)**:
   - Ensuring customers can only view/cancel their own jobs and bookings.
   - Ensuring workers can only view and update their own profiles, analytics, and documents.
2. **Chat Participant Authorization**:
   - Verifying that users requesting booking messages belong to that booking conversation.
3. **Payment Ownership**:
   - Verifying customer ownership of bookings before creating payment orders or refunds.
4. **Token Revocation Store**:
   - Implementing a shared Redis blocklist for immediate token revocation upon password change or account suspension.

---

# Security Analysis: Remediation of P0 Vulnerability — Password Hashes & Sensitive ORM Data Leakage

## 1. Executive Summary

This section details the security audit, architecture overhaul, and automated regression test validation for the remediation of **P0 Release-Blocking Vulnerability — Password hashes and sensitive Prisma data leak across API boundaries**.

The non-negotiable security invariant enforced throughout the repository is:

```text
Prisma entity
    ↓
explicit allow-listed select
    ↓
internal typed record
    ↓
explicit DTO mapper
    ↓
HTTP / Socket.IO response
```

**Never**:
- Return raw Prisma model instances (`return prisma.worker.findUnique(...)`).
- Serialize raw Prisma entities across HTTP or Socket.IO (`res.json(worker)` or `socket.emit(...)`).
- Use object spread operators on database entities for API responses (`return { ...worker }`).
- Use broad relation inclusions (`include: { worker: true, customer: true }`) where relations cross an API boundary.

---

## 2. Sensitive Data Classification Policy

All database fields across the Prisma schema are strictly classified into disclosure tiers:

| Tier | Fields & Models | Policy |
| :--- | :--- | :--- |
| **Critical Secrets** | `Worker.password`, `customer.password`, `booking.otp_hash` | **NEVER expose across any API, HTTP, or Socket.IO boundary.** Selected internally only during cryptographic credential verification (`bcrypt.compare`). |
| **Sensitive / Private Data** | `Worker.device_token`, `Worker.aadhaar_last4`, `worker_document.file_url`, phone numbers | **Exposed only to authorized owners or admins in dedicated context-specific DTOs.** Never present in generic public summaries or search listings. Device tokens are strictly internal to push dispatch mechanisms. Private document URLs are protected workflows. |
| **Internal Metadata** | `Worker.deleted_at`, `customer.deleted_at`, `job.deleted_at`, `decline_count`, `timeout_count` | **Excluded from public/generic DTOs.** Only surfaced to administrative audit panels via explicit admin DTOs. |
| **Public / Shared Data** | `Worker.id`, `Worker.name`, `Worker.skill_type`, `Worker.worker_score`, `is_online` | Safely included in public search and booking confirmation cards via `workerPublicSelect` and `toWorkerPublicDTO`. |

---

## 3. ORM Boundary Architecture: Centralized Selects & Explicit DTOs

All queries crossing network boundaries use centralized, type-safe Prisma allow-lists from `src/shared/prismaSelects.ts`:

1. **`workerPublicSelect`**: Allows only `id`, `name`, `skill_type`, `worker_score`, `is_online`, `skill_category_id`.
2. **`workerSelfSelect`**: Allows public fields plus `phone`, `aadhaar_last4`, `verification_status`, `skill_category`. Strictly excludes `password` and `device_token`.
3. **`workerAdminSelect`**: Allows self fields plus operational counters (`decline_count`, `timeout_count`). Excludes `password`, `device_token`, and permanent document URLs.
4. **`customerPublicSelect`**: Allows `id`, `name`, `phone`, `created_at`. Excludes `password` and `deleted_at`.
5. **`customerSummarySelect`**: Allows `id`, `name`, `phone` for nested relation embedding in dispatches, bookings, and jobs. Excludes `password` and `deleted_at`.
6. **`customerSelfSelect`**: Allows `id`, `name`, `phone`, `created_at`. Excludes `password` and `deleted_at`.
7. **`bookingSafeSelect`**: Allows `id`, `job_id`, `requirement_id`, `worker_id`, `customer_id`, `status`, `otp_verified`, timestamps. **Strictly excludes `otp_hash`.**
8. **`paymentSafeSelect`**: Allows `id`, `booking_id`, `razorpay_order_id`, `status`, `amount`. Excludes internal secret fields.

### Explicit DTO Mappers:
- `toWorkerPublicDTO()`
- `toWorkerSelfDTO()`
- `toWorkerAdminDTO()`
- `toCustomerPublicDTO()`
- `toCustomerSummaryDTO()`
- `toCustomerSelfDTO()`
- `toBookingDTO()`
- `toDispatchDTO()`
- `toAuthUserDTO()`

Mappers construct output objects with explicitly allow-listed keys only. No dynamic key reflection or object spread of unverified sources is permitted.

---

## 4. Nested Relation Sanitization

Broad `include: { ... }` queries have been completely eliminated:
- In `bookingServices.getBookingDetail`: Replaced `include: { job: true, worker: true, customer: true, review: true, payment: true, job_requirement: true }` with `select: { ...bookingSafeSelect, worker: { select: workerPublicSelect }, customer: { select: customerSummarySelect }, payment: { select: paymentSafeSelect } }` and wrapped in `toBookingDTO()`.
- In `adminServices.getAllJobs`: Nested customer relation selects only `customerSummarySelect` and maps through `toCustomerSummaryDTO()`.
- In `dispatchServices.getIncomingDispatches` and `getDispatchDetail`: Nested `job.customer` relation selects only `customerSummarySelect` and maps through `toDispatchDTO()`.
- In `workerServices.getBookings`: Customer relation selects only `customerSummarySelect` and booking selects `bookingSafeSelect`.
- In `job.services.getJobBookings`: Top-level booking selects `bookingSafeSelect` (excluding `otp_hash`) with nested worker select.

---

## 5. Authentication & Logging Audit

1. **Authentication Boundary Separation**:
   - `authService.verifyOtp`: Authenticated user entity is transformed to `toAuthUserDTO(user)` containing only `{ id, name, phone }` prior to returning to `auth.controller.ts`. Password hashes never cross the controller boundary.
2. **Logging Sanitization**:
   - Eliminated `console.log(token)` in `workerController.ts`.
   - Audited logs to ensure no passwords, OTPs, tokens, or private document URLs are logged.

---

## 6. OpenAPI / Swagger Schema Alignment

Updated `src/schemas/index.ts`:
- **`WorkerSchema`**: Removed `device_token` and `deleted_at`.
- **`BookingSchema`**: Removed `otp_hash`.
- **`CustomerSchema`**: Removed `deleted_at`.
- **`JobSchema`**: Removed `deleted_at`.

---

## 7. Automated Security Regression Testing

Comprehensive automated tests in `tests/sensitiveDataLeakage.test.ts` enforce:
1. **Sentinel Value Absence**: Tests inject mock records with obvious sentinels (`"DO_NOT_LEAK_PASSWORD_123"`, `"DO_NOT_LEAK_DEVICE_TOKEN_456"`, `"DO_NOT_LEAK_OTP_HASH_789"`) and assert that the serialized response body never contains any sentinel substring.
2. **Recursive Key Absence**: A recursive tree walker inspects every nested key in every JSON response and asserts that prohibited property keys (`password`, `device_token`, `otp_hash`) never appear anywhere.
3. **Coverage**:
   - Worker endpoints: Registration, self profile (`/api/workers/me`), booking list, device token update.
   - Customer endpoints: List (`/api/clients`), create (`/api/clients/add`), self profile (`/api/clients/me`).
   - Booking detail: Full nested fixture with worker, customer, payment, and booking relations.
   - Admin endpoints: Worker list, flagged workers, all jobs with customer relation, document verification, worker suspension.
   - Dispatch endpoints: Incoming dispatches and single dispatch detail with nested customer relations.
   - Auth endpoints: OTP verification response.

---

# Security Analysis: Remediation of P0 Vulnerability — Hard-Coded OTP Verification (Issue #3)

## 1. Executive Summary

This section details the security audit, threat analysis, architectural redesign, and automated regression test validation for **Finding #3 / Issue #3 — OTP verification is hard-coded (Severity: P0 — Release Blocker)**.

The critical security invariant established by this remediation is:
> **An attacker who knows only a user's phone number cannot authenticate without possessing a legitimately generated, delivered, unexpired, single-use OTP. Hard-coded values, predictable seeds, and bypasses are completely eliminated.**

---

## 2. Root Cause Analysis

Prior to this remediation, authentication in `src/features/auth/auth.services.ts` was implemented as:

```typescript
async sendOtp(phone: string, type: "login" | "register") {
  const mockOtp = "123456";
  console.log(`Mock sending OTP ${mockOtp} to ${phone} for ${type}`);
  return { success: true, message: `OTP sent successfully to ${phone}` };
},

async verifyOtp(phone: string, otp: string) {
  if (otp !== "123456") {
    throw new Error("Invalid OTP");
  }
  // ... fetches user and signs JWT ...
}
```

In addition, `src/utils/authUtils.ts` generated OTPs using `Math.floor(100000 + Math.random() * 900000)`, which relies on PRNG algorithms vulnerable to seed prediction.

### Attack Scenarios:
1. **Complete Authentication Bypass**: Any attacker possessing a target user's phone number (worker or customer) could submit `{"phone": "+919876543210", "otp": "123456"}` to `POST /api/auth/verify-otp` and obtain fully authenticated session tokens (`token`, `refreshToken`) without an SMS challenge ever being dispatched.
2. **Account Takeover**: Workers or customers with verified identities could be impersonated trivially.
3. **Indefinite Guessing & Replay**: No attempt bounds or replay protections existed; the static value `"123456"` was perpetually valid.

---

## 3. Remediated Architecture & Cryptographic Controls

### A. Zero-Knowledge Cryptographic Randomness
- Uses Node's `crypto.randomInt(100000, 1000000)` in `src/utils/authUtils.ts`, ensuring uniform entropy without predictable counters or pseudo-random math.
- Fixed-length 6-digit numeric codes strictly validated via Zod regex `/^\d{6}$/`.

### B. Hashed Ephemeral Storage (Bcrypt)
- Plaintext OTP is **never** written to database, logs, or API responses.
- Stored as a salted bcrypt hash (`otp_hash`) in the `otp_challenge` table.

### C. Explicit 5-State OTP Lifecycle
The lifecycle is managed by an explicit state machine:

```
                 ┌────────────────────────┐
                 │        CREATED         │
                 └───────────┬────────────┘
                             │
                             ▼
                 ┌────────────────────────┐
                 │         ACTIVE         │
                 └──────┬────┬────┬───────┘
                        │    │    │
      Correct OTP       │    │    │  TTL Expired (300s)
   + Atomic Verification│    │    │  (checked at verify)
                        │    │    └───────────────────────┐
                        ▼    │                            ▼
          ┌────────────────┐ │                  ┌──────────────────┐
          │    CONSUMED    │ │                  │     EXPIRED      │
          └────────────────┘ │                  └──────────────────┘
                             │
                             │ 5 Incorrect Guesses
                             │ (Atomic Attempt Counter >= MAX)
                             ├────────────────────────────┐
                             │                            ▼
                             │                  ┌──────────────────┐
                             │                  │      LOCKED      │
                             │                  └──────────────────┘
                             │
                             │ New OTP Requested
                             │ (Resend after Cooldown)
                             ▼
                  ┌───────────────────────┐
                  │      INVALIDATED      │
                  └───────────────────────┘
```

### D. Atomic Single-Use Concurrency Safety (PostgreSQL)
- To prevent race conditions under concurrent requests ($N$ simultaneous valid submissions), the verification executes inside `prisma.$transaction`.
- Verification and consumption use conditional atomic updates:
  ```typescript
  const claimResult = await tx.otp_challenge.updateMany({
    where: { id: challenge.id, status: "ACTIVE", consumed_at: null },
    data: { status: "CONSUMED", consumed_at: new Date() },
  });
  if (claimResult.count === 0) throw new Error("Invalid or expired OTP");
  ```
  Under concurrent execution, exactly one transaction successfully updates `status = "CONSUMED"`. All subsequent or racing callers receive `count: 0` and are rejected with HTTP 401.

### E. Database Engine Constraints (Partial Unique Index)
- Enforced via PostgreSQL migration `20260918000000_add_otp_challenge`:
  ```sql
  CREATE UNIQUE INDEX "uniq_active_otp_phone_purpose" 
  ON "otp_challenge" ("phone", "purpose") 
  WHERE "status" = 'ACTIVE';
  ```
  Prevents duplicate concurrent active challenges for the same phone and purpose at the database engine level.

### F. Resend Cooldown & Challenge Invalidation
- Enforces a 60-second cooldown (`OTP_RESEND_COOLDOWN_SECONDS`). Resend requests within the window are rejected with HTTP 429 (`OTP_RESEND_COOLDOWN`).
- Generating a new OTP atomically marks prior active challenges for `(phone, purpose)` as `INVALIDATED`, ensuring an older code cannot be used once a new code is requested.

### G. Attempt Limits & Brute-Force Defense
- Bounded to 5 attempts (`OTP_MAX_ATTEMPTS`).
- Each incorrect attempt atomically increments `attempt_count`.
- Upon reaching 5 failed attempts, the challenge transitions to `LOCKED` (`consumed_at = NOW()`), permanently invalidating it against further attempts.

### H. Purpose Isolation
- OTP challenges are strictly partitioned by authentication context: `login` vs `register`.
- An OTP issued for registration cannot authenticate a login request, and vice versa.

### I. Delivery Failure Safety & Fail-Closed SMS Architecture
- Decoupled `SmsProvider` abstraction (`src/providers/sms/`):
  - `TwilioSmsProvider`: Production implementation calling Twilio REST API with HTTP Basic Auth.
  - `MockSmsProvider`: Strictly isolated to local test/development environments.
- **Production Fail-Closed Rule**: If `NODE_ENV === 'production'`, the server strictly prohibits `MockSmsProvider` and enforces that production SMS credentials exist.
- If SMS gateway dispatch fails, the challenge is immediately updated to `status = 'DELIVERY_FAILED'`, `consumed_at = NOW()`, preventing unreceived codes from existing as valid challenges.

### J. Distributed Rate Limiting & Non-Enumeration
- Redis-backed rate limiting via `src/middlewares/otpRateLimiter.ts`:
  - Max 5 requests per phone per 15 minutes.
  - Max 10 requests per IP per 15 minutes.
  - Max 15 verification attempts per IP per 15 minutes.
- Error responses are uniform and safe (`"Invalid or expired OTP"`), preventing user enumeration.
- Phone numbers in logs and responses are masked (e.g. `+91*****3210`).

---

## 4. Configuration Reference

| Variable | Required in Production | Default | Description |
| :--- | :--- | :--- | :--- |
| `OTP_TTL_SECONDS` | No | `300` | Expiration lifetime of an OTP challenge in seconds (5 minutes). |
| `OTP_MAX_ATTEMPTS` | No | `5` | Maximum failed verification guesses before challenge is locked. |
| `OTP_RESEND_COOLDOWN_SECONDS` | No | `60` | Cooldown window before a new OTP can be requested for the same phone. |
| `OTP_CLEANUP_RETENTION_DAYS` | No | `7` | Retention period before expired OTP records are pruned. |
| `SMS_PROVIDER` | **Yes** | `twilio` (in prod) | Provider adapter: `twilio`, `http`, or `mock` (dev/test only). |
| `TWILIO_ACCOUNT_SID` | If using Twilio | None | Twilio API Account SID. |
| `TWILIO_AUTH_TOKEN` | If using Twilio | None | Twilio API Auth Token. |
| `TWILIO_PHONE_NUMBER` | If using Twilio | None | Registered Twilio dispatch sender phone number. |
| `REDIS_TOKEN` / `REDIS_URL` | **Yes** | Upstash URI | Distributed Redis connection credentials for rate-limiting. |

---

## 5. Code Implementation vs Deployment Prerequisites

| Component | Status in Source Code | Deployment Prerequisite |
| :--- | :--- | :--- |
| **Cryptographic Lifecycle** | **Fully Implemented** | None |
| **PostgreSQL Schema & Migration** | **Fully Implemented** | Run `npx prisma migrate deploy` in target environment |
| **Twilio SMS Provider** | **Fully Implemented** | Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` |
| **Fail-Closed Gatekeeper** | **Fully Implemented** | None |
| **Distributed Rate Limiter** | **Fully Implemented** | Provide `REDIS_TOKEN` / `REDIS_URL` in target environment |
| **Automated Test Matrix** | **100% Passing (99/99 tests)** | None |

---

## 6. Automated Regression Test Verification

Automated verification is covered across `tests/otpSecurity.test.ts`, `tests/api.test.ts`, and `tests/sensitiveDataLeakage.test.ts`:

| Security Test Invariant | Expected Behavior | Result |
| :--- | :--- | :--- |
| **Hard-coded OTP Rejection** | Submitting `"123456"` without issued challenge returns HTTP 401 | **PASS** |
| **Static Patterns Rejection** | Submitting `"000000"`, `"111111"`, `"999999"` returns HTTP 401 | **PASS** |
| **Generated Code Authentication** | Cryptographic random 6-digit OTP authenticates and issues JWT | **PASS** |
| **Single-Use Replay Protection** | Immediate replay of consumed OTP returns HTTP 401 | **PASS** |
| **Attempt Limits Locking** | 5 incorrect guesses lock challenge; 6th attempt with valid OTP fails | **PASS** |
| **TTL Expiration** | Verification after challenge expiration timestamp returns HTTP 401 | **PASS** |
| **Resend Cooldown** | Requesting second OTP within 60 seconds returns HTTP 429 | **PASS** |
| **Resend Invalidation** | Requesting new OTP invalidates prior active OTP | **PASS** |
| **Purpose Isolation** | Registration OTP rejected for Login authentication | **PASS** |
| **Concurrency Safety ($N=5$)** | 5 simultaneous requests: exactly 1 succeeds (200), 4 fail (401) | **PASS** |
| **SMS Failure Safety** | Gateway dispatch failure sets `DELIVERY_FAILED` and blocks verify | **PASS** |
| **Zero Plaintext Leakage** | Plain OTP absent from responses and logs | **PASS** |
| **Input Validation** | Non-numeric or non-6-digit input rejected before DB query | **PASS** |

---

# Security Analysis: Remediation of P0 Vulnerability — Finding #4: JWT Secrets Have Insecure Fallbacks

## 1. Executive Summary

This document details the security audit, root cause analysis, architecture redesign, operational secret management, and automated test validation for the remediation of **Finding #4 — JWT secrets have insecure fallbacks (Severity: P0 — Release Blocker)**.

The critical security invariant established by this remediation is:
> **Zero Fallback Credentials: The backend strictly prohibits hard-coded, default, or dynamic fallback secrets. Application startup halts immediately if required cryptographically independent JWT secrets (`JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET`) are missing, weak, or identical.**

---

## 2. Root Cause Analysis

Prior to this remediation, JWT signing and verification throughout the codebase relied on vulnerable fallback strings when environment variables were absent:

1. **`src/utils/authUtils.ts` (line 6)**:
   ```typescript
   const JWT_SECRET = process.env.JWT_SECRET || "default_secret_key";
   ```
2. **`src/features/auth/auth.services.ts` (lines 9–10)**:
   ```typescript
   const JWT_SECRET = process.env.JWT_SECRET || "fallback_secret_key";
   const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "fallback_refresh_key";
   ```

### Severe Vulnerabilities Introduced by This Anti-Pattern:
1. **Silent Production Failure & Token Forgery**: If deployment orchestration (Docker, Kubernetes, systemd, or `.env`) failed to inject JWT secrets, the application booted cleanly and signed all authentication tokens with publicly known repository strings. An attacker could trivially forge valid administrative tokens (`UserRole.ADMIN`) with zero network credentials.
2. **Secret Desynchronization & Silent Auth Outage**: In an unconfigured environment, `auth.services.ts` signed access tokens with `"fallback_secret_key"`, whereas `authUtils.ts` (invoked by `authMiddleware.ts`) attempted verification with `"default_secret_key"`. Consequently, freshly issued tokens immediately failed verification on protected routes.
3. **Shared Secret / Lack of Token Isolation**: Access tokens and refresh tokens shared the same secret or lacked cryptographic isolation. Refresh tokens could be submitted as access tokens or vice versa, violating the principle of least privilege.
4. **Scattered Environment Access**: Environment variables were read dynamically and ad-hoc across disparate service files rather than through a centralized, validated configuration boundary.

---

## 3. Cryptographic & Architectural Redesign

### A. Centralized Validated Configuration (`src/config/authConfig.ts`)
A dedicated configuration and validation module manages all JWT parameters:
- `validateJwtSecret(secret, varName)`:
  - Rejects missing, undefined, null, empty string, or whitespace-only inputs.
  - Rejects known repository fallbacks and common weak words (`default_secret_key`, `fallback_secret_key`, `fallback_refresh_key`, `secret`, `password`, `123456`, etc.).
  - Enforces a minimum secret-length requirement of **32 characters** (HMAC-SHA256 key security requirement). *(Note: minimum length is an essential structural constraint; actual entropy relies on cryptographically random generation such as `openssl rand -hex 32`)*.
- `assertJwtConfig()` / `getJwtConfig()`:
  - Requires valid `JWT_ACCESS_SECRET` (with legacy transitional support for `JWT_SECRET` if valid and non-empty).
  - Requires valid `JWT_REFRESH_SECRET`.
  - Strictly enforces `accessSecret !== refreshSecret`.
  - Locks cryptographic algorithm to `HS256`.
  - Completely scrubs secret contents from error messages (e.g. `[SECURITY ERROR] Required environment variable 'JWT_ACCESS_SECRET' is missing`).

### B. Fail-Fast Startup Gatekeeper (`src/server.ts`)
During application bootstrap in `startServer()`:
1. `assertJwtConfig()` executes before connecting to PostgreSQL or binding the HTTP listener.
2. If any JWT configuration requirement fails, the process immediately logs `[STARTUP ERROR]` and exits (`process.exit(1)`), guaranteeing no unauthenticated or insecure server process accepts network traffic.

### C. Cryptographic Secret Separation & Purpose Isolation (`src/utils/authUtils.ts`)
- **Access Tokens**:
  - Signed using `JWT_ACCESS_SECRET` with algorithm `HS256` (`signAccessToken`).
  - Embedded claim: `token_type: "access"`.
  - Verified exclusively with `JWT_ACCESS_SECRET` (`verifyAccessToken`).
  - Rejects tokens where `token_type !== "access"`.
- **Refresh Tokens**:
  - Signed using `JWT_REFRESH_SECRET` with algorithm `HS256` (`signRefreshToken`).
  - Embedded claim: `token_type: "refresh"`.
  - Verified exclusively with `JWT_REFRESH_SECRET` (`verifyRefreshToken`).
  - Rejects tokens where `token_type !== "refresh"`.
- **Cross-Token Rejection**:
  - Submitting an access token to `verifyRefreshToken` or `POST /api/auth/refresh` fails verification.
  - Submitting a refresh token to `verifyAccessToken` or any `authenticateJWT` protected route fails verification.

---

## 4. Configuration Reference

| Variable | Required in Production | Default | Description |
| :--- | :--- | :--- | :--- |
| `JWT_ACCESS_SECRET` | **Yes** | *None (fail-fast)* | Cryptographically random secret for signing 1-hour access tokens. Minimum 32 characters. |
| `JWT_REFRESH_SECRET` | **Yes** | *None (fail-fast)* | Cryptographically random secret for signing 7-day refresh tokens. Minimum 32 characters. Must be distinct from access secret. |
| `JWT_ACCESS_EXPIRES_IN` | No | `1h` | Expiration window for access tokens. |
| `JWT_REFRESH_EXPIRES_IN` | No | `7d` | Expiration window for refresh tokens. |
| `JWT_SECRET` | Transitional | *None* | Legacy variable; accepted as fallback for `JWT_ACCESS_SECRET` during migration if it satisfies all security validation criteria. |

---

## 5. Operational Secret Management & Rotation Procedure

### Generating Cryptographically Secure Secrets
Production secrets must never be hard-coded, committed to Git, or generated from predictable patterns. Generate secrets using:
```bash
openssl rand -hex 32
```
This produces a 64-hexadecimal-character string providing 256 bits of cryptographic entropy.

### Secret Storage
Production credentials must reside exclusively in managed secret stores:
- AWS Secrets Manager / Parameter Store
- HashiCorp Vault
- Doppler / GCP Secret Manager / Azure Key Vault
- Environment injection in CI/CD pipeline deployment targets

### Secret Rotation Procedure (Standard / Immediate Invalidation)
The LabourBaba backend currently signs and validates tokens using symmetric HMAC-SHA256 without multi-key ID (`kid`) negotiation. Consequently, rotating active secrets invalidates outstanding tokens signed with the previous secret.

**Operational Steps for Rotation**:
1. **Generate New Secrets**:
   ```bash
   NEW_ACCESS_SECRET=$(openssl rand -hex 32)
   NEW_REFRESH_SECRET=$(openssl rand -hex 32)
   ```
2. **Stage Secrets in Secret Manager**: Update `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` in deployment configuration.
3. **Deploy / Restart Application Instances**: Perform rolling restart across backend container fleet.
4. **Authentication Impact**:
   - Outstanding access tokens will be rejected (HTTP 401), prompting clients to refresh.
   - Outstanding refresh tokens will be rejected (HTTP 401), prompting users to re-authenticate via OTP or credentials.
5. **Post-Deployment Verification**:
   - Verify health check (`GET /health`).
   - Execute test login and token refresh flows.

---

## 6. Distinction from Remaining Related Findings

Remediating Finding #4 resolves secret quality, fallback elimination, fail-fast validation, and access/refresh cryptographic separation. It does **not** solve all token lifecycle concerns. The following related findings remain tracked independently in the audit backlog:

- **Finding #68 — Refresh Token Rotation & Reuse Detection**: Refresh tokens are currently reusable until expiration (`7d`) without database-backed family tracking or reuse invalidation.
- **Finding #69 — Session Revocation & Centralized Token Blacklist**: The logout endpoint currently returns `{ success: true }` without adding JWTs to a distributed Redis revocation blocklist.
- **Finding #70 — Account Suspension Token Invalidation**: Suspending a worker or customer does not immediately revoke previously issued unexpired access tokens until token expiration.

---

## 7. Automated Regression Test Verification

Automated regression coverage is established in `tests/jwtSecurity.test.ts` (42 tests, 100% passing) and verified across the full 141-test suite:

| Security Invariant Tested | Test Case / Scenario | Result |
| :--- | :--- | :--- |
| **Fail-Fast Missing Access Secret** | Unset `JWT_ACCESS_SECRET` and `JWT_SECRET` halts startup with `[SECURITY ERROR]` | **PASS** |
| **Fail-Fast Missing Refresh Secret** | Unset `JWT_REFRESH_SECRET` halts startup with `[SECURITY ERROR]` | **PASS** |
| **Empty Secret Rejection** | Empty string (`""`) or whitespace (`"   "`) rejected | **PASS** |
| **Known Insecure Defaults Rejection** | Rejects `default_secret_key`, `fallback_secret_key`, `fallback_refresh_key`, `secret`, `password`, `123456`, `test-secret` | **PASS** |
| **Minimum Length Validation** | Secrets shorter than 32 characters rejected | **PASS** |
| **Identical Secrets Rejection** | Configuration fails if `JWT_ACCESS_SECRET === JWT_REFRESH_SECRET` | **PASS** |
| **Access Token Signing & Verification** | Access tokens signed with access secret verify with access secret | **PASS** |
| **Refresh Token Signing & Verification** | Refresh tokens signed with refresh secret verify with refresh secret | **PASS** |
| **Cross-Secret Rejection** | Access token fails verification against refresh secret; Refresh token fails verification against access secret | **PASS** |
| **Purpose Isolation Rejection** | Access token rejected by `verifyRefreshToken`; Refresh token rejected by `verifyAccessToken` | **PASS** |
| **Zero Secret Leakage** | Validation errors and exception payloads never contain secret values | **PASS** |
| **HTTP Protected Route Integration** | Access token grants entry; Refresh token returns HTTP 401 | **PASS** |
| **HTTP Refresh Route Integration** | Access token returns HTTP 401; Valid refresh token issues new access token with `token_type: "access"` | **PASS** |
| **Backward-Compatibility Wrappers** | Legacy `generateToken` and `verifyToken` continue functioning securely | **PASS** |

---

# Security Analysis: Remediation of P0 Vulnerability — Finding #5: Socket.IO Accepts Client-Supplied Identity

## 1. Executive Summary

This document details the security audit, root cause analysis, architecture redesign, and automated test validation for the remediation of **Finding #5 — Socket.IO accepts client-supplied identity (Severity: P0 — Release Blocker)**.

The critical security invariant established by this fix is:
> **Client-Supplied Identity Is Never Authoritative: Sockets are cryptographically authenticated during the connection handshake via a verified JWT access token. The authenticated principal (`socket.data.user`) serves as the sole, authoritative source of identity for all room subscriptions, location broadcasts, and message delivery. Client attempts to specify or spoof another user's identity are strictly rejected.**

---

## 2. Root Cause Analysis

Prior to this remediation, Socket.IO in `src/server.ts` lacked handshake authentication and trusted client-provided parameters across all handlers:

1. **Zero Connection Authentication**:
   `io.on("connection", (socket) => ...)` was registered without any authentication middleware. Any arbitrary internet client could establish a WebSocket connection.
2. **Arbitrary Room Eavesdropping (`join:worker` & `join:customer`)**:
   ```typescript
   socket.on("join:worker", (workerId: string) => {
     socket.join(`worker:${workerId}`);
   });
   socket.on("join:customer", (customerId: string) => {
     socket.join(`customer:${customerId}`);
   });
   ```
   Any client could supply another worker's UUID or customer's UUID. As a result:
   - An attacker joining `worker:<target_id>` intercepted incoming job offers (`job:incoming`), which contained customer phone numbers, pickup/drop coordinates, and pricing.
   - An attacker joining `customer:<target_id>` intercepted booking updates and live worker tracking events (`worker:location`).
3. **Location Spoofing in `worker:location_update`**:
   ```typescript
   socket.on("worker:location_update", async ({ workerId, customerId, lat, lng }) => {
     io.to(`customer:${customerId}`).emit("worker:location", { workerId, lat, lng });
   });
   ```
   The handler accepted `workerId` directly from the client payload without verifying if the sender was actually that worker, or even a worker at all. Any user could forge live GPS coordinates for any worker.

---

## 3. Cryptographic & Architectural Redesign

### A. Handshake Authentication Middleware (`src/socket/socketAuth.ts`)
Socket.IO connection requests must present a valid JWT access token in `socket.handshake.auth.token` or the `Authorization: Bearer <token>` header:
- Validates token signature with `JWT_ACCESS_SECRET` via `verifyAccessToken`.
- Enforces `HS256` algorithm and `token_type: "access"`. Refresh tokens are strictly rejected.
- Resolves the principal in PostgreSQL (`prisma.worker` or `prisma.customer`) and verifies the account is active (`deleted_at == null`).
- Attaches the verified principal to `socket.data.user`:
  ```typescript
  export interface SocketUserData {
    id: string;
    role: UserRole;
    phone?: string;
  }
  ```
- Rejects unauthenticated connections with safe error messages (`"Authentication required"`, `"Invalid authentication credentials"`).

### B. Automatic Personal Room Membership (`src/socket/socketHandlers.ts`)
Personal rooms are established automatically upon successful connection:
- `UserRole.WORKER` → automatically joins `worker:${socket.data.user.id}`.
- `UserRole.CUSTOMER` → automatically joins `customer:${socket.data.user.id}`.
- `UserRole.ADMIN` → automatically joins `admin:${socket.data.user.id}` and `admins`.
Clients no longer need to emit `join:worker` or `join:customer`.

### C. Rejection of Identity Spoofing & Room Impersonation
- If a client emits `join:worker` or `join:customer`:
  - Must possess the required role (`WORKER` or `CUSTOMER`).
  - If a target ID is passed, it must strictly match `socket.data.user.id`. Any attempt to supply another user's ID is rejected with `FORBIDDEN`.
- Non-workers are blocked from worker-only rooms and events.

### D. Authorized Location Updates (`worker:location_update`)
- The authoritative worker identity is strictly `socket.data.user.id`. Any `workerId` in the client payload is checked and cannot override the authenticated identity.
- Enforces role `UserRole.WORKER`.
- Enforces an active database relationship: Worker must have an active booking (`assigned`, `accepted`, `in_progress`, `arrived`, `confirmed`) with the target customer before a location update can be broadcast.

### E. Database-Backed Booking & Chat Authorization
- Joining booking rooms (`join:booking`) requires database verification that the authenticated user is either the customer, the assigned worker, or an administrator (`booking.customer_id === user.id || booking.worker_id === user.id || user.role === ADMIN`).
- Chat message delivery (`chat:message`) enforces participant authorization and uses `socket.data.user.id` as the authoritative sender.

---

## 4. Identity Trust Model

| Value | Origin | Trust Level | Usage |
| :--- | :--- | :--- | :--- |
| `socket.data.user.id` | Verified JWT access token | **Authoritative (Trusted)** | Room routing, event attribution, sender identity |
| `socket.data.user.role` | Verified JWT access token | **Authoritative (Trusted)** | Role-based event guards |
| `payload.workerId` | Client payload | **Untrusted** | Checked against `user.id`; rejected on mismatch |
| `payload.customerId` | Client payload | **Untrusted** | Validated against database assignment records |
| `payload.bookingId` | Client payload | **Untrusted** | Verified against participant database records |

---

## 5. Automated Regression Test Verification

Automated regression coverage is established in `tests/socketSecurity.test.ts` (23 tests, 100% passing):

| Security Invariant Tested | Test Case / Scenario | Result |
| :--- | :--- | :--- |
| **Missing Token Rejection** | Connection without token rejected with `"Authentication required"` | **PASS** |
| **Malformed Token Rejection** | Connection with malformed JWT rejected | **PASS** |
| **Invalid Signature Rejection** | Token signed with unknown key rejected | **PASS** |
| **Expired Token Rejection** | Token with past `exp` rejected | **PASS** |
| **Refresh Token Rejection** | Refresh token (`token_type: "refresh"`) rejected | **PASS** |
| **Deleted User Rejection** | Token for soft-deleted worker (`deleted_at != null`) rejected | **PASS** |
| **Valid Worker Handshake** | Valid worker token accepted; auto-joins `worker:<id>` | **PASS** |
| **Valid Customer Handshake** | Valid customer token accepted; auto-joins `customer:<id>` | **PASS** |
| **Valid Admin Handshake** | Valid admin token accepted; auto-joins `admin:<id>` | **PASS** |
| **Worker Room Spoofing Defense** | Worker A attempting `join:worker` with Worker B's ID rejected (`FORBIDDEN`) | **PASS** |
| **Customer Room Spoofing Defense** | Customer A attempting `join:customer` with Customer B's ID rejected (`FORBIDDEN`) | **PASS** |
| **Customer Role Violation** | Customer attempting `join:worker` rejected (`FORBIDDEN`) | **PASS** |
| **Worker Role Violation** | Worker attempting `join:customer` rejected (`FORBIDDEN`) | **PASS** |
| **Location Update Non-Worker Defense** | Customer attempting `worker:location_update` rejected (`FORBIDDEN`) | **PASS** |
| **Location Identity Spoofing Defense** | Worker A sending `workerId: Worker B` rejected (`FORBIDDEN`) | **PASS** |
| **Location Unassigned Target Defense** | Worker A sending location to unassigned Customer B rejected (`FORBIDDEN`) | **PASS** |
| **Authorized Location Broadcast** | Assigned Worker B sends location to Customer B; event delivers with authoritative Worker B ID | **PASS** |
| **Booking Room Customer Impersonation** | Customer A attempting to join Booking B room rejected (`FORBIDDEN`) | **PASS** |
| **Booking Room Worker Impersonation** | Worker A attempting to join Booking B room rejected (`FORBIDDEN`) | **PASS** |
| **Authorized Booking Access** | Legitimate Customer B and Worker B permitted into Booking B room | **PASS** |
| **Chat Message Intruder Defense** | Unauthorized Customer A sending message on Booking B rejected (`FORBIDDEN`) | **PASS** |
| **Authorized Chat Delivery** | Legitimate Customer B sends message; delivered with authoritative `sender_id` | **PASS** |


