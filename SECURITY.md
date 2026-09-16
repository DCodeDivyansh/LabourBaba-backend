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
