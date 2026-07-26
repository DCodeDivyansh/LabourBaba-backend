import { Request, Response } from "express";
import prisma from "../../config/prisma";
import { getAll, customerService } from "../../shared/customerServices"
import { CreateCustomerReq } from "../../type/api_req.type"


export const getClient = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const clients = await getAll();
    res.status(200).json({
      success: true,
      data: clients,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error?.message || "An error occurred",
    });
  }
};


export const postClient = async (req: Request, res: Response): Promise<void> => {
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
    console.log(error)
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};
