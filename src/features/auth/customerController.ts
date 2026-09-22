import { Request, Response } from "express";
import prisma from "../../config/prisma";
import { getAll, customerService } from "../../shared/customerServices";
import { CreateCustomerReq } from "../../type/api_req.type";
import { logger } from "../../utils/logger";

export const getClient = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const reqLogger = (req as any).logger || logger;
  try {
    const clients = await getAll();
    res.status(200).json({
      success: true,
      data: clients,
    });
  } catch (error: any) {
    reqLogger.error("[customerController] getClient error:", { error: error?.message, stack: error?.stack });
    res.status(500).json({
      success: false,
      code: "INTERNAL_SERVER_ERROR",
      message: "An unexpected internal error occurred.",
    });
  }
};

export const postClient = async (req: Request, res: Response): Promise<void> => {
  const reqLogger = (req as any).logger || logger;
  try {
    const payload: CreateCustomerReq = req.body;

    const customer = await customerService(
      payload
    );
    res.status(201).json({
      success: true,
      data: customer,
    });
  } catch (error: any) {
    if (error.code === "PHONE_ALREADY_REGISTERED" || error.code === "P2002") {
      res.status(409).json({ success: false, code: "PHONE_ALREADY_REGISTERED", message: "Customer with this phone number already exists" });
      return;
    }
    if (error.code === "INVALID_PHONE_NUMBER") {
      res.status(422).json({ success: false, code: "INVALID_PHONE_NUMBER", message: error.message || "Invalid phone number" });
      return;
    }
    reqLogger.error("[customerController] postClient error:", { error: error?.message, stack: error?.stack });
    res.status(500).json({
      success: false,
      code: "INTERNAL_SERVER_ERROR",
      message: "An unexpected internal error occurred.",
    });
  }
};
