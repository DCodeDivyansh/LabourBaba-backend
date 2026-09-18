# Production Readiness Audit Finding — Issue #3: Create One Authorization Policy Layer

| Field | Detail |
| :--- | :--- |
| **Remediation Issue** | Issue #3 — Create One Authorization Policy Layer |
| **Audit Findings Mapped** | Audit Findings #1, #16–21, #25–29 |
| **Priority / Severity** | P0 / P1 — Release Blocker |
| **Roadmap Phase** | Phase A — Identity & Authorization |
| **Current Status** | **RESOLVED & VERIFIED** |
| **Affected Components** | Policy Layer (`src/policies/`), Controllers (`job`, `booking`, `chat`, `review`, `worker`), Routes (`jobRoutes`, `bookingRoutes`, `chatRoutes`, `workerRoutes`), Socket.IO Handlers (`src/socket/socketHandlers.ts`) |

---

## 1. Problem Statement & Audit Context

The Production Readiness Audit identified pervasive authorization anti-patterns across the LabourBaba backend codebase:
1. **Ad-hoc Authorization Checks:** Controllers and services independently implemented custom, conflicting ownership checks or omitted them entirely.
2. **UUID-as-Authorization (IDOR):** In numerous endpoints (e.g. `GET /api/jobs/:jobId`, `GET /api/bookings/:bookingId`, `GET /api/chat/:bookingId/messages`, `GET /api/reviews/:bookingId`), knowing a resource UUID alone was treated as sufficient authorization to inspect or manipulate the entity.
3. **Client-Controlled Identity Parameters:** In various places, query parameters (`?customer_id=...`, `?worker_id=...`) or body fields were accepted to filter data or establish ownership, opening trivial horizontal privilege escalation.
4. **Disjointed Protocol Semantics:** Socket.IO event handlers (`join:booking`, `chat:message`, `join:customer`, `join:worker`) did not share the same authorization invariants as HTTP endpoints, permitting clients to bypass HTTP controls via socket rooms.
5. **Resource Existence Oracles:** Accessing unowned resources frequently returned 403 Forbidden with messages like "You do not own this job", allowing attackers to enumerate valid UUIDs of other customers.

---

## 2. Technical Architecture & Design Decisions

### 2.1. Dedicated, Reusable Policy Layer (`src/policies/`)
A centralized policy package was established with zero runtime dependencies beyond types:
- `src/policies/types.ts`: Common types (`PolicyActor`, `PolicyDecision`, `AuthorizationError`, `assertPolicy`).
- `src/policies/job.policy.ts`: Job lifecycle and requirement management.
- `src/policies/requirement.policy.ts`: Requirement lookup and parent job ownership.
- `src/policies/booking.policy.ts`: Booking detail, OTP verification, completion, cancellation.
- `src/policies/dispatch.policy.ts`: Dispatch acceptance, rejection, and query scoping.
- `src/policies/chat.policy.ts`: Chat conversation reading, sending, and room membership.
- `src/policies/payment.policy.ts`: Payment order creation, lookup, and refund authorization.
- `src/policies/review.policy.ts`: Booking review authoring and viewing permissions.
- `src/policies/worker.policy.ts`: Worker document privacy, self-profile management, location updates, and admin actions.
- `src/policies/index.ts`: Barrel export.

### 2.2. Strict Separation: Role-Based vs Relationship-Based Checks
- **Role Authorization (`requireRole`)**: Route-level middleware halts requests before they reach business logic if the caller lacks the required role.
- **Resource Relationship Authorization (`policy.*`)**: Evaluates specific entity ownership (e.g., `job.customer_id === actor.id`, `booking.worker_id === actor.id`).

### 2.3. Query Scoping (`scopeRead` / `findFirst`) vs Fetch-and-Filter
Wherever possible, database-level query scoping is used (`bookingPolicy.scopeRead(actor, id)`, `jobPolicy.scopeRead(actor, id)`). Rather than fetching all records into Node.js memory and filtering, the database query includes the ownership predicate.

### 2.4. IDOR Protection (404 vs 403)
When an actor attempts to access an individual entity belonging to another user, policies return `{ allowed: false, reason: "Resource not found", statusCode: 404 }`. This conceals the existence of the entity from unauthorized callers.

---

## 3. Remediated Files & Implementation Details

### 3.1. Policy Modules Created
1. `src/policies/types.ts`: Defines `AuthorizationError` which provides both `.statusCode` and `.status` for seamless Express integration, and `assertPolicy()` which throws on denial.
2. `src/policies/job.policy.ts`: Implements `canCreate`, `canRead`, `canCancel`, `canCreateRequirement`, `canReadBookings`, `scopeRead`, and `scopeList`.
3. `src/policies/booking.policy.ts`: Implements `canRead`, `canVerifyOtp`, `canComplete`, `canConfirmCompletion`, `canCancel`, `canGetWorkerLocation`, and `scopeRead`.
4. `src/policies/chat.policy.ts`: Implements `canReadConversation`, `canSendMessage`, and `canJoinRoom`.
5. `src/policies/dispatch.policy.ts`: Implements `canRead`, `canAccept`, `canDecline`, and `scopeRead`.
6. `src/policies/payment.policy.ts`: Implements `canCreateOrder`, `canRead`, and `canRefund`.
7. `src/policies/review.policy.ts`: Implements `canCreate`, `canReadBookingReview`, and `canReadWorkerReviews`.
8. `src/policies/worker.policy.ts`: Implements `canReadSelf`, `canUpdateSelf`, `canUpdateLocation`, `canReadDocuments`, `canUploadDocuments`, `canAdminVerify`, and `canAdminSuspend`.

### 3.2. Controllers & Services Updated
1. `src/features/jobs/job.services.ts` & `jobController.ts`:
   - Enforced `jobPolicy.canRead(actor, job)` in `getJobDetail`.
   - Enforced `jobPolicy.canCancel(actor, job)` in `cancelJob`.
   - Enforced `jobPolicy.canRead(actor, job)` in `getJobRequirements`.
   - Enforced `jobPolicy.canReadBookings(actor, job)` in `getJobBookings`.
   - All controllers map `AuthorizationError` to proper HTTP status codes (403/404).
2. `src/features/jobs/jobReqServices.ts`:
   - `createJobReq` asserts `jobPolicy.canCreateRequirement(actor, job)`.
3. `src/features/booking/bookingServices.ts` & `bookingController.ts`:
   - Enforced `bookingPolicy.scopeRead` and `bookingPolicy.canRead(actor, booking)` in `getBookingDetail`.
   - Enforced `bookingPolicy.canVerifyOtp(actor, booking)` in `verifyOtp`.
   - Enforced `bookingPolicy.canComplete(actor, booking)` in `completeBooking`.
   - Enforced `bookingPolicy.canConfirmCompletion(actor, booking)` in `confirmComplete`.
   - Enforced `bookingPolicy.canCancel(actor, booking)` in `cancelBooking`.
4. `src/features/chat/chatServices.ts` & `chatController.ts`:
   - Enforced `chatPolicy.canReadConversation(actor, booking)` in `getMessages`.
   - Enforced `chatPolicy.canSendMessage(actor, booking)` in `sendMessage`.
5. `src/features/review/reviewServices.ts` & `reviewController.ts`:
   - Enforced `reviewPolicy.canReadBookingReview(actor, booking)` in `getBookingReview`.
6. `src/features/worker/workerRoutes.ts` & `workerController.ts`:
   - Guarded all worker self endpoints (`/me`, `/me/online`, `/me/documents`, `/me/analytics`, `/me/bookings`, `/me/earnings`, `/me/device-token`) with `requireRole(UserRole.WORKER)`.
   - In `workerController.ts`, asserted `workerPolicy.canReadDocuments` and `workerPolicy.canUploadDocuments`.
7. `src/socket/socketHandlers.ts`:
   - Wired `chatPolicy.canJoinRoom(user, booking)` into `join:booking`.
   - Passed authenticated `user` to `chatService.sendMessage(..., user)` in `chat:message`.
   - Enforced personal room isolation and rejected spoofed `workerId`/`customerId` in `join:worker`, `join:customer`, and `worker:location_update`.

---

## 4. Verification & Automated Test Results

### Test Suite Summary
| Test Suite | Test File | Tests Passed | Status |
| :--- | :--- | :--- | :--- |
| **Policy Unit Tests** | `tests/policies/authorizationPolicies.test.ts` | 28 / 28 | **PASS** |
| **Cross-Resource Security** | `tests/crossResourceSecurity.test.ts` | 26 / 26 | **PASS** |
| **Socket.IO Authorization** | `tests/socketAuthorization.test.ts` | 15 / 15 | **PASS** |
| **Job Security & Ownership**| `tests/jobSecurity.test.ts` | 24 / 24 | **PASS** |
| **Review Identity & RBAC**  | `tests/reviewSecurity.test.ts` | 35 / 35 | **PASS** |
| **API Protection Matrix**   | `tests/apiProtection.test.ts` | 54 / 54 | **PASS** |
| **TOTAL**                  | **6 Test Suites** | **182 / 182** | **100% PASS** |

### Build Validation
- `npx tsc --noEmit`: Exited with code 0 (0 compilation errors).
- `npm run build`: Exited with code 0 (production build passes cleanly).

---

## 5. Security Invariant Confirmation

1. **Knowing a resource UUID is never enough to access it:**
   - A customer knowing Customer B's `jobId` receives `404 Not Found`.
   - A customer knowing Customer B's `bookingId` receives `404 Not Found`.
   - An unrelated worker knowing Customer A's `bookingId` receives `404 Not Found` or `403 Forbidden`.
2. **Identity is derived solely from the authenticated principal:**
   - Any client-supplied `customer_id`, `worker_id`, or `booking_id` in request bodies or query strings is rejected or ignored.
3. **Database-level query scoping prevents memory bloat and data leakage:**
   - Scoped queries (`where: { id: ..., customer_id: ... }`) ensure unowned rows are never pulled into server memory.
4. **Identical security rules across HTTP and WebSockets:**
   - Socket handlers use the same `chatPolicy` as REST controllers.
