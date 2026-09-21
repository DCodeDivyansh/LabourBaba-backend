# Walkthrough — Issue #24: Reserve Booking Capacity Atomically

## Overview and invariant

`job_requirement.worker_count_needed` is the demand and
`worker_count_filled` is the persisted capacity ledger. A capacity-consuming
booking is a booking in an active lifecycle state (confirmed, in progress,
completion requested, or completed). The invariant is:

`0 <= worker_count_filled = active booking count <= worker_count_needed`.

Cancelled bookings release capacity through the cancellation transaction.

## Flow and concurrency strategy

The only production `booking.create` path is worker dispatch acceptance:
authenticated worker → owned pending `job_dispatch` → `acceptDispatch` →
booking. `acceptDispatch` locks its `job_requirement` using PostgreSQL
`SELECT ... FOR UPDATE`. The lock makes the requirement row a cross-process
capacity ledger. While holding it, the service validates the latest requirement,
dispatch, duplicate-booking identity, and capacity; it then increments the
ledger and transitions the requirement state **before** it creates the booking.
Both writes, dispatch acceptance, pending-dispatch expiry, and job state changes
are in one Prisma transaction. A failed booking create rolls back the ledger
reservation and dispatch update.

No network calls run under this lock. Socket events occur only after commit.

## Database backstops and failure semantics

`uniq_booking_requirement_worker` prevents duplicate business bookings. The
Issue #24 migration makes `worker_count_filled` non-null and adds
`worker_count_filled <= worker_count_needed` alongside the existing non-negative
check. Full capacity and duplicate attempts return
stable 409 domain errors (`SLOTS_FULL` or `BOOKING_ALREADY_EXISTS`); expired
dispatches return 410. Row locking at PostgreSQL's default isolation level is
sufficient here, so no transaction retry loop is used.

Cancellation reconciliation acquires the same requirement lock before deriving
the active-booking count, preventing a cancellation's stale count from
overwriting a concurrent reservation.

## Testing

`tests/bookingCapacityPostgresConcurrency.test.ts` is an unmocked PostgreSQL
suite exercising the real acceptance service. It proves 1, 2, and 10 capacity
requirements against 50 simultaneous workers, validates the persisted counter,
non-negative remaining capacity, booking count, and duplicate business identity.
It also exercises concurrent duplicate retries for one worker. Existing dispatch
acceptance tests cover rollback when `booking.create` fails after reservation.
