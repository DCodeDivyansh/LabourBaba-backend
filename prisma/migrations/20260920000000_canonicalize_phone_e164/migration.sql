-- Issue #12: Canonicalize Phone Identity (E.164)
--
-- 1. Expands worker.phone and customer.phone columns from VARCHAR(15) to VARCHAR(20)
-- 2. Normalizes legacy phone entries by removing formatting characters (spaces, hyphens, parens, dots)
-- 3. Detects collisions after normalization and fails closed if duplicates are found
-- 4. Preserves existing unique constraints on worker(phone) and customer(phone)

-- Phase 1: Expand column widths to accommodate full E.164 formatted strings (+ country code + digits)
ALTER TABLE "worker" ALTER COLUMN "phone" TYPE VARCHAR(20);
ALTER TABLE "customer" ALTER COLUMN "phone" TYPE VARCHAR(20);

-- Phase 2: Normalize existing data (strip whitespace, hyphens, parentheses, and dots)
UPDATE "worker"
SET phone = regexp_replace(phone, '[\s\-\(\)\.]', '', 'g')
WHERE phone ~ '[\s\-\(\)\.]';

UPDATE "customer"
SET phone = regexp_replace(phone, '[\s\-\(\)\.]', '', 'g')
WHERE phone ~ '[\s\-\(\)\.]';

-- Phase 3: Collision Detection Guard
-- If two previously formatted numbers normalize to the exact same value, abort migration to prevent silent overwrites.
DO $$
DECLARE
  worker_collision_count INT;
  customer_collision_count INT;
BEGIN
  SELECT COUNT(*) INTO worker_collision_count FROM (
    SELECT phone FROM "worker" GROUP BY phone HAVING COUNT(*) > 1
  ) t;

  IF worker_collision_count > 0 THEN
    RAISE EXCEPTION 'MIGRATION ABORTED: % worker phone collision(s) detected after normalization. Manual remediation required.', worker_collision_count;
  END IF;

  SELECT COUNT(*) INTO customer_collision_count FROM (
    SELECT phone FROM "customer" GROUP BY phone HAVING COUNT(*) > 1
  ) t;

  IF customer_collision_count > 0 THEN
    RAISE EXCEPTION 'MIGRATION ABORTED: % customer phone collision(s) detected after normalization. Manual remediation required.', customer_collision_count;
  END IF;
END $$;
