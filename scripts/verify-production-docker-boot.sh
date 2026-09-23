#!/bin/sh
set -e

# LabourBaba Backend — P6 Issue 10 Production Docker Boot Verification Shell Wrapper
echo "Starting LabourBaba Production Docker Boot Verification..."
npx tsx scripts/verify-production-docker-boot.ts
