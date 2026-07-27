# Project Context: LabourBaba Backend

This document provides a comprehensive overview of the **LabourBaba-backend** codebase, its database schema, design architecture, and file structure to serve as a persistent context guide.

---

## 1. Project Overview
**LabourBaba Backend** is a Node.js web application built using **TypeScript** and **Express**. It handles data modeling and persistence via **Prisma Client** connecting to a **PostgreSQL** database (integrated with Supabase).

---

## 2. Directory Structure

The project follows a **feature-based (functional) architecture** (restructured from MVC on 2026-07-25, commit 67b300c). The source root (`src/`) is organized by features, with shared utilities and configurations centralized:

- **`src/`**
  - **`config/`** - Global configurations
    - `prisma.ts`: Configures the connection pooling (`pg.Pool`) and initializes `PrismaClient` with the PostgreSQL adapter (`@prisma/adapter-pg`).
    - `redis.ts`: Configures the Upstash Redis client.
    - `swagger.ts`: Configures and exports Swagger (OpenAPI) setup helper using `@asteasolutions/zod-to-openapi` and `swagger-ui-express`.
    - `bullmq.ts`: Declares `dispatchQueue` and `timeoutQueue` with connection options configured for Aiven Redis.
  - **`features/`** - Feature modules (each self-contained with controllers, routes, services)
    - **`admin/`**: Admin management
      - `adminController.ts`: Handles backend administration features (worker verifications, platform jobs, suspension).
      - `adminRoutes.ts`: Defines endpoint mappings under `/api/admin`.
      - `adminServices.ts`: Business logic for admin operations.
    - **`auth/`**: Authentication & customer management
      - `auth.controller.ts`: Handles worker authentication (OTP delivery and JWT verification/refresh/logout).
      - `auth.routes.ts`: Routes for `/api/auth` (OTP sending, OTP verifying, Token Refresh, Logout).
      - `auth.services.ts`: Logic for SMS OTP and verification tokens.
      - `customerAuthController.ts`: Handles customer sign-up/login authentication.
      - `customerController.ts`: Handles customer requests and profile management.
      - `customerRoutes.ts`: Routes for `/api/clients` (signup, login, list, and create).
    - **`booking/`**: Booking lifecycle management
      - `bookingController.ts`: Handles booking lifecycles, OTP start verification, completions, and cancellations.
      - `bookingRoutes.ts`: Routes for `/api/bookings`.
      - `bookingServices.ts`: State management and OTP verification routines for active bookings.
    - **`chat/`**: Messaging system
      - `chatController.ts`: Handles reading and sending conversation messages.
      - `chatRoutes.ts`: Routes for `/api/chat`.
      - `chatServices.ts`: Conversation generation and persistent chat tracking.
    - **`dispatch/`**: Job dispatch workflow
      - `dispatchController.ts`: Handles job dispatch incoming status, acceptance, declines, and history waves.
      - `dispatchRoutes.ts`: Routes for `/api/dispatch`.
      - `dispatchServices.ts`: Transaction logic for atomic booking creations upon job dispatch acceptances.
      - `simpleDispatch.ts`: Simplified dispatch processing and worker matching logic.
    - **`jobs/`**: Job management
      - `jobController.ts`: Handles creating and listing jobs.
      - `jobRoutes.ts`: Routes for `/api/jobs` (create, list, details, cancellations, requirements).
      - `job.services.ts`: Business logic for jobs including PostGIS geographic conversions and BullMQ queue dispatch.
      - `jobReqServices.ts`: Job requirement management.
    - **`payment/`**: Payment processing
      - `paymentController.ts`: Handles Razorpay payment order creation, refunds, and webhook captures.
      - `paymentRoutes.ts`: Routes for `/api/payments`.
      - `paymentServices.ts`: Webhook handlers and Razorpay mock integrations.
    - **`review/`**: Review & rating system
      - `reviewController.ts`: Handles booking ratings and comments.
      - `reviewRoutes.ts`: Routes for `/api/reviews`.
      - `reviewServices.ts`: Database reviews mapping.
    - **`skill/`**: Skill categories management
      - `skillControllers.ts`: Handles retrieving and adding skill categories.
      - `skillRouter.ts`: Routes for `/api/skill`.
    - **`worker/`**: Worker profiles and management
      - `workerController.ts`: Handles worker registration, profiles, online status, documents, earnings, and analytics.
      - `workerRoutes.ts`: Routes for `/api/workers`.
      - `workerServices.ts`: Business logic for worker updates, documents, analytics, and location management.
    - **`worker_location/`**: Real-time location tracking
      - `worker_location.controller.ts`: Handles worker location add/update requests (upserts location and updates worker geography).
      - `worker_location.routes.ts`: Routes for `/api/worker_location`.
  - **`middlewares/`** - Global middleware
    - `authMiddleware.ts`: Custom middleware for verifying JWT tokens.
    - `validationMiddleware.ts`: Custom middleware using Zod schema to validate request bodies.
  - **`schemas/`** - Shared validation schemas
    - `index.ts`: Contains Zod validation schemas for requests and responses, registered to the Swagger/OpenAPI registry.
  - **`shared/`** - Shared services across features (moved from `services/`)
    - `customerServices.ts`: Abstracted business logic layer for customer actions.
    - `fcm.ts`: Firebase Cloud Messaging integration for push notifications.
  - **`type/`** - Shared TypeScript types
    - `api_req.type.ts`: Defines TypeScript interfaces/types for request payloads.
    - `api_res.types.ts`: Defines TypeScript interfaces/types for API responses.
  - **`utils/`** - Shared utility functions
    - `authUtils.ts`: Helper utilities for authentication, OTP generation, and hashing.
    - `locationUtils.ts`: Helper utilities for PostGIS geography conversions (WKT formatting and GeoJSON parsing).
  - **`workers/`** - Background job workers
    - `dispatchWorker.ts`: Processes requirement dispatching, queries nearby online matching workers via PostGIS, handles waves, sends FCM notifications and Socket.IO events, and schedules wave timeouts.
    - `timeoutWorker.ts`: Handles dispatch timeouts by transitioning waves to exhausted, and statelessly queuing the next wave at the proper offset if workers are still available.
  - `server.ts`: Entry point of the Express server with CORS configured to accept both `FRONT_END_URL` and `APP_URL` environments, Socket.IO setup, and background worker instantiation.
- **`prisma/`**
  - `schema.prisma`: The database design schema definition file.

---

## 3. Database Schema (`prisma/schema.prisma`)

The database consists of a PostgreSQL relational database. Key models and relationships are defined below:

### Models

#### `Worker` (`worker`)
Represents the service providers (workers) on the platform.
*   `id`: UUID, Primary Key
*   `skill_category_id`: UUID (foreign key referencing `skill_category`, required)
*   `phone`: String (unique VarChar(15), required)
*   `password`: String (required, hashed)
*   `name`: String (required)
*   `skill_type`: String (VarChar(100), required)
*   `worker_score`: Decimal (optional, default 5.0)
*   `is_online`: Boolean (optional, default false)
*   `aadhaar_last4`: String (Char(4), optional)
*   `verification_status`: String (VarChar(30), optional, default 'pending')
*   `decline_count`: Int (optional, default 0)
*   `timeout_count`: Int (optional, default 0)
*   `device_token`: String (optional)
*   `location_geo`: geography (optional)
*   `deleted_at`: DateTime (optional)

#### `customer` (`customer`)
Represents clients/customers who post jobs and book workers.
*   `id`: UUID, Primary Key
*   `phone`: String (unique VarChar(15), required)
*   `name`: String (VarChar(150), required)
*   `created_at`: DateTime (optional, default now())
*   `deleted_at`: DateTime (optional)

#### `booking`
Tracks job allocations and hiring status between customers and workers.
*   `id`: UUID, Primary Key
*   `job_id`: UUID (foreign key referencing `job`, required)
*   `requirement_id`: UUID (foreign key referencing `job_requirement`, required)
*   `worker_id`: UUID (foreign key referencing `Worker`, required)
*   `customer_id`: UUID (foreign key referencing `customer`, required)
*   `status`: String (VarChar(30), optional)
*   `otp_hash`: String (optional)
*   `otp_verified`: Boolean (optional, default false)

#### `job`
Represents service tasks posted by customers.
*   `id`: UUID, Primary Key
*   `customer_id`: UUID (foreign key referencing `customer`, required)
*   `latitude`: Float (optional)
*   `longitude`: Float (optional)
*   `location_geo`: geography (optional)
*   `location`: String (optional)
*   `status`: String (VarChar(30), optional)
*   `dispatch_status`: String (VarChar(30), optional)
*   `created_at`: DateTime (optional, default now())
*   `deleted_at`: DateTime (optional)

#### `job_requirement`
Tracks detailed requirements associated with a job.
*   `id`: UUID, Primary Key
*   `job_id`: UUID (foreign key referencing `job`, required)
*   `skill_type`: String (VarChar(100), optional)
*   `worker_count_needed`: Int (required)
*   `worker_count_filled`: Int (optional, default 0)
*   `rate_per_day`: Int (optional)
*   `status`: String (VarChar(30), optional)
*   `current_wave`: Int (optional, default 1)
*   `wave_size`: Int (optional, default 10)

#### `payment`
Handles financial records associated with bookings.
*   `id`: UUID, Primary Key
*   `booking_id`: UUID (unique foreign key referencing `booking`, required)
*   `razorpay_order_id`: String (unique VarChar(255), optional)
*   `status`: String (VarChar(30), optional)
*   `amount`: Int (optional)

#### `review`
Contains feedback from transactions.
*   `id`: UUID, Primary Key
*   `booking_id`: UUID (foreign key referencing `booking`, required)
*   `worker_id`: UUID (foreign key referencing `Worker`, required)
*   `customer_id`: UUID (foreign key referencing `customer`, required)
*   `rating`: Decimal (optional)
*   `comment`: String (optional)

#### `conversation`
Represents communication threads for a booking.
*   `id`: UUID, Primary Key
*   `booking_id`: UUID (unique foreign key referencing `booking`, required)
*   `worker_id`: UUID (foreign key referencing `Worker`, required)
*   `customer_id`: UUID (foreign key referencing `customer`, required)

#### `message`
Messages sent within a conversation.
*   `id`: UUID, Primary Key
*   `conversation_id`: UUID (foreign key referencing `conversation`, required)
*   `sender_id`: UUID (required)
*   `content`: String (optional)
*   `sent_at`: DateTime (optional, default now())

#### `notification`
In-app notifications for workers about jobs.
*   `id`: UUID, Primary Key
*   `worker_id`: UUID (foreign key referencing `Worker`, required)
*   `job_id`: UUID (foreign key referencing `job`, required)
*   `type`: String (VarChar(50), optional)
*   `is_read`: Boolean (optional, default false)
*   `created_at`: DateTime (optional, default now())

#### `skill_category`
Categories for skills (e.g., Plumbing, Electrician).
*   `id`: UUID, Primary Key
*   `name`: String (unique VarChar(100), required)

#### `job_dispatch`
Dispatched routing tracking for jobs matching workers.
*   `id`: UUID, Primary Key
*   `requirement_id`: UUID (foreign key referencing `job_requirement`, required)
*   `worker_id`: UUID (foreign key referencing `Worker`, required)
*   `wave_number`: Int (optional)
*   `wave_position`: Int (optional)
*   `status`: String (VarChar(30), optional)
*   `notified_at`: DateTime (optional)
*   `expires_at`: DateTime (optional)
*   `responded_at`: DateTime (optional)

#### `worker_analytics`
Performance metrics for each worker.
*   `id`: UUID, Primary Key
*   `worker_id`: UUID (unique foreign key referencing `Worker`, required)
*   `avg_response_time_s`: Decimal (optional)
*   `acceptance_rate`: Decimal (optional)
*   `completion_rate`: Decimal (optional)
*   `calculated_at`: DateTime (optional, default now())

#### `worker_device`
Devices registered to a worker.
*   `id`: UUID, Primary Key
*   `worker_id`: UUID (foreign key referencing `Worker`, required)
*   `device_id`: String (VarChar(255), optional)
*   `ip_address`: String (VarChar(50), optional)

#### `worker_document`
Documents uploaded by workers for verification.
*   `id`: UUID, Primary Key
*   `worker_id`: UUID (foreign key referencing `Worker`, required)
*   `document_type`: String (VarChar(50), optional)
*   `file_url`: String (optional)
*   `status`: String (VarChar(30), optional)

#### `worker_location`
Historical coordinates (location logs) of a worker.
*   `id`: UUID, Primary Key
*   `worker_id`: UUID (foreign key referencing `Worker`, required)
*   `location_geo`: geography (optional)
*   `updated_at`: DateTime (optional, default now())

#### `dispatch_wave`
Tracks waves generated during job dispatch workflows.
*   `id`: UUID, Primary Key
*   `requirement_id`: UUID (foreign key referencing `job_requirement`, required)
*   `wave_number`: Int (required)
*   `status`: String (VarChar(30), optional)
*   `notified_at`: DateTime (optional)
*   `resolved_at`: DateTime (optional)
*   `workers_notified`: Int (optional, default 0)
*   `slots_filled`: Int (optional, default 0)

---

## 4. Key Dependencies (`package.json`)

*   **Runtime Context:**
    *   `express` (v5.2.1) - Web framework.
    *   `cors` (v2.8.6) - Cross-Origin Resource Sharing middleware.
    *   `morgan` (v1.11.0) - HTTP request logger middleware.
    *   `dotenv` (v17.4.2) - Load environment variables.
    *   `pg` (v8.22.0) - PostgreSQL client.
    *   `@prisma/client` (v7.8.0) - Query builder.
    *   `@supabase/server` (v1.1.0) - Supabase server utility helper.
    *   `@supabase/supabase-js` (v2.108.2) - Supabase JS client.
    *   `@upstash/redis` (v1.38.0) - Serverless Redis client.
    *   `bullmq` - Redis-backed job queues and background workers.
    *   `@bull-board/api` & `@bull-board/express` (v8.0.2) - BullMQ visualization dashboard.
    *   `firebase-admin` (v14.1.0) - Firebase Cloud Messaging client SDK.
    *   `socket.io` - Real-time bidirectional event-based communication.
    *   `jsonwebtoken` & `bcrypt` - User authentication and hashing utilities.
    *   `zod` (v4.4.3) & `@asteasolutions/zod-to-openapi` (v8.5.0) - Input validation and OpenAPI documentation integration.
    *   `swagger-ui-express` (v5.0.1) - Serve Swagger OpenAPI documentation.
*   **Development Context:**
    *   `prisma` - Database schema compiler & migration manager.
    *   `tsx` - Executes TS files directly without separate pre-compilation step.
    *   `nodemon` - Reloads server on files change.

---

## 5. Active Endpoints

1.  **Health Check**
    *   **GET** `/health`
    *   **Response:** `{ "status": "OK", "timestamp": "..." }`
2.  **Auth** (`/api/auth`)
    *   **POST** `/api/auth/send-otp`
    *   **POST** `/api/auth/verify-otp`
    *   **POST** `/api/auth/refresh`
    *   **POST** `/api/auth/logout`
3.  **Workers** (`/api/workers`)
    *   **POST** `/api/workers/registerWorker` (Creates a worker profile, hashes password)
    *   **POST** `/api/workers/login` (Authenticates worker by phone & password, returns JWT token)
    *   **GET** `/api/workers/me` (Requires JWT)
    *   **PATCH** `/api/workers/me` (Requires JWT)
    *   **PATCH** `/api/workers/me/location` (Requires JWT)
    *   **PATCH** `/api/workers/me/online` (Requires JWT)
    *   **POST** `/api/workers/me/documents` (Requires JWT)
    *   **GET** `/api/workers/me/documents` (Requires JWT)
    *   **GET** `/api/workers/me/analytics` (Requires JWT)
    *   **GET** `/api/workers/me/bookings` (Requires JWT)
    *   **GET** `/api/workers/me/earnings` (Requires JWT)
4.  **Jobs** (`/api/jobs`)
    *   **POST** `/api/jobs`
    *   **GET** `/api/jobs` (Retrieve customer jobs, filters by `customer_id` query param)
    *   **GET** `/api/jobs/:jobId`
    *   **PATCH** `/api/jobs/:jobId/cancel`
    *   **GET** `/api/jobs/:jobId/requirements`
    *   **GET** `/api/jobs/:jobId/bookings`
5.  **Dispatch** (`/api/dispatch`)
    *   **GET** `/api/dispatch/incoming` (Requires JWT)
    *   **POST** `/api/dispatch/:requirementId/accept` (Requires JWT)
    *   **POST** `/api/dispatch/:requirementId/decline` (Requires JWT)
    *   **GET** `/api/dispatch/:requirementId/waves` (Requires JWT)
6.  **Bookings** (`/api/bookings`)
    *   **GET** `/api/bookings/:bookingId` (Requires JWT)
    *   **POST** `/api/bookings/:bookingId/otp/verify` (Requires JWT)
    *   **POST** `/api/bookings/:bookingId/complete` (Requires JWT)
    *   **POST** `/api/bookings/:bookingId/confirm-complete` (Requires JWT)
    *   **POST** `/api/bookings/:bookingId/cancel` (Requires JWT)
    *   **GET** `/api/bookings/:bookingId/location` (Requires JWT)
7.  **Payments** (`/api/payments`)
    *   **POST** `/api/payments/:bookingId/create-order`
    *   **POST** `/api/payments/webhook`
    *   **GET** `/api/payments/:bookingId`
    *   **POST** `/api/payments/:bookingId/refund`
8.  **Reviews** (`/api/reviews`)
    *   **POST** `/api/reviews/:bookingId`
    *   **GET** `/api/reviews/worker/:workerId`
    *   **GET** `/api/reviews/:bookingId`
9.  **Chat** (`/api/chat`)
    *   **GET** `/api/chat/:bookingId/messages` (Requires JWT)
    *   **POST** `/api/chat/:bookingId/messages` (Requires JWT)
10. **Admin** (`/api/admin`)
    *   **GET** `/api/admin/workers`
    *   **PATCH** `/api/admin/workers/:id/verify`
    *   **GET** `/api/admin/jobs`
    *   **GET** `/api/admin/flagged`
    *   **POST** `/api/admin/workers/:id/suspend`
11. **Clients / Customers (Legacy)**
    *   **GET** `/api/clients`
    *   **POST** `/api/clients/add`
    *   **POST** `/api/clients/signup`
    *   **POST** `/api/clients/login`
12. **Skills**
    *   **GET** `/api/skill`
    *   **POST** `/api/skill/add`
13. **Worker Location**
    *   **POST** `/api/worker_location/add`
14. **API Documentation**
    *   **GET** `/api-docs` (Swagger UI HTML)
15. **Queue Visualization Dashboard**
    *   **GET** `/admin/queues` (Bull-Board queue dashboard UI)

---

## 6. Execution Commands

*   **Start Local Development Server:**
    ```bash
    npm run dev
    ```
*   **Test Prisma Connection:**
    ```bash
    npx tsx src/test-prisma.ts
    ```
*   **Test Dispatch Queue and Wave Pipeline:**
    ```bash
    npx tsx src/test-dispatch.ts
    ```

---

## 7. PostGIS Geography & Location Implementation

To support spatial queries (like finding workers near a job), the database leverages PostgreSQL's **PostGIS** extension with `geography` type columns (`location_geo`).

### 1. Coordinate Conversions (`src/utils/locationUtils.ts`)
The service uses three helper functions to manage coordinate conversions:

*   **`convertToGeography(longitude, latitude)`**: 
    - Validates coordinates (lat: -90 to 90, lon: -180 to 180)
    - Returns PostGIS Well-Known Text (WKT) format: `POINT(longitude latitude)`
    - Example: `convertToGeography(72.8777, 19.0760)` → `"POINT(72.8777 19.0760)"`
    - Throws error on invalid coordinates

*   **`convertToGeoJSON(longitude, latitude)`**: 
    - Returns standard GeoJSON Point representation
    - Format: `{ type: "Point", coordinates: [longitude, latitude] }`
    - Used for API responses and external integrations

*   **`parseGeography(geography)`**: 
    - Parses WKT POINT strings back to coordinates
    - Extracts longitude and latitude using regex pattern matching
    - Returns: `{ longitude: number, latitude: number }`

### 2. Location Update & Storage Patterns

Since Prisma Client does not natively map database geography (`Unsupported("geography")`) types, the application performs a dual-step write pattern where it first writes the main record, and then uses raw SQL updates (`$executeRaw`) to assign the coordinates to the geography column via PostGIS spatial functions (`ST_SetSRID` and `ST_MakePoint`).

**Pattern A: Job Location Creation** (`src/services/job.services.ts`)
- When creating a job with latitude/longitude:
  1. Create the `job` record with standard fields (`latitude`, `longitude`, `location`, etc.) inside a transaction.
  2. Immediately run a raw SQL query inside the transaction to update the geography column:
     ```typescript
     await tx.$executeRaw`
       UPDATE job
       SET location_geo = ST_SetSRID(
         ST_MakePoint(${payload.longitude}, ${payload.latitude}),
         4326
       )::geography
       WHERE id = ${job.id}::uuid;
     `;
     ```

**Pattern B: Worker Location History Update** (`src/services/workerServices.ts`)
- In `workerService.updateLocation`:
  1. Create a `worker_location` tracking record (history) with the `worker_id`.
  2. Run raw SQL to update the record's `location_geo` with coordinates:
     ```typescript
     await prisma.$executeRaw`
       UPDATE worker_location
       SET location_geo = ST_SetSRID(
         ST_MakePoint(${payload.longitude}, ${payload.latitude}),
         4326
       )::geography
       WHERE id = ${worker_location.id}::uuid;
     `;
     ```

**Pattern C: Worker Location Controller Update & Sync** (`src/controllers/worker_location.controller.ts`)
- Endpoint `POST /api/worker_location/add` handles location updates:
  1. Accepts `worker_id`, `latitude`, `longitude` in the request body.
  2. Creates a `worker_location` record history log.
  3. Updates the `location_geo` on the newly created `worker_location` record via raw SQL.
  4. Synchronizes the worker's current location by updating `location_geo` directly on the `worker` record via raw SQL:
     ```typescript
     await prisma.$executeRaw`
       UPDATE worker
       SET location_geo = ST_SetSRID(
         ST_MakePoint(${longitude}, ${latitude}),
         4326
       )::geography
       WHERE id = ${worker_id}::uuid;
     `;
     ```

### 3. Database Indexes
Two GIST indexes optimize spatial queries:
- `idx_worker_location` on `Worker.location_geo`
- `idx_job_location` on `job.location_geo`
- Enable fast nearest-neighbor searches for dispatch workers

---

## 8. Recent Architecture Changes (Latest Updates)

Summary: Since the previous documentation update, the codebase received multiple feature enhancements, bug fixes, and infra additions — primarily around dispatch workflow, location handling, socket + CORS stability, FCM notifications, device token management, Docker support, and API surface expansion. Key changes follow.

### A. Infrastructure & Dev Ops
- Added Docker support (Dockerfile updates) to containerize the app and streamline local/dev deployments.
- Added server entry point and a Prisma connectivity test script (`src/test-prisma.ts`) to validate DB access during startup.

### B. Socket.IO, CORS & Error Handling
- Fixed Socket.IO connection issues and many logging improvements for real-time events.
- Refactored CORS middleware to allow configurable origins and fixed CORS-related bugs (Allowed-Origin updates).
- Added global error handling middleware to centralize error responses and reduce controller duplication.

### C. Dispatch Workflow & Spatial Matching
- Major refactors to dispatch logic: improved worker selection, wave handling, and queue reliability (multiple commits).
- Restored skill matching normalization and adjusted worker pool sizing logic (introducing `workers_needed` in dispatch requirements).
- Temporarily lifted radius filtering in some flows to broaden candidate selection while dispatch tuning is in progress.
- Job creation now includes worker & user data to seed immediate dispatch processing for new jobs.
- Added/find-by-location improvements: worker location now accompanies worker details in dispatch responses.

### D. Worker Location & PostGIS Enhancements
- Continued hardening of the dual-write pattern: `worker_location` raw coordinates + `Worker.location_geo` geography kept synchronized via upserts and raw PostGIS updates where necessary.
- Dispatch codepaths and search routines updated to match workers using geographic coordinates (ST functions expected in production DB).

### E. Notifications & Device Token Management (FCM)
- Added/expanded device token endpoints: `updateDeviceToken` / FCM device token update endpoints + request schema.
- FCM payloads changed to a data-only format for background processing; added richer job details to FCM data payloads.
- Refactored `src/services/fcm.ts` for production-ready initialization and data payload sending.

### F. New / Improved Endpoints
- `PATCH /api/workers/me/device-token` (or similar) — update worker's FCM device token
- `GET /api/dispatch/:dispatchId` — get detailed dispatch information (getDispatchDetail)
- Booking and dispatch endpoints: dispatch responses now may include OTP and booking-related metadata to improve client workflows.

### G. Booking & OTP Flow Improvements
- Enhanced OTP validation in booking verification; OTP may be included in dispatch responses to support immediate verification workflows.

### H. Tests & Stability
- Added automated test coverage scaffolding and more unit/integration test updates for dispatch and auth flows.
- Fixed queue behavior and improved test-dispatch utilities to emulate real dispatch pipelines.

### I. Miscellaneous Fixes
- Fixed multiple smaller bugs (queue reliability, logging, acceptance of in-progress/confirmed bookings during dispatch)
- Normalized skill matching and improved error messaging across controllers

---

---

Notes & Next Steps:
- Verify PostGIS-enabled DB runs migrations and supports ST_* functions in production environment.
- Implement spatial query endpoints (e.g., ST_DWithin search) and add integration tests for proximity search.
- Consider adding feature flags for radius filtering while tuning dispatch heuristics.
- Push Docker artifacts to registry and add a reference deployment script.

(Use `git log --oneline` to review per-commit details; see commit history for granular changes.)

---

## 9. Architecture Restructuring (2026-07-25)

**Commit:** `67b300c` - "shifted the folder str of the project from mvc to the functional"

### Migration from MVC to Feature-Based Architecture

The project was restructured from a traditional MVC (Model-View-Controller) pattern to a **feature-based (functional) architecture**:

#### Before (MVC Structure):
```
src/
├── controllers/     (all controllers)
├── services/        (all services)
├── routes/          (all routes)
└── ...
```

#### After (Feature-Based Structure):
```
src/
├── features/
│   ├── admin/
│   │   ├── adminController.ts
│   │   ├── adminRoutes.ts
│   │   └── adminServices.ts
│   ├── auth/
│   │   ├── auth.controller.ts
│   │   ├── auth.routes.ts
│   │   ├── auth.services.ts
│   │   └── ...
│   ├── booking/
│   ├── chat/
│   ├── dispatch/
│   ├── jobs/
│   ├── payment/
│   ├── review/
│   ├── skill/
│   ├── worker/
│   └── worker_location/
├── shared/          (shared services: customerServices, fcm)
└── ...
```

### Benefits of Feature-Based Architecture:

1. **Better Scalability**: Each feature is self-contained with its own controller, routes, and services.
2. **Improved Modularity**: Easy to locate, understand, and modify a feature without affecting others.
3. **Clearer Dependencies**: Feature dependencies are explicit (e.g., `dispatch/` imports from `jobs/`).
4. **Easier Testing**: Feature tests can be isolated and run independently.
5. **Team Collaboration**: Multiple teams can work on different features with minimal merge conflicts.
6. **Faster Navigation**: Developers can navigate to a specific feature's directory and find everything there.

### Files Moved:

- **Controllers** (e.g., `authController.ts`) → `features/auth/auth.controller.ts`
- **Routes** (e.g., `authRoutes.ts`) → `features/auth/auth.routes.ts`
- **Feature Services** (e.g., `jobReqServices.ts`) → `features/jobs/jobReqServices.ts`
- **Shared Services** (e.g., `fcm.ts`, `customerServices.ts`) → `shared/`

### Import Path Updates:

All internal imports were updated to reflect the new structure:
- Feature files import from relative paths (e.g., `../../config/prisma`, `../../schemas`)
- Shared services are imported from `src/shared/`
- Configuration remains centralized in `src/config/`

### Next Steps for Feature-Based Architecture:

1. **Feature Modules**: Consider wrapping each feature in an Express Router with automatic mounting in `server.ts`.
2. **Feature Exports**: Create barrel exports (e.g., `features/auth/index.ts`) for cleaner imports.
3. **Feature Configuration**: Move feature-specific config to individual feature directories if needed.
4. **Testing Structure**: Mirror feature structure in `tests/` directory for better test organization.
