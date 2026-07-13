import express from "express";
import { registerWorker, loginWorker, getMe, updateMe, updateLocation, updateOnline, uploadDocuments, getDocuments, getAnalytics, getBookings, getEarnings } from "../controllers/workerController";
import { validateBody } from "../middlewares/validationMiddleware";
import { authenticateJWT } from "../middlewares/authMiddleware";
import { CreateWorkerReqSchema, LoginWorkerReqSchema, UpdateWorkerProfileReqSchema, UpdateWorkerLocationReqSchema, UpdateWorkerOnlineStatusReqSchema, UploadWorkerDocumentReqSchema, WorkerSchema, WorkerLocationSchema, WorkerDocumentSchema, WorkerAnalyticsSchema, BookingSchema } from "../schemas";
import { registry } from "../config/swagger";
import { z } from "zod";
import { /* ...existing, */ updateDeviceToken } from "../controllers/workerController";
import { /* ...existing, */ UpdateDeviceTokenReqSchema } from "../schemas";

const router = express.Router();

registry.registerPath({
  method: "post",
  path: "/api/workers/registerWorker",
  summary: "Create worker profile",
  tags: ["Workers"],
  request: { body: { content: { "application/json": { schema: CreateWorkerReqSchema } } } },
  responses: { 201: { description: "Created", content: { "application/json": { schema: z.object({ success: z.boolean(), data: WorkerSchema }) } } } }
});

registry.registerPath({
  method: "patch",
  path: "/api/workers/me/device-token",
  summary: "Save/update FCM device token for push notifications",
  tags: ["Workers"],
  request: { body: { content: { "application/json": { schema: UpdateDeviceTokenReqSchema } } } },
  responses: { 200: { description: "Success" } }
});

registry.registerPath({
  method: "post",
  path: "/api/workers/login",
  summary: "Worker login with phone and password",
  tags: ["Workers"],
  request: { body: { content: { "application/json": { schema: LoginWorkerReqSchema } } } },
  responses: {
    200: {
      description: "Success",
      content: {
        "application/json": {
          schema: z.object({
            success: z.boolean(),
            message: z.string(),
            data: z.object({
              id: z.string().uuid(),
              phone: z.string(),
              name: z.string(),
              skill_type: z.string(),
              verification_status: z.string().nullable().optional(),
            }),
            token: z.string(),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/workers/me",
  summary: "Get own profile",
  tags: ["Workers"],
  responses: { 200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: WorkerSchema }) } } } }
});

registry.registerPath({
  method: "patch",
  path: "/api/workers/me",
  summary: "Update name, phone, skill",
  tags: ["Workers"],
  request: { body: { content: { "application/json": { schema: UpdateWorkerProfileReqSchema } } } },
  responses: { 200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: WorkerSchema }) } } } }
});

registry.registerPath({
  method: "patch",
  path: "/api/workers/me/location",
  summary: "Update GPS coordinates",
  tags: ["Workers"],
  request: { body: { content: { "application/json": { schema: UpdateWorkerLocationReqSchema } } } },
  responses: { 200: { description: "Success" } }
});

registry.registerPath({
  method: "patch",
  path: "/api/workers/me/online",
  summary: "Toggle is_online true/false",
  tags: ["Workers"],
  request: { body: { content: { "application/json": { schema: UpdateWorkerOnlineStatusReqSchema } } } },
  responses: { 200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: WorkerSchema }) } } } }
});

registry.registerPath({
  method: "post",
  path: "/api/workers/me/documents",
  summary: "Upload Aadhaar/PAN to Supabase Storage",
  tags: ["Workers"],
  request: { body: { content: { "application/json": { schema: UploadWorkerDocumentReqSchema } } } },
  responses: { 201: { description: "Created", content: { "application/json": { schema: z.object({ success: z.boolean(), data: WorkerDocumentSchema }) } } } }
});

registry.registerPath({
  method: "get",
  path: "/api/workers/me/documents",
  summary: "List uploaded documents",
  tags: ["Workers"],
  responses: { 200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: z.array(WorkerDocumentSchema) }) } } } }
});

registry.registerPath({
  method: "get",
  path: "/api/workers/me/analytics",
  summary: "Get acceptance rate, avg response time",
  tags: ["Workers"],
  responses: { 200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: WorkerAnalyticsSchema }) } } } }
});

registry.registerPath({
  method: "get",
  path: "/api/workers/me/bookings",
  summary: "List own booking history",
  tags: ["Workers"],
  responses: { 200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: z.array(BookingSchema) }) } } } }
});

registry.registerPath({
  method: "get",
  path: "/api/workers/me/earnings",
  summary: "Earnings summary by date range",
  tags: ["Workers"],
  responses: { 200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: z.object({ earnings: z.number() }) }) } } } }
});

router.post("/registerWorker", validateBody(CreateWorkerReqSchema), registerWorker);
router.post("/login", validateBody(LoginWorkerReqSchema), loginWorker);
router.get("/me", authenticateJWT, getMe);
router.patch("/me", authenticateJWT, validateBody(UpdateWorkerProfileReqSchema), updateMe);
router.patch("/me/location", authenticateJWT, validateBody(UpdateWorkerLocationReqSchema), updateLocation);
router.patch("/me/online", authenticateJWT, validateBody(UpdateWorkerOnlineStatusReqSchema), updateOnline);
router.post("/me/documents", authenticateJWT, validateBody(UploadWorkerDocumentReqSchema), uploadDocuments);
router.get("/me/documents", authenticateJWT, getDocuments);
router.get("/me/analytics", authenticateJWT, getAnalytics);
router.get("/me/bookings", authenticateJWT, getBookings);
router.get("/me/earnings", authenticateJWT, getEarnings);
router.patch("/me/device-token", authenticateJWT, validateBody(UpdateDeviceTokenReqSchema), updateDeviceToken);

export default router;
