# LabourBaba Backend — Authorization Policy Architecture & Reference Guide

## 1. Executive Summary

This document defines the canonical authorization architecture for the LabourBaba Backend. 

Prior to this remediation (Issue #3 / Audit findings #1, #16–21, #25–29), authorization logic was fragmented across controllers, services, and route handlers. In some cases, knowing a resource UUID alone granted read or write access; in others, client-supplied query parameters or body attributes were mistakenly consulted to determine ownership.

The backend now enforces **One Canonical Authorization Policy Layer** located at `src/policies/`. All resource-level authorization decisions, query scoping predicates, and relationship validations are centralized into pure, testable, and reusable policy modules.

---

## 2. Fundamental Security Invariants

### 2.1. Authoritative Identity Derivation
The identity of the requesting principal is **exclusively** derived from cryptographically verified tokens:
- **HTTP Requests:** Extracted by `authenticateJWT` and attached to `(req as AuthenticatedRequest).user`.
- **Socket.IO Connections:** Validated during handshake by `socketAuthMiddleware` and attached to `socket.data.user`.

> [!CAUTION]
> **Client-Controlled Identifiers are NEVER Trusted**: Any `customer_id`, `worker_id`, `user_id`, or `actor_id` sent in request bodies, query strings, or headers is strictly neutralized, rejected, or ignored.

### 2.2. Two-Stage Authorization: Role vs Relationship
Authorization in LabourBaba is strictly a two-phase check:
1. **Stage 1: Role Authorization (`requireRole`)**:
   Executed as early route middleware. Rejects requests where the actor's system role (e.g. `UserRole.CUSTOMER`, `UserRole.WORKER`, `UserRole.ADMIN`) does not possess category-level permission for the route.
2. **Stage 2: Resource Relationship Authorization (`src/policies/`)**:
   Enforced at the service or controller boundary. Validates that the authenticated principal has a valid, database-backed relationship with the specific target resource (e.g. is the customer who created the job, is the worker assigned to the booking).

### 2.3. Anti-Enumeration & IDOR Oracle Prevention (403 vs 404 Policy)
To prevent malicious callers from discovering valid UUIDs of resources belonging to other users:
- **403 Forbidden:** Returned when an actor's authenticated role is structurally disallowed from performing an action, or when action constraints fail on an authorized resource state.
- **404 Not Found:** Returned when an actor attempts to access an individual resource (Job, Requirement, Booking, Chat, Review) that belongs to another tenant or customer. The application responds as if the resource does not exist, eliminating existence oracle vulnerabilities.

### 2.4. Unified HTTP & Real-Time Socket Semantics
A user cannot bypass an HTTP restriction by using WebSocket connections, or vice versa. The policy layer (`chatPolicy`, `workerPolicy`, `bookingPolicy`) is shared directly between Express controllers and Socket.IO event handlers.

---

## 3. Policy Architecture & Resource Matrix

```
                          [ Incoming Request ]
                                   │
                                   ▼
                 [ authenticateJWT / socketAuth ]
                 (Cryptographically validates token,
                   attaches trusted actor identity)
                                   │
                                   ▼
                      [ requireRole Middleware ]
                 (Verifies actor role has permission)
                                   │
                                   ▼
                      [ Validation Middleware ]
                     (Zod schema validation, strip
                       unauthorized identity params)
                                   │
                                   ▼
                       [ Controller / Handler ]
                                   │
                                   ▼
                       [ Canonical Policy Layer ]
                         (`src/policies/*.ts`)
                                   │
            ┌──────────────────────┴──────────────────────┐
            ▼                                             ▼
   [ assertPolicy(policy.canAction) ]             [ policy.scopeRead / scopeList ]
      (Predicate checks on entity)                  (DB-level query scoping)
            │                                             │
            └──────────────────────┬──────────────────────┘
                                   │
                                   ▼
                       [ PostgreSQL (Prisma) ]
```

### 3.1. Policy Matrix

| Resource | Action | Role | Relationship Invariant | Scoping Rule (`where`) | Denied Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Job** | `canCreate` | Customer | Any active customer | N/A | 403 |
| **Job** | `canRead` | Customer | `job.customer_id === actor.id` | `{ customer_id: actor.id }` | 404 |
| **Job** | `canRead` | Worker | Has active dispatch/booking for job | N/A | 404 |
| **Job** | `canRead` | Admin | Any job | `{}` | N/A |
| **Job** | `canCancel` | Customer | `job.customer_id === actor.id` and status not completed/cancelled | N/A | 403 / 404 |
| **Job** | `canCreateReq` | Customer | `job.customer_id === actor.id` | N/A | 403 / 404 |
| **Job** | `canReadBookings` | Customer | `job.customer_id === actor.id` | N/A | 404 |
| **Requirement** | `canRead` | Customer | Owns parent job | N/A | 404 |
| **Requirement** | `canRead` | Worker | Assigned/dispatched to requirement | N/A | 404 |
| **Booking** | `canRead` | Customer | `booking.customer_id === actor.id` | `{ customer_id: actor.id }` | 404 |
| **Booking** | `canRead` | Worker | `booking.worker_id === actor.id` | `{ worker_id: actor.id }` | 404 |
| **Booking** | `canVerifyOtp` | Worker | Assigned worker only (`worker_id === actor.id`) | N/A | 403 / 404 |
| **Booking** | `canComplete` | Worker | Assigned worker only and status `IN_PROGRESS` | N/A | 403 / 404 |
| **Booking** | `canConfirm` | Customer | Owning customer only and status `COMPLETED` | N/A | 403 / 404 |
| **Booking** | `canCancel` | Customer/Worker | Either participant, non-terminal state | N/A | 403 / 404 |
| **Dispatch** | `canRead` | Worker | Dispatched worker only (`worker_id === actor.id`) | `{ worker_id: actor.id }` | 404 |
| **Dispatch** | `canAccept` | Worker | `worker_id === actor.id` and status `PENDING` | N/A | 403 |
| **Dispatch** | `canDecline` | Worker | `worker_id === actor.id` and status `PENDING` | N/A | 403 |
| **Chat** | `canRead` | Customer/Worker | Participant of underlying booking | N/A | 403 / 404 |
| **Chat** | `canSend` | Customer/Worker | Participant of underlying booking | N/A | 403 / 404 |
| **Chat** | `canJoinRoom` | Customer/Worker | Participant of underlying booking | N/A | 403 |
| **Payment** | `canCreateOrder`| Customer | Owning customer of booking | N/A | 403 / 404 |
| **Payment** | `canRead` | Customer | Owning customer of payment | `{ customer_id: actor.id }` | 404 |
| **Payment** | `canRefund` | Admin | Explicit Admin role only | N/A | 403 |
| **Review** | `canCreate` | Customer | Owning customer, booking `COMPLETED`, unreviewed | N/A | 403 / 409 |
| **Review** | `canReadBooking`| Customer/Worker | Either participant or Admin | N/A | 403 / 404 |
| **Worker** | `canReadSelf` | Worker | Self only (`actor.id === worker.id`) | N/A | 403 |
| **Worker** | `canReadDocs` | Worker/Admin | Self or Admin. Customers strictly forbidden | N/A | 403 |
| **Worker** | `canUploadDocs`| Worker | Self only (`actor.id === worker.id`) | N/A | 403 |

---

## 4. Policy Implementation Modules

All policies are located in `src/policies/`:

| Policy Module | Exported Policy | Responsibility |
| :--- | :--- | :--- |
| `src/policies/types.ts` | `PolicyActor`, `AuthorizationError`, `assertPolicy` | Common contracts, type definitions, assertion helpers |
| `src/policies/job.policy.ts` | `jobPolicy` | Job lifecycle, requirements creation, booking visibility |
| `src/policies/requirement.policy.ts` | `requirementPolicy` | Requirement inspection and relationship scope |
| `src/policies/booking.policy.ts` | `bookingPolicy` | Booking detail, OTP verification, completion, cancellation |
| `src/policies/dispatch.policy.ts` | `dispatchPolicy` | Dispatch acceptance, decline, and worker scoping |
| `src/policies/chat.policy.ts` | `chatPolicy` | Real-time chat messages, HTTP history, room membership |
| `src/policies/payment.policy.ts` | `paymentPolicy` | Razorpay order creation, payment lookup, refunds |
| `src/policies/review.policy.ts` | `reviewPolicy` | Review authoring, booking review visibility |
| `src/policies/worker.policy.ts` | `workerPolicy` | Location updates, document privacy, admin verification |
| `src/policies/index.ts` | Barrel Export | Clean unified import for the rest of the application |

---

## 5. Developer Guide: How to Secure a New Endpoint

When creating a new route or modifying an existing service, follow this mandatory 4-step workflow:

### Step 1: Add Route-Level Role Guard
```typescript
// Example: src/features/myFeature/myRoutes.ts
router.post(
  "/:resourceId/action",
  authenticateJWT,
  requireRole(UserRole.CUSTOMER), // Or WORKER, ADMIN
  validateBody(MyActionSchema),
  myControllerAction
);
```

### Step 2: Ensure Controller Derives Identity from Principal
```typescript
// Example: src/features/myFeature/myController.ts
export const myControllerAction = async (req: Request, res: Response): Promise<void> => {
  try {
    const actor = (req as AuthenticatedRequest).user;
    if (!actor?.id) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }
    const { resourceId } = req.params as any;
    const result = await myService.doAction(resourceId, actor);
    res.status(200).json({ success: true, data: result });
  } catch (error: any) {
    if (error instanceof AuthorizationError) {
      res.status(error.status).json({ success: false, message: error.message });
      return;
    }
    // Map other application errors...
  }
};
```

### Step 3: Implement or Reuse Policy Method
In `src/policies/`:
```typescript
canDoAction(actor: AuthenticatedUser, resource: MyResource): PolicyDecision {
  if (actor.role !== UserRole.CUSTOMER) {
    return { allowed: false, reason: "Forbidden: Customer role required", statusCode: 403 };
  }
  if (resource.customer_id !== actor.id) {
    // Return 404 to avoid leaking resource existence
    return { allowed: false, reason: "Resource not found", statusCode: 404 };
  }
  return { allowed: true };
}
```

### Step 4: Invoke `assertPolicy` or Use Database Query Scoping
```typescript
// Example in service layer:
const resource = await prisma.myResource.findUnique({ where: { id: resourceId } });
if (!resource) throw new Error("Resource not found");

// Enforce policy
assertPolicy(myPolicy.canDoAction(actor, resource));

// Proceed with business logic...
```

---

## 6. Verification and Regression Testing

The authorization policy layer is covered by automated regression test suites:
- `tests/policies/authorizationPolicies.test.ts`: Pure unit tests for all 8 policy modules across allowed and denied permutations.
- `tests/crossResourceSecurity.test.ts`: Integration test suite covering cross-resource access, UUID secrecy, IDOR prevention, and role isolation.
- `tests/socketAuthorization.test.ts`: Integration tests verifying handshake authentication, personal room isolation, room join authorization, and chat message participant verification.
- `tests/jobSecurity.test.ts`: Job creation, listing, detail, cancellation, and customer scoping tests.
- `tests/reviewSecurity.test.ts`: Review authoring, booking ownership, state verification, and idempotency tests.
- `tests/apiProtection.test.ts`: End-to-end API protection matrix and JWT claim validation.
