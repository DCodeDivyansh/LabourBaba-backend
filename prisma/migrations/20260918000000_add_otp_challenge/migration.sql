-- CreateTable
CREATE TABLE "otp_challenge" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "phone" VARCHAR(20) NOT NULL,
    "purpose" VARCHAR(50) NOT NULL,
    "otp_hash" VARCHAR(255) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_challenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_otp_challenge_phone_purpose" ON "otp_challenge"("phone", "purpose");

-- CreateIndex
CREATE INDEX "idx_otp_challenge_expires_at" ON "otp_challenge"("expires_at");

-- Partial Unique Index: At most ONE ACTIVE challenge per (phone, purpose)
CREATE UNIQUE INDEX "uniq_active_otp_phone_purpose" ON "otp_challenge"("phone", "purpose") WHERE "status" = 'ACTIVE';
