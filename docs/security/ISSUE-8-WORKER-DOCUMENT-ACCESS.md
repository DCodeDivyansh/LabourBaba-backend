# Issue 8 — Harden Worker-Document Access & Private Storage

## 1. Problem Description
Worker verification documents (Aadhaar, PAN, certificates) contain sensitive PII that must never be publicly exposed, stored on unauthenticated CDN paths, or leaked in general worker profiles.

## 2. Invariants & Implementation
1. **Private Object Storage**: `StorageService` in `src/providers/storage/storage.service.ts` derives opaque object keys `workers/{workerId}/documents/{uuid}.{ext}` that never contain PII.
2. **Short-Lived Signed URLs**: Time-limited HMAC-SHA256 presigned URLs with 15-minute TTL (`storageConfig.signedUrlTtlSeconds = 900`).
3. **Authorization-First Access**: Signed download URLs are only generated AFTER authenticating the request and verifying role/relationship (Worker accessing own document or Admin viewing worker verification).
4. **DTO Separation**: `toWorkerPublicDTO` and `toWorkerSelfDTO` strictly exclude document storage keys, URLs, and private metadata.
5. **Durable Access Auditing**: Privileged admin access generates a durable audit record via `auditService.recordEvent` with `AuditAction.DOCUMENT_ACCESSED` without logging the signed URL itself.

## 3. Test Evidence
- Verified via `tests/workerDocumentSecurity.test.ts` (24 tests PASS) & `tests/adminAuditLogging.test.ts` (14 tests PASS).
