# Issue #9 — Complete WorkerDevice Lifecycle

**Priority:** P1
**Category:** Notifications / Push Security
**Status:** RESOLVED
**Resolved in:** `src/features/worker_device/`, `src/shared/fcm.ts`, `src/workers/dispatchWorker.ts`

---

## Problem Statement

The legacy worker push notification system used a single `Worker.device_token` column as the canonical
push identity. This had the following critical weaknesses:

1. **Single-device limitation** — A worker using multiple devices (e.g. phone + tablet) could only receive
   notifications on the last device that called `PATCH /me/device-token`.
2. **No token lifecycle** — Invalid/expired FCM tokens were never cleaned up, causing silent notification failures.
3. **No token rotation** — Re-registering a device always overwrote the record; there was no history.
4. **No revocation** — Workers could not remove push access from a lost or compromised device.
5. **Token exposed in HTTP responses** — Existing tests showed `device_token` leaking through worker DTOs.

---

## Solution Architecture

### Canonical Push Identity: `worker_device` table

The `worker_device` table is now the **single authoritative source** for push delivery. Every FCM
dispatch goes through it — the legacy `Worker.device_token` column is preserved only for backward
compatibility but is never used for sending notifications.

```
Worker ──< worker_device (many) >── FCM Gateway
             ├── device_id       (stable physical device fingerprint)
             ├── fcm_token       (mutable, rotatable push token)
             ├── platform        (android | ios)
             ├── last_seen_at    (heartbeat timestamp)
             ├── revoked_at      (soft revocation — null = active)
             └── (worker_id, device_id) UNIQUE constraint
```

### Token Rotation via Upsert

`WorkerDeviceService.registerDevice()` uses a Prisma **upsert** keyed on `(worker_id, device_id)`.
Re-registering the same physical device rotates its FCM token in-place — no duplicate rows are created.
Revocation is cleared on active re-registration.

### Automatic Invalid Token Cleanup

`sendFCMToWorker()` in `src/shared/fcm.ts` classifies FCM errors:
- **Permanent errors** (`registration-token-not-registered`, `invalid-registration-token`): call
  `workerDeviceService.revokeByToken(token)` to immediately soft-revoke the device.
- **Transient errors** (network, quota): logged but not revoked; delivery continues to other devices.

### Multi-Device Dispatch

Dispatch (`dispatchWorker.ts`, `simpleDispatch.ts`) now calls `sendFCMToWorker(workerId, payload)`,
which performs a single batch query `getActiveDevicesForWorkers(workerIds)` and delivers to all
active (non-revoked) devices in parallel.

---

## New API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/workers/me/devices` | WORKER | Register or rotate a device token |
| `GET` | `/api/workers/me/devices` | WORKER | List all devices (active + revoked) |
| `DELETE` | `/api/workers/me/devices/:deviceId` | WORKER | Soft-revoke a specific device |
| `POST` | `/api/workers/me/devices/revoke` | WORKER | Revoke by device_id in body |

### Request Body — `POST /me/devices`

```json
{
  "device_token": "fcm-registration-token",
  "device_id":    "stable-physical-device-id",   // optional; SHA-256 of token if omitted
  "platform":     "android"                       // optional; defaults to android
}
```

### Response DTO — `WorkerDeviceDTO`

```json
{
  "id":           "uuid",
  "worker_id":    "uuid",
  "device_id":    "device-physical-id-001",
  "platform":     "android",
  "last_seen_at": "2026-09-19T01:00:00.000Z",
  "created_at":   "2026-09-19T01:00:00.000Z",
  "is_active":    true
}
```

> **Security invariant:** `fcm_token` is **never** returned in any HTTP response.

---

## Security Properties

| Property | Enforcement |
|----------|-------------|
| FCM token never in HTTP response | `toWorkerDeviceDTO()` omits `fcm_token`; regression test in `workerDeviceLifecycle.test.ts` |
| Cross-worker device access blocked | All DB queries scope `worker_id` to the authenticated principal |
| Invalid token auto-revoke | `isPermanentInvalidTokenError()` + `revokeByToken()` in `fcm.ts` |
| Token rotation is idempotent | Upsert on `(worker_id, device_id)` — no duplicates |

---

## Files Changed

| File | Change |
|------|--------|
| `prisma/schema.prisma` | Added lifecycle fields to `worker_device` |
| `prisma/migrations/20260919000000_worker_device_lifecycle/migration.sql` | Migration SQL + backfill |
| `src/features/worker_device/worker_device.service.ts` | **NEW** — WorkerDeviceService |
| `src/features/worker_device/worker_device.types.ts` | **NEW** — WorkerDeviceDTO + mapper |
| `src/shared/fcm.ts` | Added `sendFCMToWorker`, `isPermanentInvalidTokenError`, auto-revoke |
| `src/workers/dispatchWorker.ts` | Uses `sendFCMToWorker` instead of legacy single-token call |
| `src/features/dispatch/simpleDispatch.ts` | Uses `sendFCMToWorker` for inline FCM delivery |
| `src/features/worker/workerController.ts` | Added `registerDevice`, `getDevices`, `revokeDevice` |
| `src/features/worker/workerServices.ts` | Delegated device ops to `WorkerDeviceService` |
| `src/features/worker/workerRoutes.ts` | Mounted new device lifecycle routes |
| `src/schemas/index.ts` | Added `RegisterWorkerDeviceReqSchema`, `WorkerDeviceIdParamSchema` |
| `src/type/api_req.type.ts` | Added `RegisterWorkerDeviceReq`, `RevokeWorkerDeviceReq` |
| `tests/workerDeviceLifecycle.test.ts` | **NEW** — 27-test lifecycle suite |
| `tests/sensitiveDataLeakage.test.ts` | Added `worker_device` mock for `PATCH /me/device-token` |
| `tests/bullmqDispatchSecurity.test.ts` | Updated FCM mock/assertions to `sendFCMToWorker` |

---

## Test Results

```
Test Suites: 25 passed, 25 total
Tests:       616 passed, 616 total
```

All 27 new lifecycle tests pass. All 589 pre-existing tests continue to pass.
