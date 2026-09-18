import { Server, Socket } from "socket.io";
import prisma from "../config/prisma";
import { UserRole } from "../type/userRole";
import {
  AuthenticatedSocket,
  WorkerLocationPayload,
  JoinBookingPayload,
  SendChatMessagePayload,
  SocketAckResponse,
} from "./socketTypes";
import { chatService } from "../features/chat/chatServices";
import { chatPolicy, AuthorizationError } from "../policies";
import { toChatMessageDTO } from "../shared/prismaSelects";

/**
 * Registers secure Socket.IO event handlers.
 *
 * Security Invariants Enforced:
 * 1. Client-supplied identity is NEVER authoritative.
 * 2. Personal rooms (worker:<id>, customer:<id>) are automatically joined upon connection
 *    based exclusively on socket.data.user.id.
 * 3. Identity spoofing attempts in client payloads are strictly rejected (HTTP 403 / FORBIDDEN).
 * 4. Location broadcasts verify active assignment between the authenticated worker and customer.
 * 5. Booking and chat rooms strictly verify database-backed participant authorization.
 */
export function registerSocketHandlers(io: Server): void {
  io.on("connection", (rawSocket: Socket) => {
    const socket = rawSocket as AuthenticatedSocket;
    const user = socket.data.user;

    if (!user || !user.id || !user.role) {
      console.warn(`[SOCKET] Unauthenticated socket connected unexpectedly: ${socket.id}`);
      socket.disconnect(true);
      return;
    }

    console.log(`[SOCKET] Authenticated socket connected: ${socket.id} (user: ${user.id}, role: ${user.role})`);

    // ========================================================================
    // 1. Automatic Personal Room Membership
    // ========================================================================
    if (user.role === UserRole.WORKER) {
      socket.join(`worker:${user.id}`);
    } else if (user.role === UserRole.CUSTOMER) {
      socket.join(`customer:${user.id}`);
    } else if (user.role === UserRole.ADMIN) {
      socket.join(`admin:${user.id}`);
      socket.join("admins");
    }

    // ========================================================================
    // 2. Legacy / Client "join:worker" Handler
    // Rejects unauthorized access or attempt to join another worker's room
    // ========================================================================
    socket.on("join:worker", (workerId?: string, callback?: (res: SocketAckResponse) => void) => {
      if (user.role !== UserRole.WORKER && user.role !== UserRole.ADMIN) {
        console.warn(`[SOCKET_SECURITY] Role violation: User ${user.id} (${user.role}) attempted join:worker`);
        const response: SocketAckResponse = {
          success: false,
          code: "FORBIDDEN",
          message: "Forbidden: Worker role required",
        };
        socket.emit("error", response);
        callback?.(response);
        return;
      }

      if (workerId && workerId !== user.id && user.role !== UserRole.ADMIN) {
        console.warn(
          `[SOCKET_SECURITY] Identity spoofing attempt: Worker ${user.id} attempted to join worker room for ${workerId}`
        );
        const response: SocketAckResponse = {
          success: false,
          code: "FORBIDDEN",
          message: "Forbidden: Cannot join another worker's room",
        };
        socket.emit("error", response);
        callback?.(response);
        return;
      }

      socket.join(`worker:${user.id}`);
      const response: SocketAckResponse = {
        success: true,
        message: `Joined worker room: worker:${user.id}`,
      };
      callback?.(response);
    });

    // ========================================================================
    // 3. Legacy / Client "join:customer" Handler
    // Rejects unauthorized access or attempt to join another customer's room
    // ========================================================================
    socket.on("join:customer", (customerId?: string, callback?: (res: SocketAckResponse) => void) => {
      if (user.role !== UserRole.CUSTOMER && user.role !== UserRole.ADMIN) {
        console.warn(`[SOCKET_SECURITY] Role violation: User ${user.id} (${user.role}) attempted join:customer`);
        const response: SocketAckResponse = {
          success: false,
          code: "FORBIDDEN",
          message: "Forbidden: Customer role required",
        };
        socket.emit("error", response);
        callback?.(response);
        return;
      }

      if (customerId && customerId !== user.id && user.role !== UserRole.ADMIN) {
        console.warn(
          `[SOCKET_SECURITY] Identity spoofing attempt: Customer ${user.id} attempted to join customer room for ${customerId}`
        );
        const response: SocketAckResponse = {
          success: false,
          code: "FORBIDDEN",
          message: "Forbidden: Cannot join another customer's room",
        };
        socket.emit("error", response);
        callback?.(response);
        return;
      }

      socket.join(`customer:${user.id}`);
      const response: SocketAckResponse = {
        success: true,
        message: `Joined customer room: customer:${user.id}`,
      };
      callback?.(response);
    });

    // ========================================================================
    // 4. Secure "worker:location_update" Handler
    // - Authoritative worker identity is strictly socket.data.user.id
    // - Role must be WORKER
    // - Explicitly rejects spoofed workerId in payload
    // - Validates active relationship between worker and target customer
    // ========================================================================
    socket.on(
      "worker:location_update",
      async (
        payload: WorkerLocationPayload,
        callback?: (res: SocketAckResponse) => void
      ) => {
        try {
          // Role check
          if (user.role !== UserRole.WORKER) {
            console.warn(
              `[SOCKET_SECURITY] Role violation: Non-worker ${user.id} (${user.role}) attempted location update`
            );
            const response: SocketAckResponse = {
              success: false,
              code: "FORBIDDEN",
              message: "Forbidden: Only workers can broadcast location updates",
            };
            socket.emit("error", response);
            callback?.(response);
            return;
          }

          const { customerId, lat, lng, workerId } = payload || {};

          // Rejection of identity spoofing attempt
          if (workerId && workerId !== user.id) {
            console.warn(
              `[SOCKET_SECURITY] Location spoofing attempt: Authenticated worker ${user.id} sent workerId ${workerId}`
            );
            const response: SocketAckResponse = {
              success: false,
              code: "FORBIDDEN",
              message: "Forbidden: Cannot spoof worker identity",
            };
            socket.emit("error", response);
            callback?.(response);
            return;
          }

          if (!customerId || lat === undefined || lng === undefined) {
            const response: SocketAckResponse = {
              success: false,
              code: "INVALID_REQUEST",
              message: "Missing required fields: customerId, lat, lng",
            };
            socket.emit("error", response);
            callback?.(response);
            return;
          }

          // Verify worker has an active assigned booking or job with this customer
          const activeRelationship = await prisma.booking.findFirst({
            where: {
              worker_id: user.id,
              customer_id: customerId,
              status: {
                in: ["assigned", "accepted", "in_progress", "arrived", "confirmed", "ACTIVE"],
              },
            },
            select: { id: true },
          });

          if (!activeRelationship) {
            console.warn(
              `[SOCKET_SECURITY] Unauthorized location broadcast: Worker ${user.id} has no active booking with customer ${customerId}`
            );
            const response: SocketAckResponse = {
              success: false,
              code: "FORBIDDEN",
              message: "Forbidden: Not assigned to this customer",
            };
            socket.emit("error", response);
            callback?.(response);
            return;
          }

          // Authoritative broadcast using trusted socket.data.user.id
          io.to(`customer:${customerId}`).emit("worker:location", {
            workerId: user.id,
            lat,
            lng,
          });

          callback?.({ success: true });
        } catch (err: any) {
          console.error(`[SOCKET] Error processing worker location update:`, err.message);
          callback?.({
            success: false,
            code: "INTERNAL_ERROR",
            message: "Failed to process location update",
          });
        }
      }
    );

    // ========================================================================
    // 5. Secure "join:booking" / "join:chat" Handler
    // Enforces database-backed participant authorization
    // ========================================================================
    socket.on(
      "join:booking",
      async (payload: JoinBookingPayload, callback?: (res: SocketAckResponse) => void) => {
        try {
          const { bookingId } = payload || {};

          if (!bookingId) {
            const response: SocketAckResponse = {
              success: false,
              code: "INVALID_REQUEST",
              message: "bookingId is required",
            };
            socket.emit("error", response);
            callback?.(response);
            return;
          }

          const booking = await prisma.booking.findUnique({
            where: { id: bookingId },
            select: { id: true, customer_id: true, worker_id: true },
          });

          if (!booking) {
            const response: SocketAckResponse = {
              success: false,
              code: "RESOURCE_NOT_FOUND",
              message: "Booking not found",
            };
            socket.emit("error", response);
            callback?.(response);
            return;
          }

          const decision = chatPolicy.canJoinRoom(user, booking);
          if (!decision.allowed) {
            console.warn(
              `[SOCKET_SECURITY] Unauthorized room join: User ${user.id} (${user.role}) attempted to join booking ${bookingId}`
            );
            const response: SocketAckResponse = {
              success: false,
              code: "FORBIDDEN",
              message: "Forbidden: Not an authorized participant of this booking",
            };
            socket.emit("error", response);
            callback?.(response);
            return;
          }

          socket.join(`booking:${bookingId}`);
          callback?.({
            success: true,
            message: `Joined booking room: booking:${bookingId}`,
          });
        } catch (err: any) {
          console.error(`[SOCKET] Error processing join:booking:`, err.message);
          callback?.({
            success: false,
            code: "INTERNAL_ERROR",
            message: "Failed to join booking room",
          });
        }
      }
    );

    // ========================================================================
    // 6. Secure "chat:message" Handler
    // Enforces participant authorization and derives sender identity from user.id
    // ========================================================================
    socket.on(
      "chat:message",
      async (payload: SendChatMessagePayload, callback?: (res: SocketAckResponse) => void) => {
        try {
          const { bookingId, content } = payload || {};

          if (!bookingId || !content || content.trim().length === 0) {
            const response: SocketAckResponse = {
              success: false,
              code: "INVALID_REQUEST",
              message: "bookingId and content are required",
            };
            socket.emit("error", response);
            callback?.(response);
            return;
          }

          // Authoritative sender is ALWAYS socket.data.user.id
          const rawMessage = await chatService.sendMessage(bookingId, user.id, content.trim(), user);
          const message = toChatMessageDTO(rawMessage);

          // Broadcast to authorized booking room
          io.to(`booking:${bookingId}`).emit("chat:message", message);

          callback?.({ success: true, data: message });
        } catch (err: any) {
          console.warn(`[SOCKET] Chat message failed for user ${user.id}:`, err.message);
          const isForbidden =
            err instanceof AuthorizationError ||
            err.code === "NOT_PARTICIPANT" ||
            err.message === "Unauthorized" ||
            err.message?.includes("Forbidden");

          const response: SocketAckResponse = {
            success: false,
            code: isForbidden ? "FORBIDDEN" : (err.code || "INTERNAL_ERROR"),
            message: err.message || "Failed to send message",
          };
          socket.emit("error", response);
          callback?.(response);
        }
      }
    );

    socket.on("disconnect", () => {
      console.log(`[SOCKET] Disconnected: ${socket.id} (user: ${user.id})`);
    });
  });
}
