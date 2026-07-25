import { Request, Response } from "express";
import { reviewService } from "./reviewServices";
import { CreateReviewReq } from "../../type/api_req.type";

const getCustomerId = (req: Request) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  return "a1b2c3d4-e5f6-7890-1234-56789abcdef0"; // Mock customer ID
};

export const createReview = async (req: Request, res: Response): Promise<void> => {
  try {
    const { bookingId } = req.params as any;
    const customerId = getCustomerId(req);
    if (!customerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }

    const payload: CreateReviewReq = req.body;
    const review = await reviewService.createReview(bookingId, customerId, payload);
    res.status(201).json({ success: true, data: review });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getWorkerReviews = async (req: Request, res: Response): Promise<void> => {
  try {
    const { workerId } = req.params as any;
    const reviews = await reviewService.getWorkerReviews(workerId);
    res.status(200).json({ success: true, data: reviews });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getBookingReview = async (req: Request, res: Response): Promise<void> => {
  try {
    const { bookingId } = req.params as any;
    const review = await reviewService.getBookingReview(bookingId);
    res.status(200).json({ success: true, data: review });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};
