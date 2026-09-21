# Payment Secrets & Emergency Controls (Issue 74)

## Overview & Zero-Leakage Policy
All payment credentials (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`) are server-only secrets. They are strictly prohibited from:
- Being checked into version control (.gitignore & git-secrets enforcement).
- Being included in client-facing DTOs or responses.
- Being logged in structured logs (automatic redaction via Winston logger filter).
- Being embedded in Docker image layers or build artifacts.

## Startup Configuration Validation
At boot time, `src/config/environment.ts` validates required payment variables:
- Missing `RAZORPAY_KEY_ID` or `RAZORPAY_KEY_SECRET` in `NODE_ENV=production` halts application boot immediately with exit code 1.
- In `NODE_ENV=test`, fallback mocks or staging keys are safely segregated.

## Emergency Credential Rotation Procedure

When a credential compromise or routine rotation occurs, follow this runbook:

```
                  EMERGENCY ROTATION WORKFLOW
                  ───────────────────────────
   1. Generate new Key/Secret in Razorpay Dashboard
                        │
                        ▼
   2. Update AWS Secrets Manager / Vault (New Secret)
                        │
                        ▼
   3. Update Razorpay Webhook URL / Secret (Dual-Auth window)
                        │
                        ▼
   4. Trigger Zero-Downtime Rolling Redeployment
                        │
                        ▼
   5. Verify Health: Smoke Test Order Creation & Webhook
                        │
                        ▼
   6. Revoke Old Key/Secret in Razorpay Dashboard
                        │
                        ▼
   7. Log Security Incident & Rotation Event in Audit Log
```

### Step-by-Step Execution:
1. **Provider Key Generation**: Log in to the Razorpay Dashboard (Production/Staging). Generate a new Key Pair without immediately deleting the old pair.
2. **Secrets Manager Update**: Update `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and `RAZORPAY_WEBHOOK_SECRET` in your environment orchestrator (e.g. AWS Secrets Manager, Kubernetes Secret, or Doppler).
3. **Webhook Secret Update**: Add the new webhook secret to the Razorpay Webhook settings.
4. **Rolling Redeploy**: Execute `docker compose -f docker-compose.prod.yml up -d --no-deps --build app` or Kubernetes rolling rollout.
5. **Validation Verification**: Execute `npm run test:payment:smoke` to verify order creation and webhook acceptance.
6. **Provider Revocation**: Immediately deactivate the old key pair in the provider console.
7. **Audit Record**: Insert an audit entry in `AuditLog` table: `action: "SECRETS_ROTATED"`.
