-- AlterTable
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "confirmed_at" TIMESTAMPTZ(6);
