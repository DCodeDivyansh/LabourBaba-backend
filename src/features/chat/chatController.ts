import { Request, Response } from "express";
import { chatService } from "./chatServices";
import { AuthenticatedRequest } from "../../middlewares/authMiddleware";

const getUserId = (req: Request) => {
  return (req as AuthenticatedRequest).user?.id || null;
};

export const getMessages = async (req: Request, res: Response): Promise<void> => {
  try {
    const { bookingId } = req.params as any;
    const userId = getUserId(req);
    if (!userId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }

    const messages = await chatService.getMessages(bookingId);
    res.status(200).json({ success: true, data: messages });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const sendMessage = async (req: Request, res: Response): Promise<void> => {
  try {
    const { bookingId } = req.params as any;
    const { content } = req.body;
    const userId = getUserId(req);
    if (!userId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }

    const message = await chatService.sendMessage(bookingId, userId, content);
    res.status(201).json({ success: true, data: message });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};
