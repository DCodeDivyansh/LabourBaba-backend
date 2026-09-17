# Security Remediation: P0 Finding #9 — Dispatch Acceptance Does Not Prove a Valid Dispatch Row Exists

**Severity:** P0 — Release Blocker  
**Phase:** Phase 1 — Dispatch  
**Primary Code Area:** `src/features/dispatch/dispatchServices.ts`, `src/features/dispatch/dispatchController.ts`, `src/features/dispatch/dispatchRoutes.ts`  
**Status:** RESOLVED & VERIFIED

---

## 1. Executive Summary

Finding #9 identified a critical authorization flaw in the job acceptance flow of the LabourBaba platform. Prior to this remediation, any worker possessing a valid `requirementId` could trigger booking creation and secure a job assignment—even if that worker had never received a dispatch, had received a dispatch for a completely different requirement, possessed an expired dispatch, or attempted to accept a terminal dispatch.

This remediation establishes the mandatory server-side security invariant:
> **A worker may accept a requirement only when there is a currently valid, pending, non-expired dispatch row for that exact requirement and that exact authenticated worker.**

Knowing a `requirementId` alone is **never** sufficient to claim a job. The entire validation, dispatch transition, booking creation, and capacity increment are executed atomically within a single serialized database transaction.

---

## 2. Original Behavior

Prior to remediation, `acceptDispatch` in `src/features/dispatch/dispatchServices.ts` handled acceptance as follows:

```typescript
// Original vulnerable implementation
await tx.job_dispatch.updateMany({
  where: { requirement_id: requirementId, worker_id: workerId },
  data: { status: 'accepted' },
});

// Immediately followed by booking creation without checking affected row count:
const booking = await tx.booking.create({
  data: {
    job_id: req.job_id,
    requirement_id: requirementId,
    worker_id: workerId,
    customer_id: req.job.customer_id,
    status: 'confirmed',
    otp_hash,
  },
});
```

Additionally, in `src/features/dispatch/dispatchRoutes.ts`:
```typescript
router.post("/:requirementId/accept", authenticateJWT, acceptJob);
router.post("/:requirementId/decline", authenticateJWT, declineJob);
```
Neither route had the `requireRole(UserRole.WORKER)` middleware guard.

---

## 3. Root Cause

1. **Unchecked Affected Row Count**: `tx.job_dispatch.updateMany` was called without evaluating `updateResult.count`. Even when zero rows were updated (`count === 0`, meaning the worker was never dispatched), execution continued straight to `tx.booking.create`.
2. **Missing Status Constraints**: The query did not require `status: 'pending'`. A worker could accept an already accepted, declined, timed out, or expired dispatch row.
3. **Missing Expiration Constraints**: The query did not verify `expires_at: { gt: now }`. Workers could accept stale dispatches hours or days after their expiration.
4. **Missing Role RBAC Guards**: Dispatch acceptance and decline routes only required a valid JWT (`authenticateJWT`) without verifying `UserRole.WORKER`. A customer could issue acceptance requests.
5. **No Concurrency Lock on Capacity**: Without serializing concurrent transactions via row-locking, two workers could race for the final available slot and both obtain confirmed bookings.

---

## 4. Attack Scenarios

### Scenario A: Job Sniping via Requirement ID Guessing/Enumeration
1. Worker A monitors public job listings or snoops requirement IDs from network traffic.
2. Worker A was never in the dispatch radius and never received a dispatch notification.
3. Worker A sends `POST /api/dispatch/:requirementId/accept`.
4. Previously, the zero-row update silently succeeded, a confirmed booking was created for Worker A, and the legitimate dispatched workers were locked out.

### Scenario B: Acceptance Replay and Double Booking
1. Worker A receives a valid dispatch and accepts it.
2. Worker A replays the `POST /api/dispatch/:requirementId/accept` request.
3. Previously, because `status: 'pending'` was not checked, multiple bookings could be created for the same worker.

### Scenario C: Expired Dispatch Claim
1. Worker A receives a dispatch with a 30-second timeout window.
2. Worker A waits 10 minutes (dispatch is timed out/expired).
3. Worker A calls accept; previously, the system accepted the stale dispatch regardless of expiration.

---

## 5. Security Invariant

The following invariant is strictly enforced:

$$\text{Eligible for Acceptance} \iff \begin{cases}
\text{Worker is authenticated via verified JWT principal} \\
\text{User role is strictly } \texttt{WORKER} \\
\text{No client-supplied worker identity override present} \\
\text{Requirement exists and } \text{slots are not full} \\
\text{Worker has no existing active booking for requirement} \\
\text{Matching dispatch exists with } \texttt{requirement\_id} \land \texttt{worker\_id} \\
\text{Dispatch status is strictly } \texttt{'pending'} \\
\text{Dispatch is not expired: } \texttt{expires\_at} > \text{NOW}()
\end{cases}$$

If any condition fails, the database transaction rolls back completely and **no booking is created**.

---

## 6. Atomicity & Implementation Details

### 6.1 Transaction Boundary (`src/features/dispatch/dispatchServices.ts`)
The entire operation executes inside a single `prisma.$transaction`:

```typescript
export const acceptDispatch = async (requirementId: string, workerId: string) => {
  const result = await prisma.$transaction(async (tx) => {
    // 1. Pessimistic row-lock to serialize concurrent attempts on this requirement
    await tx.$queryRaw`
      SELECT id FROM job_requirement
      WHERE id = ${requirementId}::uuid FOR UPDATE
    `;

    // 2. Requirement validity & capacity verification
    const req = await tx.job_requirement.findUnique({
      where: { id: requirementId },
      include: { job: true },
    });

    if (!req) {
      throw new DispatchAcceptanceError('Requirement not found', 'REQUIREMENT_NOT_FOUND', 404);
    }
    if (req.status === 'filled' || (req.worker_count_filled ?? 0) >= req.worker_count_needed) {
      throw new DispatchAcceptanceError('Requirement slots are already full', 'SLOTS_FULL', 409);
    }

    // 3. Duplicate booking guard
    const existingBooking = await tx.booking.findFirst({
      where: { requirement_id: requirementId, worker_id: workerId },
    });
    if (existingBooking) {
      throw new DispatchAcceptanceError(
        'Worker already has an active booking for this requirement',
        'BOOKING_ALREADY_EXISTS',
        409,
      );
    }

    // 4. Atomic conditional transition: pending + non-expired + exact requirement + exact worker
    const now = new Date();
    const updateResult = await tx.job_dispatch.updateMany({
      where: {
        requirement_id: requirementId,
        worker_id: workerId,
        status: 'pending',
        expires_at: { gt: now },
      },
      data: {
        status: 'accepted',
        responded_at: now,
      },
    });

    // 5. Authoritative authorization assertion
    if (updateResult.count === 0) {
      // Diagnostic check for precise, safe client feedback (never overrides failure)
      const existingDispatch = await tx.job_dispatch.findFirst({
        where: { requirement_id: requirementId, worker_id: workerId },
        select: { status: true, expires_at: true },
      });

      if (!existingDispatch) {
        throw new DispatchAcceptanceError(
          'No dispatch record found for this worker and requirement',
          'NO_VALID_DISPATCH',
          404,
        );
      }
      if (existingDispatch.status === 'accepted') {
        throw new DispatchAcceptanceError(
          'Dispatch has already been accepted',
          'DISPATCH_ALREADY_ACCEPTED',
          409,
        );
      }
      if (existingDispatch.expires_at && existingDispatch.expires_at <= now) {
        throw new DispatchAcceptanceError('Dispatch has expired', 'DISPATCH_EXPIRED', 410);
      }
      throw new DispatchAcceptanceError(
        `Dispatch is in terminal state '${existingDispatch.status}' and cannot be accepted`,
        'DISPATCH_NOT_ACTIONABLE',
        409,
      );
    }

    if (updateResult.count > 1) {
      throw new DispatchAcceptanceError(
        'Invariant violation: Multiple dispatch records updated',
        'INVARIANT_VIOLATION_MULTIPLE_DISPATCHES',
        500,
      );
    }

    // 6. Generate cryptographic OTP & create booking
    const otp = generateOTP();
    const otp_hash = await hashOTP(otp);

    const booking = await tx.booking.create({
      data: {
        job_id: req.job_id,
        requirement_id: requirementId,
        worker_id: workerId,
        customer_id: req.job.customer_id,
        status: 'confirmed',
        otp_hash,
      },
      select: bookingSafeSelect,
    });

    // 7. Atomic capacity increment
    const newFilled = (req.worker_count_filled ?? 0) + 1;
    const nowFilled = newFilled >= req.worker_count_needed;

    await tx.job_requirement.update({
      where: { id: requirementId },
      data: {
        worker_count_filled: newFilled,
        status: nowFilled ? 'filled' : 'dispatching',
      },
    });

    // 8. If capacity filled, expire all remaining pending dispatches
    let expiredWorkerIds: string[] = [];
    let jobFullyBooked = false;
    if (nowFilled) {
      const pendingDispatches = await tx.job_dispatch.findMany({
        where: { requirement_id: requirementId, status: 'pending' },
        select: { worker_id: true },
      });
      expiredWorkerIds = pendingDispatches.map((d) => d.worker_id);

      await tx.job_dispatch.updateMany({
        where: { requirement_id: requirementId, status: 'pending' },
        data: { status: 'expired', responded_at: new Date() },
      });

      jobFullyBooked = await checkJobComplete(req.job_id, tx);
    }

    return { booking, otp, nowFilled, newFilled, needed: req.worker_count_needed, jobId: req.job_id, customerId: req.job.customer_id, skillType: req.skill_type, expiredWorkerIds, jobFullyBooked };
  });

  // Post-commit notifications outside transaction in non-blocking try-catch blocks
  ...
};
```

---

## 7. Authentication, Identity, & RBAC

1. **Identity Source**: The worker identity is derived exclusively from `req.user.id` populated by `authenticateJWT`.
2. **Client-Controlled Identity Rejection**: Both `acceptJob` and `declineJob` reject any client-supplied `worker_id` or `workerId` in the request body or query string with `400 Bad Request`.
3. **Route RBAC**:
   `src/features/dispatch/dispatchRoutes.ts` now enforces:
   ```typescript
   router.post("/:requirementId/accept", authenticateJWT, requireRole(UserRole.WORKER), acceptJob);
   router.post("/:requirementId/decline", authenticateJWT, requireRole(UserRole.WORKER), declineJob);
   router.get("/incoming", authenticateJWT, requireRole(UserRole.WORKER), getIncoming);
   router.get("/:requirementId", authenticateJWT, requireRole(UserRole.WORKER), getDispatchDetail);
   ```

---

## 8. Concurrency & Race Conditions

1. **Row-Level Lock**: Every acceptance transaction executes `SELECT id FROM job_requirement WHERE id = $1 FOR UPDATE`. This serializes multiple workers competing for slots on the same requirement.
2. **Same-Worker Concurrency**: Tested with 10 concurrent requests from the same worker. Exactly 1 transaction succeeds; the remaining 9 are rejected with 409 (`DISPATCH_ALREADY_ACCEPTED` or `BOOKING_ALREADY_EXISTS`).
3. **Multi-Worker Slot Race**: Tested with Worker A and Worker B racing for 1 remaining slot. Exactly 1 worker wins and receives a booking; the second worker is rejected with 409 `SLOTS_FULL`. `worker_count_filled` never exceeds `worker_count_needed`.

---

## 9. Automated Regression & Security Coverage

Created `tests/dispatchAcceptanceSecurity.test.ts` covering 17 exhaustive test scenarios across all 13 audit invariants:

| # | Test Name | Description | Result |
|---|:---|:---|:---:|
| 1 | Unauthenticated Request | `POST /api/dispatch/:requirementId/accept` without token returns 401 | **PASS** |
| 2 | Customer Role Attempt | Customer token returns 403 Forbidden with zero DB mutations | **PASS** |
| 3 | Another Worker's Dispatch | Worker A accepting dispatch assigned to Worker B returns 404 `NO_VALID_DISPATCH` | **PASS** |
| 4 | Valid Own Dispatch | Worker A accepting own valid pending dispatch returns 200, creates booking with OTP hash | **PASS** |
| 5 | Requirement ID Alone | Worker A knowing requirement ID but having no dispatch row returns 404 | **PASS** |
| 6 | Expired Dispatch | Dispatch with `expires_at < now` returns 410 `DISPATCH_EXPIRED` | **PASS** |
| 7 | Double Acceptance / Replay | Replaying acceptance returns 409 `DISPATCH_ALREADY_ACCEPTED` | **PASS** |
| 8a | Terminal State: timeout | Dispatch with status `timeout` returns 409 `DISPATCH_NOT_ACTIONABLE` | **PASS** |
| 8b | Terminal State: declined | Dispatch with status `declined` returns 409 `DISPATCH_NOT_ACTIONABLE` | **PASS** |
| 8c | Terminal State: expired | Dispatch with status `expired` returns 409 `DISPATCH_NOT_ACTIONABLE` | **PASS** |
| 9 | Transaction Rollback | Failure during `booking.create` rolls back dispatch to `pending` and zero bookings | **PASS** |
| 10a | Identity Spoofing Body | Request body with `worker_id` returns 400 | **PASS** |
| 10b | Identity Spoofing Query | Query parameter with `worker_id` returns 400 | **PASS** |
| 10c | Identity Spoofing Decline | Decline endpoint rejecting client `workerId` with 400 | **PASS** |
| 11 | Same-Worker Concurrency | 10 concurrent requests yield exactly 1 booking and 1 accepted dispatch | **PASS** |
| 12 | Competing Workers for Final Slot | Concurrent race between 2 workers yields 1 winner (200), 1 rejected (409), capacity = 1 | **PASS** |
| 13 | Filled Requirement Rejection | Requirement with `status = 'filled'` returns 409 `SLOTS_FULL` | **PASS** |

---

## 10. Verification Evidence

Commands executed:
- `npx jest tests/dispatchAcceptanceSecurity.test.ts`: **17 / 17 passed**
- `npx jest tests/bullmqDispatchSecurity.test.ts`: **24 / 24 passed**
- `npx jest tests/dispatchRadiusSecurity.test.ts`: **13 / 13 passed**
- `npm test`: **11 / 11 suites passed, 243 / 243 tests passed**
- `npm run build`: **TypeScript build succeeded with 0 errors**
- `npx prisma validate`: **Schema is valid**

---

## 11. Related Findings & Residual Risks

- **Finding #9 (Dispatch Acceptance Proof)**: **FULLY RESOLVED**.
- **Finding #10 (Duplicate Bookings)**: Addressed at application level in `acceptDispatch` via `tx.booking.findFirst({ where: { requirement_id, worker_id } })`. Database-level composite uniqueness index on `(requirement_id, worker_id)` remains tracked under Finding #10.
- **Finding #43 (Dispatch Idempotency)**: Addressed via atomic conditional update and state machine checks.
- **Finding #44 (Atomic Capacity Reservation)**: Enforced via `SELECT FOR UPDATE` on `job_requirement` inside transaction.
