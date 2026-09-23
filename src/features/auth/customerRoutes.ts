import express from "express";
import { getClient, postClient } from "./customerController";
import {
  signupCustomer,
  loginCustomer,
  getCurrentCustomer,
} from "./customerAuthController";
import { validateBody } from "../../middlewares/validationMiddleware";
import { authenticateJWT, requireRole, UserRole } from "../../middlewares/authMiddleware";
import { CreateCustomerReqSchema, CustomerSchema, SignupCustomerReqSchema, LoginCustomerReqSchema } from "../../schemas";
import { registry } from "../../config/swagger";
import { z } from "zod";

const clientRoute = express.Router();

// Register GET /api/clients
// registry.registerPath({
//   method: "get",
//   path: "/api/clients",
//   summary: "Get all customers/clients",
//   tags: ["Clients"],
//   responses: {
//     200: {
//       description: "List of all clients",
//       content: {
//         "application/json": {
//           schema: z.object({
//             success: z.boolean(),
//             data: z.array(CustomerSchema),
//           }),
//         },
//       },
//     },
//     500: {
//       description: "Internal server error",
//     },
//   },
// });

// Register POST /api/clients/add
// registry.registerPath({
//   method: "post",
//   path: "/api/clients/add",
//   summary: "Create a new customer/client",
//   tags: ["Clients"],
//   request: {
//     body: {
//       content: {
//         "application/json": {
//           schema: CreateCustomerReqSchema,
//         },
//       },
//     },
//   },
//   responses: {
//     201: {
//       description: "Customer created successfully",
//       content: {
//         "application/json": {
//           schema: z.object({
//             success: z.boolean(),
//             data: CustomerSchema,
//           }),
//         },
//       },
//     },
//     400: {
//       description: "Validation failed",
//     },
//     500: {
//       description: "Internal server error",
//     },
//   },
// });

// Register POST /api/clients/signup
registry.registerPath({
  method: "post",
  path: "/api/clients/signup",
  summary: "Register/Signup as a new customer",
  tags: ["Clients Auth"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: SignupCustomerReqSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: "Customer registered successfully",
      content: {
        "application/json": {
          schema: z.object({
            success: z.boolean(),
            message: z.string(),
            data: CustomerSchema,
            token: z.string(),
          }),
        },
      },
    },
    400: {
      description: "Validation failed or phone number already registered",
    },
    500: {
      description: "Internal server error",
    },
  },
});

// Register POST /api/clients/login
registry.registerPath({
  method: "post",
  path: "/api/clients/login",
  summary: "Log in as an existing customer",
  tags: ["Clients Auth"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: LoginCustomerReqSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Customer logged in successfully",
      content: {
        "application/json": {
          schema: z.object({
            success: z.boolean(),
            message: z.string(),
            data: CustomerSchema,
            token: z.string(),
          }),
        },
      },
    },
    401: {
      description: "Invalid phone number or password",
    },
    400: {
      description: "Validation failed",
    },
    500: {
      description: "Internal server error",
    },
  },
});

import { authEndpointRateLimiter } from "../../middlewares/rateLimiter";
import {
  registerCustomerDevice,
  listCustomerDevices,
  revokeCustomerDevice,
  listCustomerNotifications,
  getUnreadCustomerNotifications,
  acknowledgeCustomerNotification,
  acknowledgeAllCustomerNotifications,
} from "../customer_notification/customer_notification.controller";

// Express route mappings
// ADMIN-only: enumerate all customers (administrative customer management)
clientRoute.get("/", authenticateJWT, requireRole(UserRole.ADMIN), getClient);
// ADMIN-only: create a customer via back-office path (self-service signup uses /signup)
clientRoute.post("/add", authenticateJWT, requireRole(UserRole.ADMIN), validateBody(CreateCustomerReqSchema), postClient);
// Public: rate-limited self-registration and login
clientRoute.post("/signup", authEndpointRateLimiter, validateBody(SignupCustomerReqSchema), signupCustomer);
clientRoute.post("/login", authEndpointRateLimiter, validateBody(LoginCustomerReqSchema), loginCustomer);
// CUSTOMER-only: self-service profile — defense-in-depth at route layer;
// controller additionally validates req.user.role and uses req.user.id (not client-supplied)
clientRoute.get(
  "/me",
  authenticateJWT,
  requireRole(UserRole.CUSTOMER),
  getCurrentCustomer
);

// Customer Device Management (P6 Issue 5)
clientRoute.post("/me/devices", authenticateJWT, requireRole(UserRole.CUSTOMER), registerCustomerDevice);
clientRoute.get("/me/devices", authenticateJWT, requireRole(UserRole.CUSTOMER), listCustomerDevices);
clientRoute.delete("/me/devices/:deviceId", authenticateJWT, requireRole(UserRole.CUSTOMER), revokeCustomerDevice);

// Customer Notification History & Recovery (P6 Issue 5)
clientRoute.get("/notifications", authenticateJWT, requireRole(UserRole.CUSTOMER), listCustomerNotifications);
clientRoute.get("/notifications/unread", authenticateJWT, requireRole(UserRole.CUSTOMER), getUnreadCustomerNotifications);
clientRoute.post("/notifications/:id/acknowledge", authenticateJWT, requireRole(UserRole.CUSTOMER), acknowledgeCustomerNotification);
clientRoute.post("/notifications/:id/ack", authenticateJWT, requireRole(UserRole.CUSTOMER), acknowledgeCustomerNotification);
clientRoute.post("/notifications/ack-all", authenticateJWT, requireRole(UserRole.CUSTOMER), acknowledgeAllCustomerNotifications);

export default clientRoute;

