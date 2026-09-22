import express from "express";
import {
  registerWorker,
  loginWorker,
  getMe,
  updateMe,
  updateLocation,
  updateOnline,
  uploadDocuments,
  requestUploadUrl,
  getDocuments,
  getDocumentAccess,
  getAnalytics,
  getBookings,
  getEarnings,
  updateDeviceToken,
  registerDevice,
  revokeDevice,
  getDevices,
} from "../../features/worker/workerController";
import { validateBody, validateParams } from "../../middlewares/validationMiddleware";
import { authenticateJWT, requireRole, UserRole } from "../../middlewares/authMiddleware";
import {
  CreateWorkerReqSchema,
  LoginWorkerReqSchema,
  UpdateWorkerProfileReqSchema,
  UpdateWorkerLocationReqSchema,
  UpdateWorkerOnlineStatusReqSchema,
  UploadWorkerDocumentReqSchema,
  RequestDocumentUploadUrlReqSchema,
  DocumentIdParamSchema,
  WorkerDocumentAccessResponseSchema,
  WorkerSchema,
  WorkerLocationSchema,
  WorkerDocumentSchema,
  WorkerAnalyticsSchema,
  BookingSchema,
  UpdateDeviceTokenReqSchema,
  RegisterWorkerDeviceReqSchema,
  RevokeWorkerDeviceReqSchema,
  WorkerDeviceIdParamSchema,
  WorkerDeviceSchema,
} from "../../schemas";
import { registry } from "../../config/swagger";
import { z } from "zod";

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
  summary: "Login with phone + password",
  tags: ["Workers"],
  request: { body: { content: { "application/json": { schema: LoginWorkerReqSchema } } } },
  responses: { 200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), token: z.string(), data: z.any() }) } } } }
});

registry.registerPath({
  method: "get",
  path: "/api/workers/me",
  summary: "Own profile",
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
  summary: "Update worker GPS coordinates (worker self-service)",
  description: "Updates current geographic coordinates and location history for the authenticated worker. Identity is derived exclusively from the authenticated access token.",
  tags: ["Workers"],
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: UpdateWorkerLocationReqSchema } } } },
  responses: {
    200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: z.any() }) } } },
    400: { description: "Validation error, invalid coordinate bounds, or client-supplied identity rejected" },
    401: { description: "Unauthorized: Missing or invalid token" },
    403: { description: "Forbidden: Worker role required" },
    404: { description: "Worker not found or deactivated" },
    500: { description: "Internal server error" },
  },
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

registry.registerPath({
  method: "post",
  path: "/api/workers/me/documents/upload-url",
  summary: "Request a pre-signed short-lived upload URL for worker identity document",
  tags: ["Workers"],
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: RequestDocumentUploadUrlReqSchema } } } },
  responses: {
    200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: z.object({ upload_url: z.string(), object_key: z.string(), expires_in: z.number() }) }) } } },
    401: { description: "Unauthorized" },
    403: { description: "Forbidden" },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/workers/me/documents/{documentId}/access",
  summary: "Get authorized short-lived download URL for own identity document",
  tags: ["Workers"],
  security: [{ bearerAuth: [] }],
  parameters: [{ in: "path", name: "documentId", required: true, schema: { type: "string", format: "uuid" } }],
  responses: {
    200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: WorkerDocumentAccessResponseSchema }) } } },
    401: { description: "Unauthorized" },
    403: { description: "Forbidden" },
    404: { description: "Document not found" },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/workers/me/devices",
  summary: "Register or rotate worker push device token",
  tags: ["Workers"],
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: RegisterWorkerDeviceReqSchema } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: z.object({ success: z.boolean(), data: WorkerDeviceSchema }) } } },
    400: { description: "Bad request" },
    401: { description: "Unauthorized" },
    403: { description: "Forbidden" },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/workers/me/devices",
  summary: "List registered devices for authenticated worker",
  tags: ["Workers"],
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), data: z.array(WorkerDeviceSchema) }) } } },
    401: { description: "Unauthorized" },
    403: { description: "Forbidden" },
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/workers/me/devices/{deviceId}",
  summary: "Revoke a worker push device",
  tags: ["Workers"],
  security: [{ bearerAuth: [] }],
  parameters: [{ in: "path", name: "deviceId", required: true, schema: { type: "string" } }],
  responses: {
    200: { description: "Success", content: { "application/json": { schema: z.object({ success: z.boolean(), message: z.string() }) } } },
    401: { description: "Unauthorized" },
    403: { description: "Forbidden" },
  },
});

import { authEndpointRateLimiter } from "../../middlewares/rateLimiter";

router.post("/registerWorker", authEndpointRateLimiter, validateBody(CreateWorkerReqSchema), registerWorker);
router.post("/login", authEndpointRateLimiter, validateBody(LoginWorkerReqSchema), loginWorker);
router.get("/me", authenticateJWT, requireRole(UserRole.WORKER), getMe);
router.patch("/me", authenticateJWT, requireRole(UserRole.WORKER), validateBody(UpdateWorkerProfileReqSchema), updateMe);
router.patch("/me/location", authenticateJWT, requireRole(UserRole.WORKER), validateBody(UpdateWorkerLocationReqSchema), updateLocation);
router.patch("/me/online", authenticateJWT, requireRole(UserRole.WORKER), validateBody(UpdateWorkerOnlineStatusReqSchema), updateOnline);
router.post("/me/documents", authenticateJWT, requireRole(UserRole.WORKER), validateBody(UploadWorkerDocumentReqSchema), uploadDocuments);
router.post("/me/documents/upload-url", authenticateJWT, requireRole(UserRole.WORKER), validateBody(RequestDocumentUploadUrlReqSchema), requestUploadUrl);
router.get("/me/documents", authenticateJWT, requireRole(UserRole.WORKER), getDocuments);
router.get("/me/documents/:documentId/access", authenticateJWT, requireRole(UserRole.WORKER), validateParams(DocumentIdParamSchema), getDocumentAccess);
router.get("/me/analytics", authenticateJWT, requireRole(UserRole.WORKER), getAnalytics);
router.get("/me/bookings", authenticateJWT, requireRole(UserRole.WORKER), getBookings);
router.get("/me/earnings", authenticateJWT, requireRole(UserRole.WORKER), getEarnings);
router.patch("/me/device-token", authenticateJWT, requireRole(UserRole.WORKER), validateBody(UpdateDeviceTokenReqSchema), updateDeviceToken);
router.post("/me/devices", authenticateJWT, requireRole(UserRole.WORKER), validateBody(RegisterWorkerDeviceReqSchema), registerDevice);
router.get("/me/devices", authenticateJWT, requireRole(UserRole.WORKER), getDevices);
router.delete("/me/devices/:deviceId", authenticateJWT, requireRole(UserRole.WORKER), validateParams(WorkerDeviceIdParamSchema), revokeDevice);
router.post("/me/devices/revoke", authenticateJWT, requireRole(UserRole.WORKER), validateBody(RevokeWorkerDeviceReqSchema), revokeDevice);

export default router;
