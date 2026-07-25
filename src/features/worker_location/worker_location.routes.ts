import express from "express";
import { UpdateWorkerLocationReqSchema } from "../../schemas";
import { registry } from "../../config/swagger";
import { z } from "zod";
import { authenticateJWT } from "../../middlewares/authMiddleware";
import { addLocation } from "./worker_location.controller";

// Register POST /api/worker_location/add
registry.registerPath({
  method: "post",
  path: "/api/worker_location/add",
  summary: "Update/Add worker location",
  tags: ["Worker Location"],
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
    500: {
      description: "Internal server error",
    },
  },
});

const workerLocationRoute = express.Router();
workerLocationRoute.post("/add", authenticateJWT, addLocation)
export default workerLocationRoute;
