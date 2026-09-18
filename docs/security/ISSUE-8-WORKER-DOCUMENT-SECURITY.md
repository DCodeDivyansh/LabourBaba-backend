# Security Remediation: Issue #8 — Harden Worker-Document Access

## Priority: P0 | Category: Privacy / Sensitive Identity Documents | Original Audit Finding: #18

---

## 1. Executive Summary

Worker identity documents (Aadhaar cards, PAN cards, voter IDs, driving licences, passports) represent sensitive personal identification data (PII) entrusted to the platform for background verification and KYC purposes. Previously, worker document uploads and references lacked a private storage abstraction and signed-URL access pattern. Furthermore, there were no dedicated endpoints with explicit relationship-based authorization, nor was privileged administrative document access durably audited.

This remediation establishes a hardened, private object storage and access model:
1. **Opaque Private Storage Paths:** Document keys follow `workers/${workerId}/documents/${randomUUID}.${ext}` — zero PII or sensitive document numbers in object keys.
2. **Authorized Short-Lived Signed URLs:** Download URLs are generated using HMAC-SHA256 signatures with a strictly server-enforced TTL of 900 seconds (15 minutes). URL lifetime cannot be influenced or extended by the client.
3. **Strict Separation of Metadata vs. Content Access:** Public, self, and admin worker profile DTOs never expose document URLs or storage keys. Document content access is isolated to dedicated endpoints (`GET /api/workers/me/documents/:documentId/access` and `GET /api/admin/workers/:id/documents/:documentId/access`).
4. **IDOR & Cross-Worker Isolation:** Direct database relationship checks and centralized policies prevent any worker or customer from accessing documents belonging to another worker. Upload targets are derived strictly from the authenticated principal (`req.user.id`).
5. **Durable Administrative Audit Logging:** Privileged admin document access logs durable audit events capturing the admin ID, worker ID, document ID, and timestamp. Signed URLs and document contents are strictly excluded from audit logs and application traces.

---

## 2. Root Cause Analysis

Before remediation:
1. **Absence of Dedicated Content Access Endpoints:** The API only had `POST /api/workers/me/documents` and `GET /api/workers/me/documents`. Document file references were treated like ordinary profile strings.
2. **Missing Storage Abstraction:** There was no centralized private storage service or signed-URL generation layer for worker identity documents.
3. **Unvalidated Client-Supplied Worker IDs in Document Uploads:** `UploadWorkerDocumentReqSchema` permitted client-supplied `worker_id` in request payloads, which created a vulnerability where an attacker could attempt to bind documents across worker accounts.
4. **Missing Admin View & Audit Trail:** Admins could approve or reject workers via `PATCH /api/admin/workers/:id/verify`, but there was no controlled, audited endpoint to securely inspect worker identity documents.

---

## 3. Threat Model & Attack Scenarios Prevented

| Threat Scenario | Attack Vector | Remediation & Defense-in-Depth |
|---|---|---|
| **Cross-Worker Document IDOR** | Worker B calls `GET /api/workers/me/documents/:docId/access` using Worker A's document ID. | `assertPolicy(workerPolicy.canReadDocument(actor, doc))` enforces `actor.id === doc.worker_id`, returning 403 Forbidden. |
| **Customer Document Snooping** | Customer calls worker document access or admin access routes. | Route RBAC and policy checks strictly reject customer access (403 Forbidden). |
| **Upload Identity Spoofing** | Attacker includes a different `worker_id` in `POST /me/documents`. | Controller strictly compares payload `worker_id` against `actor.id` and rejects client-controlled worker identities (400 Bad Request). |
| **Storage Key Hijacking** | Worker A passes Worker B's storage key in `file_url` (`workers/${workerBId}/...`). | `workerService.uploadDocument` verifies `normalizedKey.startsWith('workers/' + workerId + '/')`, rejecting cross-worker attachments (403 Forbidden). |
| **Signed URL TTL Tampering** | Client supplies `?expiresIn=86400` to extend link validity. | TTL is derived strictly from server configuration (`storageConfig.signedUrlTtlSeconds = 900`). Client parameters cannot override it. |
| **Secret & Credential Leakage in Audit Logs** | Admin document viewing logged to console/files. | Audit log records administrative context (`adminId`, `workerId`, `documentId`, `timestamp`) and strictly excludes `access_url` and signing keys. |

---

## 4. Architecture: Before vs. After Remediation

### Before Remediation
```
Client
  ↓
POST /api/workers/me/documents (Client supplies arbitrary worker_id and public URL)
  ↓
Prisma worker_document (Stored arbitrary URL without ownership validation)
  ↓
No signed URL generation | No admin document access endpoint | No audit trail
```

### After Remediation
```
REQUEST (GET /api/workers/me/documents/:documentId/access)
  ↓
authenticateJWT & requireRole(UserRole.WORKER)
  ↓
validateParams(DocumentIdParamSchema) (UUID format check)
  ↓
workerService.getDocumentAccessUrl(actor, documentId)
  ↓
Prisma worker_document.findUnique({ where: { id: documentId } })
  ↓
workerPolicy.canReadDocument(actor, doc) (Enforces actor.id === doc.worker_id)
  ↓
storageService.getSignedDownloadUrl(objectKey, 900) (Server-side HMAC-SHA256 signature)
  ↓
Return toWorkerDocumentAccessDTO (document_id, worker_id, document_type, access_url, expires_in)
```

---

## 5. Endpoints & API Contract

### Worker Endpoints
- `POST /api/workers/me/documents/upload-url` (Worker only):
  - Request: `{ document_type: "AADHAAR" | "PAN" | ..., file_extension?: string }`
  - Response: `{ upload_url: string, object_key: string, expires_in: number }`
- `POST /api/workers/me/documents` (Worker only):
  - Validates `worker_id === actor.id` and that `file_url` is scoped to `workers/${actor.id}/documents/`.
- `GET /api/workers/me/documents` (Worker only):
  - Lists worker's document metadata.
- `GET /api/workers/me/documents/:documentId/access` (Worker only):
  - Returns short-lived signed download URL (900s TTL).

### Admin Endpoints
- `GET /api/admin/workers/:id/documents` (Admin only):
  - Lists document metadata for specified worker.
- `GET /api/admin/workers/:id/documents/:documentId/access` (Admin only):
  - Verifies document belongs to worker.
  - Durably records audit log: `[AUDIT] Admin ${adminId} viewed document ${documentId} of worker ${workerId} at ${ISO}`.
  - Returns short-lived signed download URL (900s TTL).

---

## 6. Verification Results

- **Unit & Security Suite:** `npx jest tests/workerDocumentSecurity.test.ts`
  - **24/24 tests passed** (100% pass rate).
- **DTO & Policy Regression:** `tests/dtoAllowlist.test.ts`, `tests/dtoBoundarySecurity.test.ts`, `tests/crossResourceSecurity.test.ts`, `tests/policies/authorizationPolicies.test.ts`
  - **80/80 tests passed**.
- **Full Test Suite:** `npm test`
  - **24 test suites passed, 589/589 tests passed**.
- **TypeScript Typecheck:** `npx tsc --noEmit` — Exit code 0.
- **Production Build:** `npm run build` — Exit code 0.
