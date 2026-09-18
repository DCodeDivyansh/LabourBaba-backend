import { Request, Response } from "express";
import { chatService } from "./chatServices";
import { AuthenticatedRequest } from "../../middlewares/authMiddleware";
import { toChatMessageDTO } from "../../shared/prismaSelects";
import { AuthorizationError } from "../../policies";
import { getBookingChatRoom } from "../../socket/roomHelpers";
import { io } from "../../server";

function handleChatError(res: Response, error: any, defaultMessage: string): void {
  if (error instanceof AuthorizationError || error.statusCode) {
    res.status(error.statusCode || 403).json({
      success: false,
      message: error.message || "Forbidden: Not an authorized participant of this conversation",
    });
    return;
  }
  if (error.code === "NOT_PARTICIPANT" || error.message?.includes("Forbidden")) {
    res.status(403).json({
      success: false,
      message: error.message || "Forbidden: Not an authorized participant of this conversation",
    });
    return;
  }
  if (error.message === "Booking not found" || error.code === "RESOURCE_NOT_FOUND") {
    res.status(404).json({
      success: false,
      message: "Booking not found",
    });
    return;
  }
  res.status(500).json({ success: false, message: defaultMessage });
}

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
    handleChatError(res, error, "Failed to retrieve messages");
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

    // Authoritative sender identity is ALWAYS actor.id derived from verified JWT
    const message = await chatService.sendMessage(bookingId, actor.id, content, actor);
    const dto = toChatMessageDTO(message);

    // Broadcast to real-time socket room if socket server is active
    try {
      if (io && typeof io.to === "function") {
        io.to(getBookingChatRoom(bookingId)).emit("chat:message", dto);
      }
    } catch {
      // Non-blocking socket broadcast failure
    }

    res.status(201).json({ success: true, data: dto });
  } catch (error: any) {
    handleChatError(res, error, "Failed to send message");
  }
};
