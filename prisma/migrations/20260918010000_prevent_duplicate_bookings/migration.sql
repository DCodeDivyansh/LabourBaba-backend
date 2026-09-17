-- Step 1: Reconcile any pre-existing duplicate bookings before applying the unique constraint.
-- If duplicate bookings exist for the same (requirement_id, worker_id), retain the authoritative one:
-- prioritizing active/in-progress/completed states, earliest created_at, and stable id as tie-breaker.
DELETE FROM "booking" b1
WHERE b1.id IN (
    SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                   PARTITION BY requirement_id, worker_id
                   ORDER BY
                       CASE
                           WHEN LOWER(status) IN ('confirmed', 'in_progress', 'completed') THEN 1
                           WHEN LOWER(status) = 'cancelled' THEN 2
                           ELSE 3
                       END,
                       created_at ASC,
                       id ASC
               ) as rnum
        FROM "booking"
    ) ranked
    WHERE ranked.rnum > 1
);

-- Step 2: Create composite unique constraint to enforce at most one booking per (requirement_id, worker_id) at the database level.
CREATE UNIQUE INDEX "uniq_booking_requirement_worker" ON "booking"("requirement_id", "worker_id");
