import { Request, Response } from "express";
import prisma from "../../config/prisma";
import {
  generateToken,
  hashPassword,
  comparePassword,
  normalizePhoneToE164,
} from "../../utils/authUtils";
import {
  SignupCustomerReq,
  LoginCustomerReq,
} from "../../type/api_req.type";
import { AuthenticatedRequest, UserRole } from "../../middlewares/authMiddleware";
import { customerSelfSelect, toCustomerSelfDTO } from "../../shared/prismaSelects";
import { sessionService } from "../auth/session.service";
import { logger } from "../../utils/logger";

/**
 * Register a new customer.
 */
export const signupCustomer = async (
  req: Request,
  res: Response
): Promise<void> => {
  const reqLogger = (req as any).logger || logger;
  try {
    const { name, phone: rawPhone, password }: SignupCustomerReq = req.body;
    const phone = normalizePhoneToE164(rawPhone);

    const existingCustomer = await prisma.customer.findUnique({
      where: { phone },
    });

    if (existingCustomer) {
      res.status(409).json({
        success: false,
        code: "PHONE_ALREADY_REGISTERED",
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
      select: customerSelfSelect,
    });

    const token = generateToken({
      id: customer.id,
      phone: customer.phone,
      role: UserRole.CUSTOMER,
    });

    res.status(201).json({
      success: true,
      message: "Customer registered successfully",
      data: toCustomerSelfDTO(customer),
      token,
    });
  } catch (error: any) {
    if (error.code === "INVALID_PHONE_NUMBER") {
      res.status(422).json({
        success: false,
        code: "INVALID_PHONE_NUMBER",
        message: error.message,
      });
      return;
    }
    if (error.code === "P2002") {
      res.status(409).json({
        success: false,
        code: "PHONE_ALREADY_REGISTERED",
        message: "Customer with this phone number already exists",
      });
      return;
    }

    reqLogger.error("[customerAuthController] Signup error:", { error: error?.message, stack: error?.stack });

    res.status(500).json({
      success: false,
      code: "INTERNAL_SERVER_ERROR",
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
  const reqLogger = (req as any).logger || logger;
  try {
    const { phone: rawPhone, password }: LoginCustomerReq = req.body;
    const phone = normalizePhoneToE164(rawPhone);

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
      role: UserRole.CUSTOMER,
    });

    // Create server-side refresh session
    const sessionResult = await sessionService.createSession({
      userId: customer.id,
      userRole: UserRole.CUSTOMER,
      userAgent: req.headers["user-agent"],
      ipAddress: req.ip,
    });

    res.status(200).json({
      success: true,
      message: "Customer logged in successfully",
      data: toCustomerSelfDTO(customer),
      token,
      refreshToken: sessionResult.rawToken,
    });
  } catch (error: any) {
    if (error.code === "INVALID_PHONE_NUMBER") {
      res.status(422).json({
        success: false,
        code: "INVALID_PHONE_NUMBER",
        message: error.message,
      });
      return;
    }

    reqLogger.error("[customerAuthController] Login error:", { error: error?.message, stack: error?.stack });

    res.status(500).json({
      success: false,
      code: "INTERNAL_SERVER_ERROR",
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
  const reqLogger = (req as any).logger || logger;
  try {
    const customerId = req.user?.id;

    if (!customerId) {
      res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
      return;
    }

    if (req.user?.role !== UserRole.CUSTOMER) {
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
      select: customerSelfSelect,
    });

    if (!customer || (customer as any).deleted_at) {
      res.status(404).json({
        success: false,
        message: "Customer not found",
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: toCustomerSelfDTO(customer),
    });
  } catch (error: any) {
    reqLogger.error("[customerAuthController] Get current customer error:", { error: error?.message, stack: error?.stack });

    res.status(500).json({
      success: false,
      code: "INTERNAL_SERVER_ERROR",
      message: "Unable to load customer profile",
    });
  }
};