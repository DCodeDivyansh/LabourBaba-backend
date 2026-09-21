# Secret Management & Rotation Runbook (Issue #58)

## 1. Secret Inventory & Classification

| Category | Environment Variable(s) | Description & Sensitivity | Storage Location |
| :--- | :--- | :--- | :--- |
| **Authentication Keys** | `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Critical HMAC-SHA256 signing keys for access/refresh sessions | AWS Secrets Manager / Vault / CI Secrets |
| **Database Credentials** | `DATABASE_URL`, `DIRECT_URL` | PostgreSQL connection strings with user/password credentials | AWS Secrets Manager / KMS |
| **Cache & Queue Credentials** | `REDIS_URL`, `REDIS_HOST`, `REDIS_PASSWORD` | Redis authentication tokens for BullMQ & rate limiters | AWS Secrets Manager |
| **SMS Gateway Credentials** | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` | Twilio / HTTP SMS provider API authentication tokens | AWS Secrets Manager |
| **Payment Gateway** | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Payment order creation and webhook signature validation keys | AWS Secrets Manager |
| **Push Notification** | `FIREBASE_SERVICE_ACCOUNT_JSON` | Firebase Admin SDK service account for FCM push delivery | AWS Secrets Manager |

---

## 2. Startup Fail-Fast Validation
During application startup in `NODE_ENV=production`, the `lifecycleManager.startup()` sequence executes the following gatekeepers:
1. `assertJwtConfig()`: Verifies min 32-character high-entropy distinct access/refresh keys; rejects known placeholder secrets.
2. `assertProductionAuthConfig()`: Blocks `mock` SMS provider in production; requires valid provider credentials.
3. `assertProductionPaymentConfig()`: Verifies Razorpay Key ID, Key Secret, and Webhook Secret exist and meet length criteria.
4. `assertRedisConfig()`: Verifies remote Redis host/URL and rejects `127.0.0.1`/`localhost` in production.
5. `assertFcmConfig()`: Verifies Firebase Service Account JSON credentials exist.

---

## 3. Standard Secret Rotation Workflows

### 3.1. JWT Secret Rotation
1. **Phase 1 (Preparation)**: Generate new 64-character hex secret via `openssl rand -hex 32`.
2. **Phase 2 (Dual Acceptance)**:
   - Deploy new key as `JWT_ACCESS_SECRET`.
   - Keep old key available under `JWT_ACCESS_SECRET_PREVIOUS` during grace window (default: 2 hours) to permit existing active access tokens to expire naturally without abrupt logout.
3. **Phase 3 (Finalization)**: Remove previous key once active access tokens expire.

### 3.2. Provider API Keys (Twilio & Razorpay)
1. Generate secondary API key in provider dashboard (e.g. Razorpay / Twilio Console).
2. Update secret in secret manager (`.env.production`).
3. Trigger rolling restart of application containers.
4. Revoke previous secondary key in provider console once traffic migrates.

### 3.3. Database & Redis Credentials
1. Create new database user / Redis token with identical permissions.
2. Update `DATABASE_URL` / `REDIS_URL` in Secrets Manager.
3. Perform rolling container deployment.
4. Terminate old database user connections and drop old role.

---

## 4. Emergency Revocation & Incident Response
If a credential is leaked or compromised:
1. **Immediate Revocation**: Revoke the compromised API key/token in the respective provider dashboard immediately.
2. **Key Regeneration**: Provision a replacement secret with fresh cryptographic entropy.
3. **Emergency Secret Injection**: Update environment variables in container orchestrator / ECS / Kubernetes task definition.
4. **Force Restart**: Execute immediate rolling restart of all backend replicas (`kubectl rollout restart` or AWS ECS service update).
5. **Audit Trail Review**: Query `audit_log` and application logs using correlation IDs to identify unauthorized operations during the exposure window.
