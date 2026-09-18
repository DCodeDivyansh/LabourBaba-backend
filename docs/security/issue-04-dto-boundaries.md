# Issue #4 — Enforce DTO Boundaries Everywhere

**Priority:** P0  
**Category:** Security / Data Exposure  
**Original Audit Finding:** #2  
**Status:** RESOLVED  

---

## 1. Problem

Prisma entities and PostgreSQL records were crossing external response boundaries directly without passing through strict, explicit Data Transfer Object (DTO) allowlists. Internal database fields, password hashes, device tokens, private document storage identifiers, raw coordinates, and future schema additions were at risk of unintentional external disclosure over Express HTTP endpoints and Socket.IO real-time events.

---

## 2. Root Cause

1. **Direct Entity Returns & Object Spreading:**
   - Controllers and services were frequently returning raw database query results or spreading Prisma entities (`res.json(entity)`, `res.json({ ...worker })`, `socket.emit("event", entity)`).
   - In `adminServices.ts`, `getAllJobs` returned jobs using `{ ...job }`.
   - In `chatController.ts`, raw message entities (`res.json(message)`) were returned.
   - In `socketHandlers.ts`, `chat:message` emitted raw database records directly.
   - In `dispatchServices.ts`, `worker:accepted` emitted full worker records.
2. **Unmapped Nested Relations:**
   - Even where outer objects had safe selections, nested Prisma relations (e.g. `booking.job`, `booking.worker`, `booking.payment`, `booking.review`) remained unmapped and were passed directly to clients.
3. **Inconsistent Sanitization:**
   - Multiple ad-hoc inline sanitization functions existed (e.g., `sanitizeCustomer` in `customerAuthController.ts`), which were fragile, incomplete, and did not protect against future column additions to the database schema.

---

## 3. Security Impact

- **Credential & Secret Exposure:** `password_hash`, `otp_hash`, `refresh_token_hash`, and OAuth/session secrets could be leaked to clients.
- **Push & Device Hijacking:** Device tokens and push notification secrets (`device_token`, FCM tokens) exposed in worker listings could allow unauthorized notifications or spoofing.
- **Private Storage Internals:** Storage keys, bucket names, and internal file paths exposed via worker documents could facilitate unauthorized direct object access (IDOR).
- **Location Privacy:** Unsanitized PostGIS internal fields or tracking metadata in `worker_location` could leak exact tracking history.
- **API Instability & Future Schema Leaks:** Adding any new column to a Prisma schema table would automatically propagate into client responses if spreads or direct serialization were used.

---

## 4. Codebase Analysis

Every controller, service, Prisma model, and Socket.IO handler was audited:
- **`src/shared/prismaSelects.ts`**: Upgraded into the central repository DTO definition layer with deterministic, typed, allowlist-only mappers.
- **`src/features/jobs/jobController.ts` & `job.services.ts`**: All job, requirement, and booking endpoints mapped through `toJobDTO`, `toJobRequirementDTO`, and `toBookingDTO`.
- **`src/features/worker/workerServices.ts`**: Document uploads, document listings, analytics, and bookings mapped through `toWorkerDocumentDTO`, `toWorkerAnalyticsDTO`, and `toBookingDTO`.
- **`src/features/worker_location/worker_location.service.ts`**: Real-time worker location updates mapped through `toWorkerLocationDTO`.
- **`src/features/auth/customerAuthController.ts`**: Consolidated ad-hoc `sanitizeCustomer` to canonical `toCustomerSelfDTO`.
- **`src/features/chat/chatController.ts`**: Message retrieval and dispatch mapped through `toChatMessageDTO`.
- **`src/features/skill/skillControllers.ts`**: Skill category listings mapped through `toSkillCategoryDTO`.
- **`src/features/review/reviewController.ts`**: Review creation and retrieval mapped through `toReviewDTO`.
- **`src/features/payment/paymentController.ts`**: Payment status responses mapped through `toPaymentDTO`.
- **`src/features/admin/adminServices.ts`**: Removed `{ ...job }` spread; mapped jobs through `toJobDTO`.
- **`src/features/dispatch/dispatchServices.ts`**: Waves mapped through `toDispatchWaveDTO` and `toDispatchDTO`; Socket.IO `worker:accepted` event sanitized using `toWorkerPublicDTO`.
- **`src/socket/socketHandlers.ts`**: Socket.IO `chat:message` sanitized using `toChatMessageDTO`; aligned authorization failure code to `"FORBIDDEN"`.

---

## 5. Before Architecture

```
Database (PostgreSQL)
        ↓
Prisma ORM (Raw Entities & Full Inclusions)
        ↓
Service Layer (Pass-through / Object Spread)
        ↓
Controller / Socket Handler
        ↓
HTTP / Socket.IO Response: res.json(entity) / socket.emit(event, entity)
```

---

## 6. After Architecture

```
Client Request (HTTP / Socket.IO)
        ↓
Authentication & Authorization Policy Layer
        ↓
Validation Layer (Zod Schemas)
        ↓
Service Layer (Prisma Queries with Safe Selects)
        ↓
Strict Allowlist DTO Mappers (src/shared/prismaSelects.ts)
        ↓
External Boundary: HTTP res.json(dto) / Socket.IO socket.emit(event, dto)
```

---

## 7. DTO Architecture

Every DTO mapper in `src/shared/prismaSelects.ts` strictly constructs an allowlist object. No object spreads (`...entity`) and no blocklists (`delete entity.password`) are permitted.

| DTO Mapper | Target Audience | Key Allowlisted Fields | Excluded Sensitive Fields |
|---|---|---|---|
| `toCustomerPublicDTO` | Public / Counterparty | `id`, `name`, `phone`, `created_at` | `password_hash`, `otp_hash`, `device_token` |
| `toCustomerSelfDTO` | Authenticated Customer | `id`, `name`, `phone`, `created_at` | `password_hash`, `otp_hash`, internal security metadata |
| `toCustomerSummaryDTO` | Nested in Bookings/Jobs | `id`, `name`, `phone` | All internal fields |
| `toWorkerPublicDTO` | Customers / Public | `id`, `name`, `skill_type`, `worker_score`, `is_online`, `skill_category_id`, `phone`, `latitude`, `longitude` | `password_hash`, `otp_hash`, `device_token`, document paths |
| `toWorkerSelfDTO` | Authenticated Worker | `id`, `name`, `phone`, `skill_type`, `worker_score`, `is_online`, `skill_category_id`, `documents`, `analytics` | `password_hash`, `otp_hash`, raw device tokens |
| `toWorkerAdminDTO` | Platform Administrators | Above + `created_at`, `updated_at` | `password_hash`, `otp_hash`, credential hashes |
| `toWorkerDocumentDTO` | Worker / Admin | `id`, `worker_id`, `document_type`, `verified`, `uploaded_at` | Raw cloud storage keys, internal bucket credentials |
| `toWorkerLocationDTO` | Dispatch / Map tracking | `worker_id`, `latitude`, `longitude`, `updated_at` | Internal PostGIS geometry strings, tracking history |
| `toWorkerAnalyticsDTO` | Worker Self / Admin | `id`, `worker_id`, `total_jobs`, `completion_rate`, `rating`, `earnings` | Internal scoring metadata |
| `toJobDTO` | Customer / Admin | `id`, `customer_id`, `latitude`, `longitude`, `location`, `status`, `dispatch_status`, `created_at`, `job_requirement`, `customer`, `booking` | Internal worker/customer credentials |
| `toJobRequirementDTO` | Customer / Worker | `id`, `job_id`, `skill_type`, `worker_count_needed`, `worker_count_filled`, `rate_per_day`, `status`, `current_wave`, `wave_size`, `created_at`, `updated_at`, `job_dispatch`, `job` | Internal dispatch logs |
| `toDispatchDTO` | Dispatch / Worker | `id`, `job_requirement_id`, `worker_id`, `wave_number`, `status`, `dispatch_time`, `expires_at`, `worker` | Raw worker credentials |
| `toDispatchWaveDTO` | Admin / Dispatch | `wave`, `count`, `workers` | Internal worker tracking |
| `toBookingDTO` | Customer / Worker | `id`, `job_id`, `worker_id`, `customer_id`, `status`, `total_price`, `start_time`, `end_time`, `job`, `worker`, `customer`, `review`, `payment` | Provider secrets, internal notes |
| `toChatMessageDTO` | Chat Participants | `id`, `booking_id`, `sender_id`, `message`, `created_at` | Unrelated booking metadata |
| `toConversationDTO` | Chat History | `booking_id`, `last_message`, `unread_count`, `counterpart` | Internal credentials |
| `toReviewDTO` | Public / Customer | `id`, `booking_id`, `worker_id`, `customer_id`, `rating`, `comment`, `created_at`, `worker`, `customer` | Reviewer credentials |
| `toPaymentDTO` | Customer / Admin | `id`, `booking_id`, `razorpay_order_id`, `razorpay_payment_id`, `status`, `amount`, `currency`, `created_at` | Razorpay secrets, webhook signatures, idempotency internals |
| `toSkillCategoryDTO` | Public | `id`, `name` | Internal category metadata |

---

## 8. Prisma Query Hardening

- Pre-existing safe select queries in `src/shared/prismaSelects.ts` (`workerPublicSelect`, `workerSelfSelect`, `customerSafeSelect`, `jobSafeSelect`, `bookingSafeSelect`, `paymentSafeSelect`, `reviewSafeSelect`) were standardized.
- DTOs act as the defense-in-depth enforcement boundary: even if a service query retrieves additional columns for internal business logic or joins broad relations, the DTO mapper guarantees that un-allowlisted fields are stripped prior to response serialization.

---

## 9. HTTP Boundary Changes

All controllers returning database entities were updated to serialize through DTO mappers:
1. `src/features/jobs/jobController.ts`:
   - `createJob`: returns `toJobDTO(job)`
   - `getMyJobs`: returns `jobs.map(toJobDTO)`
   - `getJobDetail`: returns `toJobDTO(job)`
   - `getJobRequirements`: returns `requirements.map(toJobRequirementDTO)`
   - `createJobRequirement`: returns `toJobRequirementDTO(requirement)`
   - `getJobBookings`: returns `bookings.map(toBookingDTO)`
2. `src/features/worker/workerServices.ts`:
   - `uploadDocument`: returns `toWorkerDocumentDTO(doc)`
   - `getDocuments`: returns `docs.map(toWorkerDocumentDTO)`
   - `getAnalytics`: returns `toWorkerAnalyticsDTO(analytics)`
   - `getBookings`: returns `bookings.map(toBookingDTO)`
3. `src/features/worker_location/worker_location.service.ts`:
   - `updateLocation`: returns `toWorkerLocationDTO(location)`
4. `src/features/auth/customerAuthController.ts`:
   - Replaced inline `sanitizeCustomer` with `toCustomerSelfDTO(customer)`.
5. `src/features/chat/chatController.ts`:
   - `getMessages`: returns `messages.map(toChatMessageDTO)`
   - `sendMessage`: returns `toChatMessageDTO(saved)`
6. `src/features/skill/skillControllers.ts`:
   - `getSkills`: returns `skills.map(toSkillCategoryDTO)`
   - `addSkills`: returns `toSkillCategoryDTO(skill)`
7. `src/features/review/reviewController.ts`:
   - `createReview`: returns `toReviewDTO(review)`
   - `getWorkerReviews`: returns `reviews.map(toReviewDTO)`
   - `getBookingReview`: returns `toReviewDTO(review)`
8. `src/features/payment/paymentController.ts`:
   - `getPaymentStatusHandler`: returns `toPaymentDTO(payment)`
9. `src/features/admin/adminServices.ts`:
   - `getAllJobs`: returns `jobs.map(toJobDTO)` without object spreading.

---

## 10. Socket.IO Boundary Changes

1. **`chat:message`:**
   - Handler in `src/socket/socketHandlers.ts` sends `toChatMessageDTO(message)`.
   - Receiver payload receives only allowlisted fields (`id`, `booking_id`, `sender_id`, `message`, `created_at`).
2. **`worker:accepted`:**
   - In `src/features/dispatch/dispatchServices.ts`, the emitted worker record is mapped with `toWorkerPublicDTO(worker)`.
3. **`worker:location`:**
   - Emits allowlisted location payload `{ workerId, lat, lng }`.
4. **Security Error Codes:**
   - Aligned socket authorization error code to `"FORBIDDEN"` with message `"Unauthorized: caller is not an active participant in this booking"`.

---

## 11. Sensitive Fields

Identified and explicitly excluded categories of sensitive/internal fields:
- **Authentication:** `password_hash`, `otp_hash`, `refresh_token_hash`.
- **Device & Push:** `device_token`, `fcm_token`, push subscription secrets.
- **Documents:** `storage_key`, `bucket_name`, AWS/Cloud storage internal credentials.
- **Location:** PostGIS raw geometry objects (`location_geo`), private historical coordinate trails.
- **Payment Internals:** `razorpay_signature`, `idempotency_key`, raw webhook signatures.
- **Internal Flags & Audit:** Admin notes, queue retry counts, internal dispatch state machines.

---

## 12. Testing

Three layers of automated security test suites verify DTO boundaries:

1. **Unit Tests (`tests/dtoAllowlist.test.ts`):**
   - 13 comprehensive unit tests validating every DTO mapper.
   - Inject toxic/poisoned fields: `password_hash`, `otp_hash`, `device_token`, `future_secret_column`, `internal_metadata`.
   - Verifies exact allowlist output keys (`Object.keys(dto)`).
   - Verifies nested DTO mapping and future-schema property immunity.
2. **HTTP Integration Tests (`tests/dtoBoundarySecurity.test.ts`):**
   - 12 comprehensive integration tests across Auth, Jobs, Requirements, Bookings, Reviews, Skills, Chat, and Location endpoints.
   - Uses recursive object inspection (`assertNoForbiddenFields`) on all response payloads to guarantee no forbidden keys cross the HTTP boundary.
3. **Socket.IO Security Tests (`tests/socketSecurity.test.ts`):**
   - 23 tests verifying authentication, authorization, room isolation, and sanitized event payloads (`chat:message`, `worker:location`, `worker:accepted`).

---

## 13. Security Guarantees

1. **Strict Persistence-to-API Boundary:** No raw Prisma entity can be returned over HTTP or emitted over Socket.IO.
2. **Future Schema Immunity:** Adding a new column to any Prisma table will not leak it to API clients without an explicit code change in the DTO mapper.
3. **No Spread or Blocklist DTOs:** Every DTO is constructed solely using explicit field allowlists.
4. **Nested Sanitization:** All nested relational entities (`job`, `worker`, `customer`, `payment`, `review`) are individually mapped through their respective DTO mappers.
5. **Separation of Concerns:** Public, self-service, and admin representations are strictly isolated.

---

## 14. Files Changed

- `src/shared/prismaSelects.ts` — Centralized typed DTO interfaces and deterministic allowlist mappers.
- `src/features/jobs/jobController.ts` — Enforced DTO boundaries on all job, requirement, and booking endpoints.
- `src/features/worker/workerServices.ts` — Applied DTO mappers on document, analytics, and booking services.
- `src/features/worker_location/worker_location.service.ts` — Applied `toWorkerLocationDTO`.
- `src/features/auth/customerAuthController.ts` — Consolidated `sanitizeCustomer` to canonical `toCustomerSelfDTO`.
- `src/features/chat/chatController.ts` — Applied `toChatMessageDTO` to chat HTTP endpoints.
- `src/features/skill/skillControllers.ts` — Applied `toSkillCategoryDTO` to skill endpoints.
- `src/features/review/reviewController.ts` — Applied `toReviewDTO` to review endpoints.
- `src/features/payment/paymentController.ts` — Applied `toPaymentDTO` to payment status endpoint.
- `src/features/admin/adminServices.ts` — Applied `toJobDTO` to admin job listings.
- `src/features/dispatch/dispatchServices.ts` — Applied `toDispatchWaveDTO`, `toDispatchDTO`, and `toWorkerPublicDTO`.
- `src/socket/socketHandlers.ts` — Sanitized `chat:message` socket payload and aligned error code to `"FORBIDDEN"`.
- `tests/dtoAllowlist.test.ts` — Created DTO unit and regression test suite.
- `tests/dtoBoundarySecurity.test.ts` — Created HTTP boundary recursive inspection test suite.
- `tests/socketSecurity.test.ts` — Enhanced Socket.IO security tests for sanitized payloads and error codes.
- `docs/security/issue-04-dto-boundaries.md` — Complete security documentation.

---

## 15. Verification

- **TypeScript Compilation:** `npx tsc --noEmit` passed with 0 errors.
- **Production Build:** `npm run build` passed with 0 errors.
- **Unit Tests:** `npx jest tests/dtoAllowlist.test.ts` — 13/13 passed.
- **HTTP Security Tests:** `npx jest tests/dtoBoundarySecurity.test.ts` — 12/12 passed.
- **Socket.IO Security Tests:** `npx jest tests/socketSecurity.test.ts` — 23/23 passed.
- **Job Security Tests:** `npx jest tests/jobSecurity.test.ts` — 24/24 passed.
- **Full Test Suite:** All test suites pass.

---

## 16. Remaining Risks

- **New Endpoints / Services:** Any newly created endpoints in future roadmap issues (e.g. advanced payment webhooks or admin reporting) must adhere to the `src/shared/prismaSelects.ts` DTO architecture and never return raw Prisma query results. The DTO unit tests and regression assertions serve as the enforcement baseline.
