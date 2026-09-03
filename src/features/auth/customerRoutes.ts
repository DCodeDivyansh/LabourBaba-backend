import express from "express";
import { getClient, postClient } from "./customerController";
import {
  signupCustomer,
  loginCustomer,
  getCurrentCustomer,
} from "./customerAuthController";
import { validateBody } from "../../middlewares/validationMiddleware";
import { authenticateJWT } from "../../middlewares/authMiddleware";
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

// Express route mappings
// clientRoute.get("/", authenticateJWT, getClient);
// clientRoute.post("/add", authenticateJWT, validateBody(CreateCustomerReqSchema), postClient);
clientRoute.post("/signup", validateBody(SignupCustomerReqSchema), signupCustomer);
clientRoute.post("/login", validateBody(LoginCustomerReqSchema), loginCustomer);
clientRoute.get(
  "/me",
  authenticateJWT,
  getCurrentCustomer
);

export default clientRoute;
