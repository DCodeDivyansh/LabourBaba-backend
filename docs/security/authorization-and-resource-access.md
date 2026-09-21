# Authorization & Resource Access Architecture (Issues 1–6)

## 1. Security Philosophy & Invariants
1. **Authenticated Principal Supremacy**: The identity of the caller is strictly derived from the verified JWT payload (`req.user.id`, `req.user.role`). Client-supplied identifiers in query parameters (`?customer_id=`), body payloads (`{ "customer_id": "..." }`), or headers are strictly rejected or ignored.
2. **Relationship-Based Authorization (ABAC)**: Access to protected resources (jobs, requirements, bookings, payments, reviews) is granted exclusively through legitimate relational ownership or operational assignment, never simply by knowing a UUID.
3. **Database-Scoped Retrieval**: Where possible, authorization boundaries are pushed down into SQL queries (e.g. `WHERE id = :id AND customer_id = :userId`) to eliminate accidental cross-tenant data retrieval.
4. **Strict DTO Boundaries**: Direct return or object spreading of raw Prisma entities is prohibited across all HTTP and Socket.IO interfaces. Response payloads pass through explicit allowlist serializers (`src/shared/prismaSelects.ts`).

---

## 2. Authorization Model by Domain

### Issue 1 — Review Identity
- **Authorship**: Exclusively extracted from `req.user.id` (`UserRole.CUSTOMER`).
- **Pre-Conditions**: Booking must be in `COMPLETED` status and owned by the authenticated customer (`booking.customer_id === req.user.id`).
- **Worker Identity**: Extracted server-side from the verified booking relation (`booking.worker_id`).
- **Uniqueness**: Database-level unique constraint on `Review.booking_id` prevents duplicate reviews under concurrent requests.

### Issue 2 — Job APIs & Customer Isolation
- **Creation**: `POST /api/jobs` binds `job.customer_id` to `req.user.id`.
- **Listing**: `GET /api/jobs` queries strictly by `where: { customer_id: req.user.id }`. Query parameter fallbacks like `?customer_id=` are ignored.
- **Admin Search**: `GET /api/admin/jobs` is isolated behind `requireRole(UserRole.ADMIN)` with explicit filter capabilities.

### Issue 3 — Unified Policy Layer
Centralized in `src/policies/`:
- `jobPolicy`: `canReadJob`, `canUpdateJob`, `canCancelJob`, `canListJobBookings`.
- `requirementPolicy`: `canReadRequirement`, `canCreateRequirement`, `canUpdateRequirement`.
- `bookingPolicy`: `canReadBooking`, `canConfirmComplete`, `canVerifyOtp`, `canViewWorkerLocation`.
- `paymentPolicy`: `canReadPayment`, `canCreatePaymentOrder`, `canRefundPayment`.
- `reviewPolicy`: `canCreateReview`, `canReadBookingReview`.
- `dispatchPolicy`: `canReadWaves`, `canAcceptDispatch`.
- `workerPolicy`: `canReadWorkerDocuments`, `canUpdateLocation`.

### Issue 4 — DTO Boundaries & Field Masking
All API endpoints serialize via explicit allowlist mappers:
- **Workers**: `toWorkerPublicDTO`, `toWorkerSelfDTO`, `toWorkerAdminDTO` (strips `device_token`, passwords, and internal storage paths).
- **Customers**: `toCustomerSelfDTO`, `toCustomerSummaryDTO` (strips `deleted_at`, tokens, and passwords).
- **Bookings**: `toBookingDTO` (strips `otp_hash`, sanitizes nested payment/review objects, hides payment details from workers).
- **Payments**: `toPaymentDTO` (strips internal provider secrets and raw headers).

### Issue 5 — Job & Requirement Protection
- **Customer**: Access restricted to own jobs and child requirements.
- **Worker**: Access permitted only if assigned via active booking or targeted dispatch wave. Unrelated workers receive HTTP 404 (IDOR immunity).
- **Admin**: Explicit platform oversight.

### Issue 6 — Booking & Payment Protection
- **Booking Access**: Scoped to the booking customer and assigned worker. Unrelated customers/workers receive HTTP 404.
- **Payment Access**: Permitted for the booking customer and admin. Assigned workers receive sanitized operational booking details with financial provider secrets and customer billing data stripped.

---

## 3. Verified Route Access Matrix

| Endpoint | Method | Customer (Owner) | Customer (Other) | Worker (Assigned) | Worker (Other) | Admin |
|---|---|---|---|---|---|---|
| `/api/jobs` | POST | ALLOW (201) | N/A | DENY (403) | DENY (403) | DENY (403) |
| `/api/jobs` | GET | ALLOW (Own) | DENY (Filtered) | DENY (403) | DENY (403) | N/A |
| `/api/jobs/:jobId` | GET | ALLOW (200) | DENY (404) | ALLOW (200) | DENY (404) | ALLOW (200) |
| `/api/jobs/:jobId/requirements` | GET | ALLOW (200) | DENY (404) | ALLOW (200) | DENY (404) | ALLOW (200) |
| `/api/jobs/:jobId/bookings` | GET | ALLOW (All) | DENY (404) | ALLOW (Self only) | DENY (404) | ALLOW (All) |
| `/api/bookings/:bookingId` | GET | ALLOW (Full) | DENY (404) | ALLOW (No Pay) | DENY (404) | ALLOW (Full) |
| `/api/bookings/:bookingId/payment` | GET | ALLOW (200) | DENY (403/404) | DENY (403) | DENY (403) | ALLOW (200) |
| `/api/reviews/:bookingId` | POST | ALLOW (201) | DENY (403) | DENY (403) | DENY (403) | DENY (403) |
| `/api/admin/jobs` | GET | DENY (403) | DENY (403) | DENY (403) | DENY (403) | ALLOW (200) |
