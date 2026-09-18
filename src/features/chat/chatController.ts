import { Request, Response } from "express";
import { chatService } from "./chatServices";
import { AuthenticatedRequest } from "../../middlewares/authMiddleware";
import { toChatMessageDTO } from "../../shared/prismaSelects";

export const getMessages = async (req: Request, res: Response): Promise<void> => {
  try {
    const { bookingId } = req.params as any;
    const actor = (req as AuthenticatedRequest).user;
    if (!actor) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }

    const messages = await chatService.getMessages(bookingId, actor);
    res.status(200).json({ success: true, data: messages.map(toChatMessageDTO).filter(Boolean) });
  } catch (error: any) {
    if (error.statusCode === 403 || error.code === "NOT_PARTICIPANT" || error.message?.includes("Forbidden")) {
      res.status(403).json({ success: false, message: error.message || "Forbidden: Not an authorized participant of this conversation" });
      return;
    }
    if (error.statusCode === 404 || error.message === "Booking not found") {
      res.status(404).json({ success: false, message: "Booking not found" });
      return;
    }
    res.status(500).json({ success: false, message: "Failed to retrieve messages" });
  }
};

export const sendMessage = async (req: Request, res: Response): Promise<void> => {
  try {
    const { bookingId } = req.params as any;
    const { content } = req.body;
    const actor = (req as AuthenticatedRequest).user;
    if (!actor) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }

    const message = await chatService.sendMessage(bookingId, actor.id, content, actor);
    res.status(201).json({ success: true, data: toChatMessageDTO(message) });
  } catch (error: any) {
    if (error.statusCode === 403 || error.code === "NOT_PARTICIPANT" || error.message?.includes("Forbidden")) {
      res.status(403).json({ success: false, message: error.message || "Forbidden: Not an authorized participant of this conversation" });
      return;
    }
    if (error.statusCode === 404 || error.message === "Booking not found") {
      res.status(404).json({ success: false, message: "Booking not found" });
      return;
    }
    res.status(500).json({ success: false, message: "Failed to send message" });
  }
};

