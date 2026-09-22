# LabourBaba Backend

**LabourBaba Backend** is a robust, highly scalable Node.js backend API designed to power the LabourBaba platform. It handles real-time worker management, geographic job dispatching, customer bookings, chat, and payments.

The project is built using a modern stack featuring **TypeScript**, **Express**, **Prisma ORM**, and **PostgreSQL with PostGIS** for complex spatial and location-based operations.

---

## 🚀 Tech Stack

- **Framework:** Node.js with Express.js (v5.2.1)
- **Language:** TypeScript
- **Database:** PostgreSQL (via Supabase) with PostGIS extension for spatial queries
- **ORM:** Prisma Client
- **Caching & Queues:** Redis (Upstash / Aiven) & BullMQ
- **Real-time Communication:** Socket.IO
- **Push Notifications:** Firebase Cloud Messaging (FCM) via Firebase Admin SDK
- **API Documentation:** Swagger UI (OpenAPI with Zod schemas)
- **Authentication:** JWT (JSON Web Tokens) & OTP (bcrypt)
- **Payments:** Razorpay Integration

---

## 🏗 Architecture overview

The project follows a **Feature-Based (Functional) Architecture**. This ensures that the codebase is highly modular, scalable, and easy to maintain. 

Instead of traditional MVC, the `src/` directory is organized by domain features:

```text
src/
├── config/             # Global configs (Prisma, Redis, Swagger, BullMQ)
├── features/           # Feature modules (Controllers, Routes, Services)
│   ├── admin/          # Admin management (verifications, suspensions)
│   ├── auth/           # OTP, JWT, worker & customer authentication
│   ├── booking/        # Booking lifecycles and OTP verification
│   ├── chat/           # Real-time messaging
│   ├── dispatch/       # Job dispatching workflow & geographic matching
│   ├── jobs/           # Job postings and requirements
│   ├── payment/        # Razorpay payments and webhooks
│   ├── review/         # Ratings and reviews
│   ├── skill/          # Skill categories management
│   ├── worker/         # Worker profiles, analytics, and documents
│   └── worker_location/# Real-time location tracking (PostGIS)
├── middlewares/        # Global middlewares (JWT Auth, Zod Validation)
├── schemas/            # Zod validation schemas for OpenAPI
├── shared/             # Shared utilities (FCM, shared services)
├── type/               # TypeScript interfaces (Requests/Responses)
├── utils/              # Helper functions (Location WKT, Auth hashing)
├── workers/            # BullMQ background processors (Dispatch, Timeout)
└── server.ts           # App Entry Point & Socket.IO initialization
```

---

## ✨ Core Features

1. **Geospatial Job Dispatching:** Uses **PostGIS** to find online workers within specific geographic radii. Employs a "wave" system powered by **BullMQ** to send dispatch requests to batches of nearby workers sequentially until the job is accepted.
2. **Real-time Tracking:** Workers update their coordinates continuously via the `worker_location` endpoint, processed securely into geospatial `geography(Point, 4326)` columns.
3. **Real-time WebSockets:** Utilizes **Socket.IO** for live job broadcast alerts, active chat messaging, and booking status changes.
4. **Push Notifications:** Direct device alerts via **Firebase Cloud Messaging (FCM)** for offline or background alerts using device tokens.
5. **Secure Authentication:** OTP-based login (SMS) with JWT generation and lifecycle management.
6. **Zod Validation & OpenAPI:** Type-safe request/response parsing with automated Swagger documentation generation.

---

## 🛠 Prerequisites

Ensure you have the following installed before running the project:
- **Node.js** (v18+)
- **PostgreSQL** (with **PostGIS** extension enabled)
- **Redis** server (Local, Upstash, or Aiven)
- Firebase Admin SDK Service Account JSON

---

## 📦 Installation & Setup

1. **Clone the repository and install dependencies:**
   ```bash
   npm install
   ```

2. **Environment Variables:**
   Create a `.env` file in the root directory based on `.env.example`. Key variables required:
   ```env
   PORT=5000
   DATABASE_URL="postgresql://user:password@host:port/dbname?schema=public"
   REDIS_URL="redis://user:password@host:port"
   JWT_SECRET="your-secret-key"
   FRONT_END_URL="http://localhost:3000"
   APP_URL="com.labourbaba.app://"
   ```

3. **Database Setup & Migrations:**
   
   #### A. Production & Staging Deployment (Canonical Path)
   Always apply versioned Prisma migrations deterministically using `prisma migrate deploy`:
   ```bash
   # 1. Generate Prisma Client
   npx prisma generate

   # 2. Deploy versioned migrations to PostgreSQL
   npx prisma migrate deploy
   ```
   > **Important Deployment Invariant:** Never use `prisma db push` or `prisma migrate reset` in production or staging environments. All schema evolutions must be tracked in versioned migration files under `prisma/migrations/`.

   #### B. Local Development Workflow
   For developing and prototyping schema changes locally:
   ```bash
   # Create and apply a new migration during development
   npx prisma migrate dev --name <migration_name>
   ```

   #### C. Database Backup & Disaster Recovery Policy
   Before executing destructive schema migrations or major version upgrades:
   ```bash
   # Create a verified SQL backup with SHA-256 checksum:
   npx tsx scripts/backup-db.ts
   ```
   - **Rollback Limitations & Forward-Fix Strategy:** Prisma does not execute automatic down-migrations. If a production migration encounters an unrecoverable failure or data issue, restore from the pre-migration backup via `npx tsx scripts/restore-db.ts` or deploy a tested forward-fix migration.
   - **PostGIS Requirement:** PostgreSQL must have the `postgis` extension enabled (`CREATE EXTENSION IF NOT EXISTS postgis;`).

---

## 🚀 Running the Application

### Development Mode
Runs the server using `nodemon` and `tsx` for hot-reloading:
```bash
npm run dev
```

### Production Build
Compiles TypeScript to JavaScript into the `dist/` folder:
```bash
npm run build
```

### Testing
Run Jest test suites in a test environment:
```bash
npm run test
```

### Docker
The project includes Docker configurations. To run it entirely in containers:
```bash
docker-compose up --build
```

---

## 📖 API Endpoints

1.  **Health Check**
    *   **GET** `/health`
2.  **Auth** (`/api/auth`)
    *   **POST** `/api/auth/send-otp`
    *   **POST** `/api/auth/verify-otp`
    *   **POST** `/api/auth/refresh`
    *   **POST** `/api/auth/logout`
3.  **Workers** (`/api/workers`)
    *   **POST** `/api/workers/registerWorker`
    *   **POST** `/api/workers/login`
    *   **GET/PATCH** `/api/workers/me`
    *   **PATCH** `/api/workers/me/location`
    *   **PATCH** `/api/workers/me/online`
    *   **POST/GET** `/api/workers/me/documents`
    *   **GET** `/api/workers/me/analytics`, `/api/workers/me/bookings`, `/api/workers/me/earnings`
4.  **Jobs** (`/api/jobs`)
    *   **GET/POST** `/api/jobs`
    *   **GET** `/api/jobs/:jobId`
    *   **PATCH** `/api/jobs/:jobId/cancel`
    *   **GET** `/api/jobs/:jobId/requirements`, `/api/jobs/:jobId/bookings`
5.  **Dispatch** (`/api/dispatch`)
    *   **GET** `/api/dispatch/incoming`
    *   **POST** `/api/dispatch/:requirementId/accept`, `/api/dispatch/:requirementId/decline`
    *   **GET** `/api/dispatch/:requirementId/waves`
6.  **Bookings** (`/api/bookings`)
    *   **GET** `/api/bookings/:bookingId`
    *   **POST** `/api/bookings/:bookingId/otp/verify`
    *   **POST** `/api/bookings/:bookingId/complete`, `/api/bookings/:bookingId/confirm-complete`, `/api/bookings/:bookingId/cancel`
    *   **GET** `/api/bookings/:bookingId/location`
7.  **Payments** (`/api/payments`)
    *   **POST** `/api/payments/:bookingId/create-order`
    *   **POST** `/api/payments/webhook`
    *   **GET** `/api/payments/:bookingId`
    *   **POST** `/api/payments/:bookingId/refund`
8.  **Reviews** (`/api/reviews`)
    *   **POST** `/api/reviews/:bookingId`
    *   **GET** `/api/reviews/worker/:workerId`, `/api/reviews/:bookingId`
9.  **Chat** (`/api/chat`)
    *   **GET/POST** `/api/chat/:bookingId/messages`
10. **Admin** (`/api/admin`) - *Strictly requires Admin role (`requireRole(UserRole.ADMIN)`)*
    *   **GET** `/api/admin/workers`, `/api/admin/jobs`, `/api/admin/flagged`
    *   **PATCH** `/api/admin/workers/:id/verify`
    *   **POST** `/api/admin/workers/:id/suspend`
11. **Skills** (`/api/skill`)
    *   **GET** `/api/skill` *(Public)*
    *   **POST** `/api/skill/add` *(Admin only)*
12. **Worker Location** (`/api/worker_location`)
    *   **POST** `/api/worker_location/add`
13. **API Documentation** (`/api-docs`)
    *   Interactive Swagger UI
14. **Queue Visualization Dashboard** (`/admin/queues`)
    *   Bull-Board queue dashboard UI

---

## 🔒 Authentication & Role-Based Access Control (RBAC)

The backend enforces a strict separation between **Authentication** ("Who are you?") and **Authorization** ("Are you allowed to perform this operation?").

> **Security Invariant:** Possession of a valid JWT alone **never** confers administrative access. Administrative endpoints strictly enforce server-validated role claims.

### Supported Roles

Roles are strongly typed via the `UserRole` enum:

*   `customer`: Clients booking jobs and requesting services.
*   `worker`: Laborers and service providers fulfilling jobs.
*   `admin`: Platform operators with elevated administrative privileges.

### Authorization Middleware Pipeline

Routes are protected using modular Express middlewares:

```text
Incoming Request
      │
      ▼
authenticateJWT
  ├── Missing / malformed Bearer header ──► 401 Unauthorized
  ├── Cryptographic signature invalid    ──► 401 Unauthorized
  ├── Token expired                       ──► 401 Unauthorized
  ├── Unsupported / missing role claim   ──► 401 Unauthorized
  └── Extracts & normalizes: req.user { id, role: UserRole }
      │
      ▼
requireRole(UserRole.ADMIN)
  ├── req.user.role !== UserRole.ADMIN   ──► 403 Forbidden
  └── req.user.role === UserRole.ADMIN   ──► next()
      │
      ▼
Controller Handler
```

### RBAC Permission Matrix

| Resource / Endpoint | Customer | Worker | Admin |
| :--- | :---: | :---: | :---: |
| Customer Profile (`/api/clients/me`) | ✅ | ❌ (403) | ❌ (403) |
| Worker Profile (`/api/workers/me`) | ❌ (401/403) | ✅ | ❌ (403) |
| Create Jobs (`/api/jobs`) | ✅ | ❌ | ✅ |
| Add Skill Category (`/api/skill/add`) | ❌ (403) | ❌ (403) | ✅ |
| List All Workers (`/api/admin/workers`) | ❌ (403) | ❌ (403) | ✅ |
| Verify Worker Aadhaar (`/api/admin/workers/:id/verify`) | ❌ (403) | ❌ (403) | ✅ |
| List All Platform Jobs (`/api/admin/jobs`) | ❌ (403) | ❌ (403) | ✅ |
| Flagged Workers (`/api/admin/flagged`) | ❌ (403) | ❌ (403) | ✅ |
| Suspend Worker (`/api/admin/workers/:id/suspend`) | ❌ (403) | ❌ (403) | ✅ |


---

## 🗺️ PostGIS Geography & Location implementation

The database leverages PostgreSQL's PostGIS extension with `geography` type columns (`location_geo`). Due to Prisma's limitations with Geography type mapping (`Unsupported("geography")`), we implement a dual-write pattern where main records are created via Prisma, and subsequent raw SQL is executed within the same transaction to populate spatial fields (`ST_SetSRID` and `ST_MakePoint`).

Two GIST indexes optimize spatial queries:
- `idx_worker_location` on `Worker.location_geo`
- `idx_job_location` on `job.location_geo`

---

## ⚡ Additional Scripts

*   **Test Prisma Connection:** `npx tsx src/test-prisma.ts`
*   **Test Dispatch Queue and Wave Pipeline:** `npx tsx src/test-dispatch.ts`
