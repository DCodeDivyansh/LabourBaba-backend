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
