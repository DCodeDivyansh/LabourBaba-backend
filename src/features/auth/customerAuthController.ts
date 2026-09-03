import { Request, Response } from "express";
import prisma from "../../config/prisma";
import {
  generateToken,
  hashPassword,
  comparePassword,
} from "../../utils/authUtils";
import {
  SignupCustomerReq,
  LoginCustomerReq,
} from "../../type/api_req.type";
import { AuthenticatedRequest } from "../../middlewares/authMiddleware";

/**
 * Remove sensitive fields before sending customer data to the frontend.
 */
function sanitizeCustomer(customer: {
  id: string;
  phone: string;
  name: string;
  created_at?: Date | null;
  deleted_at?: Date | null;
}) {
  return {
    id: customer.id,
    phone: customer.phone,
    name: customer.name,
    created_at: customer.created_at,
    deleted_at: customer.deleted_at,
  };
}

/**
 * Register a new customer.
 */
export const signupCustomer = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { name, phone, password }: SignupCustomerReq = req.body;

    const existingCustomer = await prisma.customer.findUnique({
      where: { phone },
    });

    if (existingCustomer) {
      res.status(409).json({
        success: false,
        message: "Customer with this phone number already exists",
      });
      return;
    }

    const hashedPassword = await hashPassword(password);

    const customer = await prisma.customer.create({
      data: {
        name: name.trim(),
        phone,
        password: hashedPassword,
      },
    });

    const token = generateToken({
      id: customer.id,
      phone: customer.phone,
      role: "customer",
    });

    res.status(201).json({
      success: true,
      message: "Customer registered successfully",
      data: sanitizeCustomer(customer),
      token,
    });
  } catch (error: any) {
    console.error("Signup error:", error);

    res.status(500).json({
      success: false,
      message: "An error occurred during customer signup",
    });
  }
};

/**
 * Log in an existing customer.
 */
export const loginCustomer = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { phone, password }: LoginCustomerReq = req.body;

    const customer = await prisma.customer.findUnique({
      where: { phone },
    });

    if (!customer || customer.deleted_at) {
      res.status(401).json({
        success: false,
        message: "Invalid phone number or password",
      });
      return;
    }

    const isPasswordValid = await comparePassword(
      password,
      customer.password
    );

    if (!isPasswordValid) {
      res.status(401).json({
        success: false,
        message: "Invalid phone number or password",
      });
      return;
    }

    const token = generateToken({
      id: customer.id,
      phone: customer.phone,
      role: "customer",
    });

    res.status(200).json({
      success: true,
      message: "Customer logged in successfully",
      data: sanitizeCustomer(customer),
      token,
    });
  } catch (error: any) {
    console.error("Login error:", error);

    res.status(500).json({
      success: false,
      message: "An error occurred during customer login",
    });
  }
};

/**
 * Get the currently authenticated customer.
 *
 * GET /api/clients/me
 *
 * The customer ID comes from the verified JWT.
 * The client does NOT provide the customer ID.
 */
export const getCurrentCustomer = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const customerId = req.user?.id;

    if (!customerId) {
      res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
      return;
    }

    if (req.user?.role !== "customer") {
      res.status(403).json({
        success: false,
        message: "Customer access required",
      });
      return;
    }

    const customer = await prisma.customer.findUnique({
      where: {
        id: customerId,
      },
    });

    if (!customer || customer.deleted_at) {
      res.status(404).json({
        success: false,
        message: "Customer not found",
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: sanitizeCustomer(customer),
    });
  } catch (error: any) {
    console.error("Get current customer error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to load customer profile",
    });
  }
};