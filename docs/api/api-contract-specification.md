# LabourBaba API Contract Specification (Issue #59)

## 1. Global Architectural & Security Standards

### 1.1. Base URL & Protocol
- **Production**: `https://api.labourbaba.com`
- **Staging**: `https://staging-api.labourbaba.com`
- **Development**: `http://localhost:5000`

### 1.2. Authentication & Authorization Headers
All protected endpoints require an HTTP `Authorization` Bearer token:
```http
Authorization: Bearer <JWT_ACCESS_TOKEN>
```
Standard correlation headers:
- `X-Request-ID`: Distributed request tracing identifier.
- `X-Correlation-ID`: End-to-end user operation correlation identifier.

### 1.3. Standard Error Response Contract (Issue #40)
```json
{
  "success": false,
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "The requested resource was not found.",
    "request_id": "c8f1e948-c279-4109-b68e-998a76e1a90f",
    "details": null
  }
}
```

---

## 2. Public & Protected Route Inventory

### 2.1. System & Observability
| Method | Path | Auth | Role | Description |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/health` | Public | Any | System liveness probe (`status: "OK"`) |
| `GET` | `/health/ready` | Public | Any | Readiness probe verifying DB & Redis connectivity |
| `GET` | `/metrics` | Public / Scraper | Any | Prometheus business & operational metrics |
| `GET` | `/api-docs` | Public | Any | Swagger UI interactive documentation |
| `GET` | `/api-spec.json` | Public | Any | OpenAPI 3.0.0 JSON specification |

### 2.2. Authentication (`/api/auth`)
| Method | Path | Auth | Role | Description |
| :--- | :--- | :--- | :--- | :--- |
| `POST` | `/api/auth/register` | Public | Any | Request signup OTP challenge |
| `POST` | `/api/auth/login` | Public | Any | Request login OTP challenge |
| `POST` | `/api/auth/verify-otp` | Public | Any | Verify challenge OTP and issue JWT token pair |
| `POST` | `/api/auth/refresh` | Bearer | Any | Rotate refresh token and issue fresh access token |
| `POST` | `/api/auth/logout` | Bearer | Any | Revoke active refresh session |
| `GET` | `/api/auth/sessions` | Bearer | Any | List active sessions for authenticated principal |

### 2.3. Jobs & Requirements (`/api/jobs`)
| Method | Path | Auth | Role | Description |
| :--- | :--- | :--- | :--- | :--- |
| `POST` | `/api/jobs` | Bearer | Customer | Create job and skill requirements |
| `GET` | `/api/jobs` | Bearer | Customer | List authenticated customer's jobs |
| `GET` | `/api/jobs/:id` | Bearer | Customer / Admin | Retrieve job detail with requirements |
| `PATCH` | `/api/jobs/:id/cancel` | Bearer | Customer | Cancel open job |

### 2.4. Worker GPS Location (`/api/worker_location`)
| Method | Path | Auth | Role | Description |
| :--- | :--- | :--- | :--- | :--- |
| `POST` | `/api/worker_location` | Bearer | Worker | Ingest validated PostGIS coordinates |
| `GET` | `/api/worker_location/latest` | Bearer | Worker | Retrieve latest recorded GPS point |

### 2.5. Dispatch & Matching (`/api/dispatch`)
| Method | Path | Auth | Role | Description |
| :--- | :--- | :--- | :--- | :--- |
| `POST` | `/api/dispatch/accept` | Bearer | Worker | Accept dispatch invitation & reserve slot |
| `POST` | `/api/dispatch/reject` | Bearer | Worker | Decline dispatch invitation |

### 2.6. Bookings & Lifecycle (`/api/bookings`)
| Method | Path | Auth | Role | Description |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/bookings/:id` | Bearer | Customer / Worker | Retrieve booking status and details |
| `POST` | `/api/bookings/:id/verify-otp` | Bearer | Worker | Verify customer OTP to start work (`IN_PROGRESS`) |
| `POST` | `/api/bookings/:id/complete` | Bearer | Worker | Request completion (`AWAITING_CONFIRMATION`) |
| `POST` | `/api/bookings/:id/confirm` | Bearer | Customer | Confirm completion and submit review (`COMPLETED`) |
| `POST` | `/api/bookings/:id/cancel` | Bearer | Customer / Worker | Cancel booking with reason |

### 2.7. Admin Operations (`/api/admin`)
| Method | Path | Auth | Role | Description |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/api/admin/audit-logs` | Bearer | Admin | Query security audit trail with filtering |
| `GET` | `/api/admin/stats` | Bearer | Admin | High-level system statistics |
