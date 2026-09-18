import { Request, Response } from "express";
import { bookingService } from "./bookingServices";
import { ConfirmBookingCompleteReq, CancelBookingReq } from "../../type/api_req.type";
import { AuthenticatedRequest } from "../../middlewares/authMiddleware";
import { AuthorizationError } from "../../policies";

const getUserId = (req: Request) => {
  return (req as AuthenticatedRequest).user?.id || null;
};

export const getBooking = async (req: Request, res: Response): Promise<void> => {
  try {
    const { bookingId } = req.params as any;
    const actor = (req as AuthenticatedRequest).user;
    if (!actor) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }
    const booking = await bookingService.getBookingDetail(bookingId, actor);
    res.status(200).json({ success: true, data: booking });
  } catch (error: any) {
    if (error instanceof AuthorizationError) {
      res.status(error.status).json({ success: false, message: error.message });
      return;
    }
    if (error.statusCode === 403 || error.code === "FORBIDDEN" || error.message?.includes("Forbidden")) {
      res.status(403).json({ success: false, message: error.message || "Forbidden" });
      return;
    }
    if (error.message === "Booking not found" || error.statusCode === 404) {
      res.status(404).json({ success: false, message: "Booking not found" });
      return;
    }
    res.status(400).json({ success: false, message: error.message });
  }
};

export const verifyOtp = async (req: Request, res: Response): Promise<void> => {
  try {
    const { bookingId } = req.params as any;
    const { otp } = req.body; // Using inline extraction since schema is simple or part of auth
    const actor = (req as AuthenticatedRequest).user;
    if (!actor?.id) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const result = await bookingService.verifyOtp(bookingId, actor.id, otp, actor);
    res.status(200).json(result);
  } catch (error: any) {
    if (error instanceof AuthorizationError) {
      res.status(error.status).json({ success: false, message: error.message });
      return;
    }
    if (error.message?.includes("Forbidden") || error.message === "Unauthorized") {
      res.status(403).json({ success: false, message: error.message });
      return;
    }
    if (error.message === "Booking not found") {
      res.status(404).json({ success: false, message: "Booking not found" });
      return;
    }
    res.status(400).json({ success: false, message: error.message });
  }
};

export const completeBooking = async (req: Request, res: Response): Promise<void> => {
  try {
    const { bookingId } = req.params as any;
    const actor = (req as AuthenticatedRequest).user;
    if (!actor?.id) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const result = await bookingService.completeBooking(bookingId, actor.id, actor);
    res.status(200).json(result);
  } catch (error: any) {
    if (error instanceof AuthorizationError) {
      res.status(error.status).json({ success: false, message: error.message });
      return;
    }
    if (error.message?.includes("Forbidden") || error.message === "Unauthorized") {
      res.status(403).json({ success: false, message: error.message });
      return;
    }
    if (error.message === "Booking not found") {
      res.status(404).json({ success: false, message: "Booking not found" });
      return;
    }
    res.status(400).json({ success: false, message: error.message });
  }
};

export const confirmComplete = async (req: Request, res: Response): Promise<void> => {
  try {
    const { bookingId } = req.params as any;
    const actor = (req as AuthenticatedRequest).user;
    if (!actor?.id) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const payload: ConfirmBookingCompleteReq = req.body;
    const result = await bookingService.confirmComplete(bookingId, actor.id, payload, actor);
    res.status(200).json(result);
  } catch (error: any) {
    if (error instanceof AuthorizationError) {
      res.status(error.status).json({ success: false, message: error.message });
      return;
    }
    if (error.message?.includes("Forbidden") || error.message === "Unauthorized") {
      res.status(403).json({ success: false, message: error.message });
      return;
    }
    if (error.message === "Booking not found") {
      res.status(404).json({ success: false, message: "Booking not found" });
      return;
    }
    res.status(400).json({ success: false, message: error.message });
  }
};

export const cancelBooking = async (req: Request, res: Response): Promise<void> => {
  try {
    const { bookingId } = req.params as any;
    const actor = (req as AuthenticatedRequest).user;
    if (!actor?.id) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const payload: CancelBookingReq = req.body;
    const result = await bookingService.cancelBooking(bookingId, actor.id, payload, actor);
    res.status(200).json(result);
  } catch (error: any) {
    if (error instanceof AuthorizationError) {
      res.status(error.status).json({ success: false, message: error.message });
      return;
    }
    if (error.message?.includes("Forbidden") || error.message === "Unauthorized") {
      res.status(403).json({ success: false, message: "Forbidden: Not an authorized participant of this booking" });
      return;
    }
    if (error.message === "Booking not found") {
      res.status(404).json({ success: false, message: "Booking not found" });
      return;
    }
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
