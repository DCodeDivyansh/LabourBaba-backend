import express from "express";
import { UpdateWorkerLocationReqSchema } from "../../schemas";
import { registry } from "../../config/swagger";
import { z } from "zod";
import { authenticateJWT, requireRole, UserRole } from "../../middlewares/authMiddleware";
import { validateBody } from "../../middlewares/validationMiddleware";
import { addLocation } from "./worker_location.controller";

// Register POST /api/worker_location/add
registry.registerPath({
  method: "post",
  path: "/api/worker_location/add",
  summary: "Update/Add worker location (worker self-service)",
  description: "Updates current geographic location and historical log for the authenticated worker. Identity is derived exclusively from req.user.id. Client-supplied identity fields are rejected.",
  tags: ["Worker Location"],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: UpdateWorkerLocationReqSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Worker location updated successfully",
      content: {
        "application/json": {
          schema: z.object({
            success: z.boolean(),
            data: z.any(),
          }),
        },
      },
    },
    400: {
      description: "Validation error, invalid coordinate bounds, or client-supplied identity field rejected",
    },
    401: {
      description: "Unauthorized: Missing or invalid JWT",
    },
    403: {
      description: "Forbidden: Only workers can update worker location",
    },
    404: {
      description: "Worker not found or account is deactivated",
    },
    500: {
      description: "Internal server error",
    },
  },
});

import { workerLocationRateLimiter } from "../../middlewares/rateLimiter";

const workerLocationRoute = express.Router();
workerLocationRoute.post(
  "/add",
  authenticateJWT,
  requireRole(UserRole.WORKER),
  workerLocationRateLimiter,
  validateBody(UpdateWorkerLocationReqSchema),
  addLocation
);

export default workerLocationRoute;
