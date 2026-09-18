# Issue 5 — Protect Job Detail and Requirements

## 1. Status
**RESOLVED**

- **Priority:** P1  
- **Category:** Security / IDOR  
- **Original Audit Mapping:** Audit Findings #26–27  

---

## 2. Original Finding

Audit Findings #26 and #27 identified an Insecure Direct Object Reference (IDOR) vulnerability around job details, requirements, dispatch waves, and job booking lists:
- Knowing a Job or Requirement UUID was previously sufficient to retrieve sensitive details, requirements, booking rosters, and dispatch wave records.
- Customer, worker, and admin visibility were not consistently segregated by persistent marketplace relationships.
- UUID possession/secrecy was treated as an authorization grant.

---

## 3. Pre-Remediation Analysis

Prior to remediation, the following paths and vulnerabilities existed:

1. **`GET /api/jobs/:jobId` (`getJobDetail`)**:
   - Fetched the resource first by UUID before in-memory authorization evaluation.
   - Malformed UUID strings caused unhandled Prisma conversion errors (500 Internal Server Error).
   - If `actor` was not passed to the service, authorization was omitted.

2. **`GET /api/jobs/:jobId/requirements` (`getJobRequirements`)**:
   - `prisma.job.findUnique` did not include `booking` or `job_requirement.job_dispatch` relations, causing legitimate workers with bookings/dispatches on the job to be falsely rejected with 404.
   - Lacked parameter validation on `jobId`.

3. **`GET /api/jobs/:jobId/bookings` (`getJobBookings`)**:
   - Did not enforce worker-level booking isolation: if an assigned worker accessed the job bookings endpoint, they could potentially inspect other workers' booking records, pricing, and contact details.

4. **`GET /api/dispatch/:requirementId/waves` (`getWaves`)**:
   - Accessible by any authenticated user without verifying job ownership. Any customer or worker could enumerate dispatch waves, slots filled, workers notified, and candidate dispatches for any requirement.

5. **Individual Requirement Detail**:
   - Lacked a dedicated endpoint for querying a single requirement under parent job and relationship-based authorization (`GET /api/jobs/:jobId/requirements/:requirementId`).

---

## 4. Root Cause

1. **Possession vs. Relationship:** UUID secrecy was conflated with authorization.
2. **Missing Relational Population During Policy Checks:** Job queries in requirement services omitted booking/dispatch relations required by `jobPolicy.canRead`.
3. **Missing Parameter Validation:** Express path parameters were not validated with Zod before reaching Prisma.
4. **Permissive Wave Dispatches:** `getWaves` lacked actor verification against parent job ownership.

---

## 5. Authorization Model

Authorization is strictly relationship-based rather than role-only or UUID-only:

1. **Customer:**
   - May access only jobs where `job.customer_id === authenticatedUser.id`.
   - May access only requirements belonging to their own jobs.
   - May access job booking lists only for their own jobs.
   - May access wave dispatch history only for requirements under their own jobs.
   - Denied access to another customer's job/requirement with **404 Not Found** (preventing existence enumeration).

2. **Worker:**
   - May access only jobs where the worker has an active/persisted relationship:
     - Assigned booking: `job.booking.some(b => b.worker_id === worker.id)`
     - Dispatched requirement: `job.job_requirement.some(r => r.job_dispatch.some(d => d.worker_id === worker.id))`
   - In `GET /api/jobs/:jobId/bookings`, a worker **ONLY sees their own booking** (`where: { job_id: jobId, worker_id: actor.id }`).
   - Denied access to unrelated jobs/requirements with **404 Not Found**.
   - Worker role alone never grants access.

3. **Admin:**
   - Explicit platform permission (`actor.role === UserRole.ADMIN`).
   - Allowed platform-wide inspection across all jobs, requirements, waves, and bookings.

---

## 6. Resource Relationship Diagram

```
Authenticated Principal (req.user)
       |
       +--- CUSTOMER (id = C1)
       |         |
       |         | owns (customer_id = C1)
       |         v
       |       [Job] ------------------------+
       |         |                           |
       |         | has                       | has
       |         v                           v
       |   [Requirement]                 [Booking]
       |         |                       (worker_id = W1)
       |         | dispatched to
       |         v
       |   [JobDispatch]
       |   (worker_id = W1)
       |
       +--- WORKER (id = W1)
       |         |
       |         +-- Has legitimate relation:
       |             - via Booking on Job/Requirement
       |             - OR via JobDispatch on Requirement
       |             (Isolated: sees ONLY own booking in roster)
       |
       +--- UNRELATED WORKER (id = W2)
                 |
                 +-- No Booking / No Dispatch --> 404 Not Found
```

---

## 7. Endpoint Authorization Matrix

| Endpoint | Customer (Owner) | Customer (Other) | Worker (Assigned) | Worker (Unrelated) | Admin | Anonymous |
|---|---|---|---|---|---|---|
| `GET /api/jobs/:jobId` | Allow (200) | Deny (404) | Allow (200) | Deny (404) | Allow (200) | Deny (401) |
| `PATCH /api/jobs/:jobId/cancel` | Allow (200) | Deny (404) | Deny (403) | Deny (403) | Allow (200) | Deny (401) |
| `GET /api/jobs/:jobId/requirements` | Allow (200) | Deny (404) | Allow (200) | Deny (404) | Allow (200) | Deny (401) |
| `POST /api/jobs/:jobId/requirements` | Allow (201) | Deny (404) | Deny (403) | Deny (403) | Allow (201) | Deny (401) |
| `GET /api/jobs/:jobId/requirements/:reqId` | Allow (200) | Deny (404) | Allow (200) | Deny (404) | Allow (200) | Deny (401) |
| `GET /api/jobs/:jobId/bookings` | Allow (all bookings) | Deny (404) | Allow (own booking only) | Deny (404) | Allow (all) | Deny (401) |
| `GET /api/dispatch/:reqId/waves` | Allow (200) | Deny (404) | Deny (404) | Deny (404) | Allow (200) | Deny (401) |
| `GET /api/dispatch/:reqId` | Deny (403) | Deny (403) | Allow (200) | Deny (404) | Allow (200) | Deny (401) |

---

## 8. Database Query Scoping

- **`jobPolicy.scopeRead` & `scopeList`:** Provide Prisma predicates scoping jobs to `customer_id: actor.id` or `booking.some.worker_id / job_dispatch.some.worker_id`.
- **Worker Booking Isolation:** `jobService.getJobBookings` evaluates the actor role; if `WORKER`, it sets `where: { job_id: jobId, worker_id: actor.id }`, guaranteeing that a worker cannot view fellow workers' bookings.
- **Param Validation:** `validateParams` parses and enforces UUID schemas before reaching Prisma, preventing unhandled SQL/Prisma syntax conversion errors.

---

## 9. DTO Boundary

All responses pass through explicit DTO mappers established in Issue #4:
- `toJobDTO`: Strictly allowlists job coordinates, status, and dispatch status.
- `toJobRequirementDTO`: Allowlisted requirement metrics.
- `toBookingDTO`: Recursively sanitized booking objects.
- `toDispatchWaveDTO` & `toDispatchDTO`: Allowlisted dispatch records.

No raw Prisma models cross the API boundary.

---

## 10. Error Semantics

- **401 Unauthorized:** Missing or invalid JWT authentication token.
- **403 Forbidden (`ROLE_FORBIDDEN` / `NOT_OWNER`):** Authenticated user has wrong role (e.g. Worker attempting `PATCH /cancel`).
- **404 Not Found (`RESOURCE_NOT_FOUND`):** Cross-customer or unrelated worker attempting to access a resource belonging to someone else. Prevents ID enumeration.
- **400 Bad Request (`Validation failed`):** Malformed UUID path parameter or invalid body payload.

---

## 11. Tests

33 automated integration tests in `tests/jobDetailRequirementSecurity.test.ts`:
1. **Job Detail:**
   - Customer A reads own job (200).
   - Customer B reads Customer A's job (404).
   - Worker A (assigned) reads Job A (200).
   - Worker B (unrelated) reads Job A (404).
   - Admin reads any job (200).
   - Malformed UUID returns 400.
   - Unauthenticated returns 401.
2. **Job Requirements:**
   - Customer A lists requirements of own job (200).
   - Customer B cannot list requirements (404).
   - Worker A (assigned) lists requirements (200).
   - Worker B (unrelated) cannot list requirements (404).
   - Admin lists requirements (200).
3. **Single Requirement Detail:**
   - Customer A reads own requirement (200).
   - Customer B cannot read requirement (404).
   - Worker A (booked) reads requirement (200).
   - Worker B (unrelated) cannot read requirement (404).
   - Mismatched requirement/job returns 404.
   - Malformed UUID returns 400.
4. **Job Booking List & Isolation:**
   - Customer A lists all bookings for own job (200).
   - Customer B cannot list bookings (404).
   - Worker A ONLY sees their own booking, NOT Worker C's booking (200, 1 booking).
   - Worker B cannot list bookings (404).
   - Admin lists all bookings (200).
5. **Wave History:**
   - Customer A views waves for own requirement (200).
   - Customer B cannot view waves (404).
   - Worker B cannot view waves (404).
   - Admin views waves (200).
   - Malformed requirementId returns 400.
6. **Service Layer Invariants:**
   - `getJobDetail` throws 401 without actor.
   - `getJobRequirements` throws 401 without actor.
   - `getJobBookings` throws 401 without actor.
   - `getRequirementDetail` throws 401 without actor.
   - `getWaves` throws 404 when customer does not own requirement.

---

## 12. Files Changed

- `src/middlewares/validationMiddleware.ts` — Added `validateParams` and `validateQuery`.
- `src/schemas/index.ts` — Added `JobIdParamSchema`, `RequirementIdParamSchema`, and `JobAndRequirementIdParamSchema`.
- `src/policies/types.ts` — Supported 401 status in `AuthorizationError`.
- `src/policies/job.policy.ts` — Extended `canReadBookings` for worker relationship verification.
- `src/features/jobs/job.services.ts` — Enforced actor requirement, populated relations for worker checks, and isolated worker bookings.
- `src/features/jobs/jobReqServices.ts` — Added `getRequirementDetail` with policy assertion.
- `src/features/jobs/jobController.ts` — Added `getRequirementDetail` controller.
- `src/features/jobs/jobRoutes.ts` — Added `validateParams` and mounted `GET /:jobId/requirements/:requirementId`.
- `src/features/dispatch/dispatchServices.ts` — Added actor authorization to `getWaves`.
- `src/features/dispatch/dispatchController.ts` — Passed actor to `getWaves` and handled `AuthorizationError`.
- `src/features/dispatch/dispatchRoutes.ts` — Added `validateParams` on requirement routes.
- `tests/jobDetailRequirementSecurity.test.ts` — 33 integration security tests.
- `tests/policies/authorizationPolicies.test.ts` — Updated unit tests.

---

## 13. Migration Changes
No database schema migrations or index changes were required. All queried foreign keys (`customer_id`, `job_id`, `worker_id`, `requirement_id`) already possess appropriate B-tree indices in PostgreSQL.

---

## 14. Security Verification
- Repository-wide audit confirmed that all job, requirement, wave, and booking list access paths require authentication and relationship-based authorization.
- UUID parameter validation prevents database errors from malformed input.

---

## 15. Definition of Done
- [x] Customer can access only jobs they own.
- [x] Customer can access only requirements belonging to their jobs.
- [x] Customer cannot access another customer's job by UUID.
- [x] Customer cannot access another customer's requirement by UUID.
- [x] Customer cannot access another customer's job booking list.
- [x] Worker access is based on a legitimate persisted relationship.
- [x] Worker role alone is insufficient.
- [x] Unrelated worker cannot retrieve another customer's job.
- [x] Unrelated worker cannot retrieve another worker's requirement/job.
- [x] Unrelated worker cannot retrieve protected booking information.
- [x] Admin access requires explicit platform authorization.
- [x] Tests pass (100% success rate across 21 test suites).
- [x] Issue #4 DTO boundaries preserved.
