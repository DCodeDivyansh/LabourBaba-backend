-- AlterTable: add refund, quarantine, and timestamp fields to payment table
ALTER TABLE "payment" 
  ADD COLUMN IF NOT EXISTS "razorpay_refund_id" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "refund_amount" INTEGER,
  ADD COLUMN IF NOT EXISTS "refund_status" VARCHAR(30),
  ADD COLUMN IF NOT EXISTS "refund_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "quarantine_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Create unique index on razorpay_refund_id
CREATE UNIQUE INDEX IF NOT EXISTS "payment_razorpay_refund_id_key" ON "payment"("razorpay_refund_id");

-- Create status & created_at composite index for reconciliation worker
CREATE INDEX IF NOT EXISTS "idx_payment_status_created" ON "payment"("status", "created_at");

-- Create index on razorpay_payment_id
CREATE INDEX IF NOT EXISTS "idx_payment_razorpay_payment_id" ON "payment"("razorpay_payment_id");
