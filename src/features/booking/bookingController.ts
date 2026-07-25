import { Request, Response } from "express";
import { bookingService } from "./bookingServices";
import { ConfirmBookingCompleteReq, CancelBookingReq } from "../../type/api_req.type";
import { AuthenticatedRequest } from "../../middlewares/authMiddleware";

const getUserId = (req: Request) => {
  return (req as AuthenticatedRequest).user?.id || null;
};

export const getBooking = async (req: Request, res: Response): Promise<void> => {
  try {
    const { bookingId } = req.params as any;
    const booking = await bookingService.getBookingDetail(bookingId);
    res.status(200).json({ success: true, data: booking });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const verifyOtp = async (req: Request, res: Response): Promise<void> => {
  try {
    const { bookingId } = req.params as any;
    const { otp } = req.body; // Using inline extraction since schema is simple or part of auth
    const workerId = getUserId(req);
    if (!workerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const result = await bookingService.verifyOtp(bookingId, workerId, otp);
    res.status(200).json(result);
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const completeBooking = async (req: Request, res: Response): Promise<void> => {
  try {
    const { bookingId } = req.params as any;
    const workerId = getUserId(req);
    if (!workerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const result = await bookingService.completeBooking(bookingId, workerId);
    res.status(200).json(result);
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const confirmComplete = async (req: Request, res: Response): Promise<void> => {
  try {
    const { bookingId } = req.params as any;
    const customerId = getUserId(req);
    if (!customerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const payload: ConfirmBookingCompleteReq = req.body;
    const result = await bookingService.confirmComplete(bookingId, customerId, payload);
    res.status(200).json(result);
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const cancelBooking = async (req: Request, res: Response): Promise<void> => {
  try {
    const { bookingId } = req.params as any;
    const userId = getUserId(req);
    if (!userId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const payload: CancelBookingReq = req.body;
    const result = await bookingService.cancelBooking(bookingId, userId, payload);
    res.status(200).json(result);
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const getWorkerLocation = async (req: Request, res: Response): Promise<void> => {
  try {
    const { bookingId } = req.params as any;
    const customerId = getUserId(req);
    if (!customerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const location = await bookingService.getWorkerLocation(bookingId, customerId);
    res.status(200).json({ success: true, data: location });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
};
