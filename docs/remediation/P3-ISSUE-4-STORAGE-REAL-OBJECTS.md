# P3 Issue 4 Remediation: Private Identity Document Storage & Real Object Persistence

## Executive Summary
Prior to this remediation, `src/providers/storage/storage.service.ts` operated as an in-memory stub where `putObject` and `deleteObject` performed no physical persistence, and `objectExists` returned `true` unconditionally without verifying whether any physical or durable object existed in storage. Furthermore, signed URLs were generated without a durable verification endpoint, and no hardened abstraction existed for private S3/Supabase/local physical object storage.

This remediation replaces the in-memory mock implementation with a production-grade, multi-driver private storage architecture featuring real physical persistence, constant-time HMAC-SHA256 signature verification, strict path traversal defense, and end-to-end authorization controls.

---

## 1. Vulnerability & Architectural Analysis

### The Flaw
1. **Mock Persistence**: `storage.service.ts` contained placeholder methods for `putObject` and `deleteObject`, failing to write bytes to durable storage.
2. **False Object Existence**: `objectExists` returned `true` unconditionally, creating a false illusion of persistence where the application assumed a worker's identity document was securely stored.
3. **Missing Secure Download Boundary**: Signed URLs pointed to placeholder endpoints or assumed public bucket direct downloads without verifying timing-safe HMAC signatures or TTL expiration.
4. **No Storage Driver Strategy**: No modular abstraction existed to switch between cloud private buckets (Supabase S3) and durable local filesystem storage with path sanitization.

### Security Invariants Enforced
- **Physical Verification**: `objectExists` queries the actual underlying driver (`fs.promises.stat` or cloud bucket metadata) and returns `false` if the object does not physically exist.
- **Fail-Closed Production Driver Selection**: Production environments (`NODE_ENV === "production"`) require `STORAGE_PROVIDER=supabase` and valid credentials (`SUPABASE_URL`, `SUPABASE_SECRET_KEY`). `LocalStorageDriver` and in-memory mock storage are strictly rejected with fatal startup errors via `assertProductionStorageConfig()`.
- **Zero Fallback in Production**: `SupabaseStorageDriver` has zero fallback to local filesystem storage in production (`fallbackDriver === null`). Any error from the cloud provider immediately fails closed.
- **Strict Authorization First**: Signed download URLs are generated **only** after authenticating the principal, verifying role permissions, ensuring worker ownership (preventing IDOR), and checking physical existence.
- **Short-Lived Signed URLs**: Signed URLs use configurable TTL (`DOCUMENT_SIGNED_URL_TTL_SECONDS`, default 900s), HMAC-SHA256 signatures, and constant-time verification (`crypto.timingSafeEqual`).
- **Path Traversal Protection**: Storage keys are sanitized and validated against directory traversal attacks (`../`, `%2e%2e`, null bytes, control characters).
- **DTO Sanitization**: Worker public/customer DTOs never expose private document storage keys or signed URLs.
- **Auditable Admin Access**: When an administrator accesses a worker's sensitive identity document, a durable `DOCUMENT_ACCESSED` audit log is written, recording actor, target, timestamp, and IP, while explicitly omitting the signed URL.

---

## 2. Architecture & Components

```
Client (Worker / Admin)
       │
       ▼ [Authenticate JWT]
Express Route (/api/workers/me/documents or /api/admin/workers/:id/documents)
       │
       ▼ [Authorize & IDOR Check]
WorkerService.getWorkerDocumentAccessUrl()
       │
       ▼ [Verify Physical Existence via Driver]
StorageService.objectExists(storageKey)
  ├── SupabaseStorageDriver (Production Cloud Bucket)
  └── LocalStorageDriver (Development / Test Local Filesystem)
       │
       ▼ [Generate HMAC-SHA256 Signed URL with TTL]
StorageService.getSignedUrl(storageKey, "GET", { expiresIn: 900 })
       │
       ▼ [Audit Log: DOCUMENT_ACCESSED] (Admin only)
Prisma.audit_log.create() (Omits signed URL from logs)
       │
       ▼ [Return Short-Lived URL]
Client downloads via GET /api/storage/download/:key?expires=...&signature=...
       │
       ▼ [Verify HMAC & Expiry via timingSafeEqual]
StorageController.downloadObject()
       │
       ▼ [Stream Private Binary Bytes]
StorageDriver.getObject(storageKey)
```

### Storage Drivers
1. **`StorageDriver` Interface** (`src/providers/storage/storage.types.ts`):
   - `putObject(key: string, body: Buffer, contentType?: string): Promise<{ key: string; size: number }>`
   - `getObject(key: string): Promise<{ data: Buffer; contentType: string } | null>`
   - `deleteObject(key: string): Promise<boolean>`
   - `objectExists(key: string): Promise<boolean>`
2. **`LocalStorageDriver`** (`src/providers/storage/localStorageDriver.ts`):
   - Development & test filesystem storage rooted in `STORAGE_LOCAL_ROOT` (`./uploads` or designated directory).
   - Constructor explicitly throws `Error` if instantiated when `NODE_ENV === "production"`.
   - Enforces `resolveSafePath` to eliminate directory traversal.
   - Real `fs.promises.writeFile`, `fs.promises.readFile`, `fs.promises.stat`, `fs.promises.unlink`.
3. **`SupabaseStorageDriver`** (`src/providers/storage/supabaseStorageDriver.ts`):
   - Production private S3/Supabase bucket integration.
   - In production (`NODE_ENV === "production"`), `fallbackDriver` is strictly set to `null` and any operation failure throws a fatal error (fails closed).
4. **`StorageService`** (`src/providers/storage/storage.service.ts`):
   - Provides unified API, HMAC-SHA256 signature generation, constant-time verification (`verifySignedUrl`), and key sanitization.
5. **`StorageController` & Routes** (`src/providers/storage/storage.controller.ts`, `storage.routes.ts`):
   - Exposes `GET /api/storage/download/:key` and `PUT /api/storage/upload/:key`.
   - Validates signatures and TTL, streaming binary files with correct `Content-Type` and `Content-Disposition`.
6. **`assertProductionStorageConfig`** (`src/config/storageConfig.ts`):
   - Integrated into `lifecycleManager.ts` startup sequence.
   - Ensures `STORAGE_PROVIDER`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `STORAGE_BUCKET_NAME`, and `STORAGE_SIGNING_SECRET` are validated before the HTTP server accepts traffic.

---

## 3. Verification & Test Matrix

### Test Suites (59 Tests, 100% PASS)
- **`tests/storageProductionFailClosed.test.ts` (16 Tests)**:
  - Startup fails if `STORAGE_PROVIDER` is missing or `'local'` in production.
  - Startup fails if `SUPABASE_URL` or `SUPABASE_SECRET_KEY` is missing in production.
  - Startup fails if `STORAGE_SIGNING_SECRET` is insecure in production.
  - `LocalStorageDriver` constructor throws in production.
  - `SupabaseStorageDriver` in production has `fallbackDriver === null`.
  - `StorageService` constructor throws in production without cloud provider.
  - Missing, invalid, expired, method-mismatched, and cross-worker signatures are rejected (403).
  - Directory traversal attacks (`../../etc/passwd`) are rejected.
  - Binary streaming with valid signed URL succeeds (200).
  - Multi-instance persistence verified across independent `StorageService` instances.
  - DTO boundaries: `toWorkerPublicDTO`, `toWorkerSelfDTO`, `toWorkerAdminDTO`, and `toWorkerDocumentMetadataDTO` strip all storage keys, signed URLs, and bucket names.
- **`tests/storageServiceReal.test.ts` (19 Tests)**:
  - Physical file persistence, read, stat, delete.
  - Traversal attack protection.
  - Dynamic HMAC-SHA256 signed URL generation and expiration.
  - Endpoints `GET /api/storage/download/:key` and `PUT /api/storage/upload/:key`.
- **`tests/workerDocumentSecurity.test.ts` (24 Tests)**:
  - Unauthenticated access rejection (401).
  - Worker A access to own document (200).
  - Worker B IDOR attempt on Worker A's document (403).
  - Customer attempt to access worker documents (403).
  - Admin access generates `DOCUMENT_ACCESSED` audit event.
  - Worker public DTOs never expose document storage keys or URLs.

---

## 4. Definition of Done Checklist
- [x] Mock/in-memory storage removed from production paths.
- [x] Real private object-storage driver implemented with physical persistence.
- [x] Identity documents stored privately; anonymous direct access denied.
- [x] `objectExists` verifies actual durable storage state.
- [x] Fail-closed driver selection in production (`assertProductionStorageConfig` in `lifecycleManager.ts`).
- [x] Zero production fallback to `LocalStorageDriver` or in-memory storage.
- [x] Authorization checked before signed URL generation.
- [x] IDOR protection enforced (Worker B cannot access Worker A's document).
- [x] Customer access to worker identity documents rejected.
- [x] Signed URLs are short-lived with HMAC-SHA256 verification and timing-safe checks.
- [x] Signed URLs never stored permanently in the database or logged in audit records.
- [x] Document storage keys never exposed in public worker DTOs.
- [x] Admin document access is durably audited without logging signed URLs.
- [x] Path traversal attacks are sanitized and rejected.
- [x] TypeScript typecheck, build, and automated test suites pass with 0 errors.
