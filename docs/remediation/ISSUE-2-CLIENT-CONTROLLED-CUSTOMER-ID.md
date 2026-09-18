# P1 Security Remediation — Issue #2: Remove Client-Controlled customer_id From Job APIs

## 1. Status
**RESOLVED**

All requirements of the Definition of Done have been implemented, tested, verified with 388/388 test passes across all suites (including 24 dedicated security regression tests in `tests/jobSecurity.test.ts`), verified with `npx tsc --noEmit` and `npm run build`, and audited for zero remaining identity fallbacks.

---

## 2. Executive Summary
- **Original Problem**: The job creation schema and job listing endpoint permitted client-controlled `customer_id` / `customerId` parameters. In `src/features/jobs/jobController.ts`, `getMyJobs` contained a dangerous query parameter fallback: `(req as any).user?.id || String(req.query.customer_id)`. In `createJob`, `CreateJobReqSchema` accepted `customer_id` directly in the JSON body, allowing callers to attempt to assign jobs to arbitrary customer UUIDs. Additionally, customer self-service endpoints lacked strict role-based access control (`requireRole(UserRole.CUSTOMER)`).
- **Security Invariant Established**: Customer self-service job endpoints (`POST /api/jobs`, `GET /api/jobs`, `PATCH /api/jobs/:jobId/cancel`) derive customer identity strictly and exclusively from the cryptographically verified JWT bearer token principal (`req.user.id`). Client input cannot supply or influence ownership in the body, query parameters, route parameters, or headers. Cross-customer search is isolated into a separate, dedicated administrative endpoint (`GET /api/admin/jobs?customer_id=...`) strictly guarded by `requireRole(UserRole.ADMIN)`.

---

## 3. Source / Audit Mapping
- **Roadmap Issue**: Issue #2
- **Priority**: P1
- **Category**: Security / Authorization
- **Original Audit Findings**: Audit #24–25
- **Requirement Summary**: Remove `customer_id` from create-job request schemas, remove query parameter fallback from `GET /jobs`, use authenticated principal for all customer self-service operations, and ensure separate admin APIs for cross-customer administrative search are explicitly protected by role checks.

---

## 4. Current Code Analysis

Before remediation, our detailed inspection of the repository revealed the following vulnerabilities and gaps:

1. **`src/schemas/index.ts` (`CreateJobReqSchema`)**:
   - `customer_id: z.string().uuid("Invalid customer UUID")` was accepted in the request body.
   - The schema lacked `.strict()`, allowing callers to supply arbitrary ownership fields such as `customer_id`, `customerId`, `ownerId`, or `userId`.

2. **`src/features/jobs/jobController.ts`**:
   - `getCustomerId(req)`: A custom helper attempted manual token decoding from authorization headers without consistent error handling.
   - `createJob`: Read `req.body.customer_id` and had fallback logic `if (authCustomerId) payload.customer_id = authCustomerId; if (!payload.customer_id) ...`.
   - `getMyJobs`: Contained the primary vulnerability: `const customerId = (req as any).user?.id || String(req.query.customer_id);`. Any caller could provide `?customer_id=<other_customer_id>` and influence which customer's jobs were queried.
   - `cancelJob`: Used `await getCustomerId(req)` and returned raw `error.message` with 500 status on ownership mismatch instead of proper 403 Forbidden.

3. **`src/features/jobs/job.services.ts`**:
   - `createJob(payload: CreateJobReq)`: Read `payload.customer_id` directly from the payload object rather than accepting a trusted, explicitly bound `customerId: string` parameter from the controller.

4. **`src/features/jobs/jobRoutes.ts`**:
   - `POST /api/jobs`, `GET /api/jobs`, and `PATCH /api/jobs/:jobId/cancel` lacked `requireRole(UserRole.CUSTOMER)`, allowing any valid token (e.g. Worker) to invoke customer self-service actions.

5. **`src/features/admin/adminController.ts` & `adminServices.ts`**:
   - `adminService.getAllJobs()` did not support an optional `customerId` filter for legitimate cross-customer administrative investigation.

---

## 5. Root Cause
The root cause was architectural reliance on client-provided query parameters and request bodies for identity selection, rather than deriving ownership solely from the authenticated JWT session context (`req.user.id`), combined with a permissive request schema and missing route-level role checks.

---

## 6. Attack Scenario

### Attack 1: Query-Parameter Cross-Customer Job Enumeration
```
Attacker (Customer A)
  | Authenticates as Customer A (receives valid JWT)
  v
Sends: GET /api/jobs?customer_id=<Victim Customer B UUID>
  |
  v
Vulnerable Controller:
  const customerId = req.user?.id || String(req.query.customer_id);
  // Evaluated req.query.customer_id if user.id was undefined or overridden
  |
  v
Prisma Query:
  prisma.job.findMany({ where: { customer_id: Customer B UUID } })
  |
  v
Result: Customer A obtains Customer B's jobs, locations, requirements, and bookings (IDOR/BOLA).
```

### Attack 2: Request-Body Ownership Injection
```
Attacker (Customer A)
  |
Sends: POST /api/jobs with JSON:
  { "customer_id": "<Victim Customer B UUID>", ... }
  |
  v
Vulnerable Schema & Service:
  Persists job with customer_id = Customer B.
  |
  v
Result: Customer B is fraudulently billed or dispatched workers for a job they never requested.
```

---

## 7. Before Architecture

```
Client (Untrusted)
  |
  +---> POST /api/jobs (body: { customer_id: "victim-uuid" })
  |       |
  |       v
  |     CreateJobReqSchema (accepts customer_id)
  |       |
  |       v
  |     jobController (reads payload.customer_id)
  |       |
  |       v
  |     jobService.createJob (persists customer_id: payload.customer_id)
  |
  +---> GET /api/jobs?customer_id=victim-uuid
          |
          v
        jobController (const customerId = req.user?.id || req.query.customer_id)
          |
          v
        jobService.getJobsByCustomer(victim-uuid)
          |
          v
        Prisma selects victim's jobs
```

---

## 8. After Architecture

```
Client (Untrusted)
  |
  +---> POST /api/jobs (body: { latitude, longitude, location, requirements })
  |       |
  |       v
  |     authenticateJWT -> sets req.user = { id, role: "customer" }
  |       |
  |       v
  |     requireRole(UserRole.CUSTOMER) -> rejects Worker/Admin (403)
  |       |
  |       v
  |     validateBody(CreateJobReqSchema.strict()) -> rejects customer_id/customerId (400)
  |       |
  |       v
  |     jobController: const customerId = req.user.id
  |       |
  |       v
  |     jobService.createJob(customerId, payload) -> persists customer_id: customerId
  |
  +---> GET /api/jobs (any ?customer_id query is completely ignored)
          |
          v
        authenticateJWT -> sets req.user = { id, role: "customer" }
          |
          v
        requireRole(UserRole.CUSTOMER)
          |
          v
        jobController: const customerId = req.user.id (query params NOT read)
          |
          v
        jobService.getJobsByCustomer(customerId)
          |
          v
        prisma.job.findMany({ where: { customer_id: customerId } })
```

---

## 9. Admin Architecture

Administrative cross-customer search is completely segregated into a dedicated administrative endpoint:

```
Admin Client
  |
  v
GET /api/admin/jobs?customer_id=<target-customer-uuid>
  |
  v
authenticateJWT (validates admin JWT)
  |
  v
requireRole(UserRole.ADMIN) (blocks Customer and Worker with 403 Forbidden)
  |
  v
adminController.getAllJobs:
  const customerId = typeof req.query.customer_id === "string" ? req.query.customer_id : undefined;
  |
  v
adminService.getAllJobs(customerId):
  where: customerId ? { customer_id: customerId } : undefined
  |
  v
Prisma queries filtered jobs across the platform with customer summary DTO
```

---

## 10. Route Authorization Matrix

| Route | HTTP Method | Authentication | Role Required | Identity Source | Ownership Enforcement | Admin Filter Supported |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `/api/jobs` | `POST` | `authenticateJWT` | `customer` | `req.user.id` | Database insertion strictly uses `req.user.id` | No |
| `/api/jobs` | `GET` | `authenticateJWT` | `customer` | `req.user.id` | Database query `where: { customer_id: req.user.id }` | No |
| `/api/jobs/:jobId` | `GET` | `authenticateJWT` | Any authenticated | Route parameter | Subject to Issue #5 roadmap remediation | No |
| `/api/jobs/:jobId/cancel` | `PATCH` | `authenticateJWT` | `customer` | `req.user.id` | `job.customer_id === req.user.id` verified before mutation | No |
| `/api/admin/jobs` | `GET` | `authenticateJWT` | `admin` | Admin principal | Platform-wide or filtered by optional `customer_id` query param | Yes (Admin only) |

---

## 11. Files Changed

1. `src/schemas/index.ts`:
   - Removed `customer_id` from `CreateJobReqSchema`.
   - Added `.strict()` to `CreateJobReqSchema` to reject `customer_id`, `customerId`, and any unrecognized keys with `400 Bad Request`.

2. `src/features/jobs/job.services.ts`:
   - Updated `createJob` signature to `createJob(customerId: string, payload: CreateJobReq)`.
   - Explicitly bound `customer_id: customerId` in `tx.job.create`.
   - Updated `cancelJob` to throw an explicit `"Forbidden: You do not own this job"` error on owner mismatch.
   - Added defensive optional chaining on `dispatchJobSimple` invocation.

3. `src/features/jobs/jobController.ts`:
   - Removed redundant, unhandled `getCustomerId` helper.
   - In `createJob`: Extracted `authCustomerId` directly from `(req as AuthenticatedRequest).user?.id`; passed `(authCustomerId, payload)` to `jobService.createJob`.
   - In `getMyJobs`: Completely removed `|| String(req.query.customer_id)`. Used strictly `(req as AuthenticatedRequest).user?.id`.
   - In `cancelJob`: Used `(req as AuthenticatedRequest).user?.id`; returned `403 Forbidden` on ownership mismatch and `404 Not Found` if job does not exist.
   - Sanitized internal error logging and response payloads.

4. `src/features/jobs/jobRoutes.ts`:
   - Added `requireRole(UserRole.CUSTOMER)` to `POST /api/jobs`, `GET /api/jobs`, and `PATCH /api/jobs/:jobId/cancel`.
   - Updated OpenAPI/Swagger specifications documenting customer principal ownership, `bearerAuth` security, and 400/401/403 status codes.

5. `src/features/admin/adminServices.ts`:
   - Updated `adminService.getAllJobs(customerId?: string)` to accept an optional `customerId` filter and apply `where: { customer_id: customerId }`.

6. `src/features/admin/adminController.ts`:
   - Extracted optional `customer_id` query string in `getAllJobs` and forwarded to `adminService.getAllJobs`.

7. `src/features/admin/adminRoutes.ts`:
   - Updated Swagger specification for `GET /api/admin/jobs` documenting the optional `customer_id` query filter.

8. `tests/apiProtection.test.ts`:
   - Removed `customer_id` from `POST /api/jobs` request payloads to comply with the new `.strict()` schema.

9. `tests/jobSecurity.test.ts` (NEW):
   - Created comprehensive test suite covering all 13 test cases mandated by the Issue #2 specification.

---

## 12. Database Changes
- **Migration required**: **NO**
- **Rationale**: The Prisma schema already contains `customer_id` on the `Job` model with an indexed foreign key relationship to `customer.id`. The vulnerability was entirely in the API, validation schema, controller fallback, and service boundary. No schema modification was required.

---

## 13. API Contract Changes
- **`POST /api/jobs`**:
  - Request body no longer accepts `customer_id` or `customerId`.
  - Sending `customer_id`, `customerId`, `ownerId`, or any extraneous key triggers `400 Bad Request`.
  - The job is automatically associated with the authenticated customer (`req.user.id`).
  - Requires `Bearer` token with `role: "customer"`.
- **`GET /api/jobs`**:
  - Query parameters `customer_id` and `customerId` are completely ignored.
  - Returns only jobs owned by the authenticated caller.
  - Requires `Bearer` token with `role: "customer"`.
- **`PATCH /api/jobs/:jobId/cancel`**:
  - Validates that `job.customer_id === req.user.id`. Returns `403 Forbidden` if the caller does not own the job.
- **`GET /api/admin/jobs`**:
  - Admin-only endpoint (`role: "admin"`).
  - Accepts optional `?customer_id=<uuid>` to filter jobs across the entire platform.

---

## 14. Tests
All tests are implemented in `tests/jobSecurity.test.ts` and `tests/apiProtection.test.ts`:

| Test Name | File | Assertion / Security Invariant Proven |
| :--- | :--- | :--- |
| **TEST 1** — Customer creates own job | `tests/jobSecurity.test.ts` | Job created without `customer_id` in body; persisted `job.customer_id === Customer A`. |
| **TEST 2** — Inject `customer_id = Customer B` | `tests/jobSecurity.test.ts` | Rejected with `400 Bad Request`; database create never called. |
| **TEST 3** — Inject `customerId = Customer B` | `tests/jobSecurity.test.ts` | Rejected with `400 Bad Request` via `.strict()`; database create never called. |
| **TEST 3b** — Inject `ownerId` / `userId` | `tests/jobSecurity.test.ts` | Rejected with `400 Bad Request`; database create never called. |
| **TEST 4** — `GET /jobs?customer_id=Customer-B` | `tests/jobSecurity.test.ts` | Query param ignored; returns ONLY Customer A's jobs; Prisma queries `where: { customer_id: Customer A }`. |
| **TEST 5** — `GET /jobs?customerId=Customer-B` | `tests/jobSecurity.test.ts` | Query param ignored; Prisma query strictly scoped to Customer A. |
| **TEST 6** — `GET /jobs` without query params | `tests/jobSecurity.test.ts` | Scoped strictly to Customer A's authenticated principal. |
| **TEST 7 & 12** — Cancel another customer's job | `tests/jobSecurity.test.ts` | Returns `403 Forbidden: You do not own this job`; no update executed. |
| **TEST 7b** — Cancel own job | `tests/jobSecurity.test.ts` | Returns `200 Success`; status updated to `CANCELLED`. |
| **TEST 8** — Admin search with `?customer_id` | `tests/jobSecurity.test.ts` | Admin receives 200 with jobs filtered by `where: { customer_id: Customer B }`. |
| **TEST 8b** — Admin search without filter | `tests/jobSecurity.test.ts` | Admin receives 200 with platform-wide jobs (`where: undefined`). |
| **TEST 9** — Customer accesses admin search | `tests/jobSecurity.test.ts` | Customer receives `403 Forbidden`; database never queried. |
| **TEST 10** — Worker accesses admin search | `tests/jobSecurity.test.ts` | Worker receives `403 Forbidden`; database never queried. |
| **TEST 11a-d** — Unauthenticated requests | `tests/jobSecurity.test.ts` | Requests to POST /jobs, GET /jobs, PATCH /cancel, GET /admin/jobs return `401 Unauthorized`. |
| **TEST 12a-c** — Worker invokes customer job APIs | `tests/jobSecurity.test.ts` | Worker receives `403 Forbidden` on all customer self-service endpoints. |
| **TEST 13a-d** — Service-layer security invariants | `tests/jobSecurity.test.ts` | Direct service calls prove `jobService.createJob` binds `customerId`, `getJobsByCustomer` queries by `customer_id`, `cancelJob` enforces ownership, and `adminService.getAllJobs` applies optional filter. |

---

## 15. Verification Commands
Executed against the live codebase:

1. `npx tsc --noEmit`
2. `npm run build`
3. `npx jest tests/jobSecurity.test.ts`
4. `npx jest tests/apiProtection.test.ts`
5. `npm test`

---

## 16. Verification Results

- **Typecheck (`npx tsc --noEmit`)**: **PASS** (Exit code 0, 0 errors)
- **Build (`npm run build`)**: **PASS** (Exit code 0, clean TypeScript build)
- **Unit & Security Tests (`tests/jobSecurity.test.ts`)**: **PASS** (24 / 24 passed)
- **API Protection Tests (`tests/apiProtection.test.ts`)**: **PASS** (54 / 54 passed)
- **Full Repository Test Suite (`npm test`)**: **PASS** (15 test suites passed, 388 / 388 tests passed)

---

## 17. Security Search
A full repository search was performed post-implementation:

- **`req.query.customer_id` in self-service job code**: **NONE**
  - Only 1 occurrence in the entire repository: `src/features/admin/adminController.ts:32` (Legitimate Admin filter guarded by `requireRole(UserRole.ADMIN)`).
- **`req.query.customerId` in repository**: **NONE**
- **`req.body.customer_id` as authoritative ownership**: **NONE**
- **`req.body.customerId` as authoritative ownership**: **NONE**
- **`customer_id || req.user.id` or similar identity fallbacks**: **NONE**

---

## 18. Remaining Risks / Dependencies
- **Issue #3 (Centralized Authorization Policy Layer)**: Role checks and ownership predicates are currently enforced via `authenticateJWT`, `requireRole`, and explicit controller/service checks. Issue #3 will centralize these into a unified policy engine.
- **Issue #5 (Protect Job Detail and Requirements)**: `GET /api/jobs/:jobId`, `GET /api/jobs/:jobId/requirements`, and `GET /api/jobs/:jobId/bookings` currently require authentication (`authenticateJWT`), but fine-grained object-level ownership checks (e.g. ensuring workers assigned to the job or the job customer can access detail, but not uninvolved parties) belong to Issue #5's Definition of Done and must be addressed when Issue #5 is formally remediated.
