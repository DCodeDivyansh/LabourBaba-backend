import { Request, Response } from "express";
import { paymentService } from "./paymentServices";

export const createOrder = async (req: Request, res: Response): Promise<void> => {
  try {
    const { bookingId } = req.params as any;
    const { amount } = req.body;
    const payment = await paymentService.createOrder(bookingId, amount);
    res.status(201).json({ success: true, data: payment });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const handleWebhook = async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = req.body;
    const result = await paymentService.handleWebhook(payload);
    res.status(200).json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getPaymentStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const { bookingId } = req.params as any;
    const payments = await paymentService.getPaymentStatus(bookingId);
    res.status(200).json({ success: true, data: payments });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const refundPayment = async (req: Request, res: Response): Promise<void> => {
  try {
    const { bookingId } = req.params as any;
    const result = await paymentService.refundPayment(bookingId);
    res.status(200).json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};
