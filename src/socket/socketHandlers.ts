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
import { chatPolicy, jobPolicy, requirementPolicy, AuthorizationError } from "../policies";
import { toChatMessageDTO } from "../shared/prismaSelects";
import {
  getBookingChatRoom,
  getWorkerPersonalRoom,
  getCustomerPersonalRoom,
  getAdminPersonalRoom,
  getJobRoom,
  getRequirementRoom,
} from "./roomHelpers";
import { isValidIdentifier } from "../schemas";
import { setSocketServer } from "./socketLifecycle";
import { workerLocationService } from "../features/worker_location/worker_location.service";
import { validateCoordinatePair } from "../utils/coordinateValidator";
import { logger } from "../utils/logger";

/**
 * Registers secure Socket.IO event handlers.
 *
 * Security Invariants Enforced:
 * 1. Client-supplied identity is NEVER authoritative.
 * 2. Personal rooms (worker:<id>, customer:<id>) are automatically joined upon connection
 *    based exclusively on socket.data.user.id.
 * 3. Identity spoofing attempts in client payloads are strictly rejected (HTTP 403 / FORBIDDEN).
 * 4. Location broadcasts verify active assignment between the authenticated worker and customer.
 * 5. Booking and chat rooms strictly verify database-backed participant authorization using chatPolicy.
 * 6. Room names are ALWAYS server-derived and deterministic (zero client-controlled namespaces).
 * 7. HTTP and Socket.IO chat policies are identical.
 */
export function registerSocketHandlers(io: Server): void {
  // Register runtime server instance for targeted socket invalidation / suspension disconnects
  setSocketServer(io);

  io.on("connection", (rawSocket: Socket) => {
    const socket = rawSocket as AuthenticatedSocket;
    const user = socket.data.user;

    if (!user || !user.id || !user.role) {
      logger.warn(`[SOCKET] Unauthenticated socket connected unexpectedly: ${socket.id}`, { socketId: socket.id });
      socket.disconnect(true);
      return;
    }

    logger.info(`[SOCKET] Authenticated socket connected: ${socket.id} (user: ${user.id}, role: ${user.role})`, { socketId: socket.id, userId: user.id, role: user.role });

    // ========================================================================
    // 1. Automatic Personal Room Membership
    // ========================================================================
    if (user.role === UserRole.WORKER) {
      socket.join(getWorkerPersonalRoom(user.id));
    } else if (user.role === UserRole.CUSTOMER) {
      socket.join(getCustomerPersonalRoom(user.id));
    } else if (user.role === UserRole.ADMIN) {
      socket.join(getAdminPersonalRoom(user.id));
      socket.join("admins");
    }

    // ========================================================================
    // 2. Legacy / Client "join:worker" Handler
    // Rejects unauthorized access or attempt to join another worker's room
    // ========================================================================
    socket.on("join:worker", (workerId?: string, callback?: (res: SocketAckResponse) => void) => {
      if (user.role !== UserRole.WORKER && user.role !== UserRole.ADMIN) {
        logger.warn(`[SOCKET_SECURITY] Role violation: User ${user.id} (${user.role}) attempted join:worker`, { userId: user.id, role: user.role });
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
        logger.warn(
          `[SOCKET_SECURITY] Identity spoofing attempt: Worker ${user.id} attempted to join worker room for ${workerId}`,
          { userId: user.id, spoofedWorkerId: workerId }
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

      socket.join(getWorkerPersonalRoom(user.id));
      const response: SocketAckResponse = {
        success: true,
        message: `Joined worker room: ${getWorkerPersonalRoom(user.id)}`,
      };
      callback?.(response);
    });

    // ========================================================================
    // 3. Legacy / Client "join:customer" Handler
    // Rejects unauthorized access or attempt to join another customer's room
    // ========================================================================
    socket.on("join:customer", (customerId?: string, callback?: (res: SocketAckResponse) => void) => {
      if (user.role !== UserRole.CUSTOMER && user.role !== UserRole.ADMIN) {
        logger.warn(`[SOCKET_SECURITY] Role violation: User ${user.id} (${user.role}) attempted join:customer`, { userId: user.id, role: user.role });
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
        logger.warn(
          `[SOCKET_SECURITY] Identity spoofing attempt: Customer ${user.id} attempted to join customer room for ${customerId}`,
          { userId: user.id, spoofedCustomerId: customerId }
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

      socket.join(getCustomerPersonalRoom(user.id));
      const response: SocketAckResponse = {
        success: true,
        message: `Joined customer room: ${getCustomerPersonalRoom(user.id)}`,
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
            logger.warn(
              `[SOCKET_SECURITY] Role violation: Non-worker ${user.id} (${user.role}) attempted location update`,
              { userId: user.id, role: user.role }
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
            logger.warn(
              `[SOCKET_SECURITY] Location spoofing attempt: Authenticated worker ${user.id} sent workerId ${workerId}`,
              { userId: user.id, spoofedWorkerId: workerId }
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

          if (!customerId) {
            const response: SocketAckResponse = {
              success: false,
              code: "INVALID_REQUEST",
              message: "Missing required field: customerId",
            };
            socket.emit("error", response);
            callback?.(response);
            return;
          }

          // Enforce coordinate validation contract
          const coordValidation = validateCoordinatePair(lat, lng);
          if (!coordValidation.isValid) {
            const response: SocketAckResponse = {
              success: false,
              code: "INVALID_REQUEST",
              message: coordValidation.error || "Invalid coordinates",
            };
            socket.emit("error", response);
            callback?.(response);
            return;
          }

          const validLat = coordValidation.latitude!;
          const validLng = coordValidation.longitude!;

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
            logger.warn(
              `[SOCKET_SECURITY] Unauthorized location broadcast: Worker ${user.id} has no active booking with customer ${customerId}`,
              { userId: user.id, customerId }
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

          // Persist current location canonically to database
          try {
            await workerLocationService.updateLocation(user.id, validLat, validLng);
          } catch (locErr: any) {
            logger.warn(`[SOCKET] Failed to persist worker location for ${user.id}:`, { userId: user.id, error: locErr.message });
            const response: SocketAckResponse = {
              success: false,
              code: "INVALID_REQUEST",
              message: locErr.message || "Invalid coordinates",
            };
            socket.emit("error", response);
            callback?.(response);
            return;
          }

          // Authoritative broadcast using trusted socket.data.user.id
          io.to(getCustomerPersonalRoom(customerId)).emit("worker:location", {
            workerId: user.id,
            lat: validLat,
            lng: validLng,
          });

          callback?.({ success: true });
        } catch (err: any) {
          logger.error(`[SOCKET] Error processing worker location update:`, { userId: user.id, error: err?.message });
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
    // Enforces database-backed participant authorization using chatPolicy
    // ========================================================================
    const handleJoinBooking = async (
      payload: JoinBookingPayload,
      callback?: (res: SocketAckResponse) => void
    ) => {
      try {
        const { bookingId } = payload || {};

        if (!bookingId || typeof bookingId !== "string" || !isValidIdentifier(bookingId)) {
          const response: SocketAckResponse = {
            success: false,
            code: "INVALID_REQUEST",
            message: "Valid bookingId is required",
          };
          socket.emit("error", response);
          callback?.(response);
          return;
        }

        let booking: any = null;

        // 1. Query-level pushdown authorization
        if (prisma.booking.findFirst) {
          booking = await prisma.booking.findFirst({
            where: chatPolicy.scopeBooking(user, bookingId),
            select: { id: true, customer_id: true, worker_id: true },
          });
        }

        // 2. Mock / fallback check with explicit policy evaluation
        if (!booking && prisma.booking.findUnique) {
          const rawBooking = await prisma.booking.findUnique({
            where: { id: bookingId },
            select: { id: true, customer_id: true, worker_id: true },
          });
          if (rawBooking) {
            const decision = chatPolicy.canJoinRoom(user, rawBooking);
            if (!decision.allowed) {
              logger.warn(
                `[SOCKET_SECURITY] Unauthorized room join: User ${user.id} (${user.role}) attempted to join booking ${bookingId}`,
                { userId: user.id, role: user.role, bookingId }
              );
              const response: SocketAckResponse = {
                success: false,
                code: "FORBIDDEN",
                message: decision.reason || "Forbidden: Not an authorized participant of this booking",
              };
              socket.emit("error", response);
              callback?.(response);
              return;
            }
            booking = rawBooking;
          }
        }

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

        const roomName = getBookingChatRoom(bookingId);
        socket.join(roomName);
        callback?.({
          success: true,
          message: `Joined booking room: ${roomName}`,
        });
      } catch (err: any) {
        logger.error(`[SOCKET] Error processing join:booking:`, { userId: user.id, error: err?.message });
        callback?.({
          success: false,
          code: "INTERNAL_ERROR",
          message: "Failed to join booking room",
        });
      }
    };

    socket.on("join:booking", handleJoinBooking);
    socket.on("join:chat", handleJoinBooking);

    // ========================================================================
    // Secure "join:job" Handler (Issue 6)
    // Enforces database-backed relationship authorization using jobPolicy.scopeRead
    // ========================================================================
    socket.on("join:job", async (payload: { jobId?: string } | string, callback?: (res: SocketAckResponse) => void) => {
      try {
        const jobId = typeof payload === "string" ? payload : payload?.jobId;
        if (!jobId || typeof jobId !== "string" || !isValidIdentifier(jobId)) {
          const response: SocketAckResponse = {
            success: false,
            code: "INVALID_REQUEST",
            message: "Valid jobId is required",
          };
          socket.emit("error", response);
          callback?.(response);
          return;
        }

        let job: any = null;
        if (prisma.job?.findFirst) {
          job = await prisma.job.findFirst({
            where: jobPolicy.scopeRead(user, jobId),
            select: { id: true, customer_id: true },
          });
        }

        if (!job && prisma.job?.findUnique) {
          const rawJob = await prisma.job.findUnique({
            where: { id: jobId },
            include: {
              booking: { select: { worker_id: true } },
              job_requirement: { include: { job_dispatch: { select: { worker_id: true } } } },
            },
          });
          if (rawJob) {
            const decision = jobPolicy.canRead(user, rawJob as any);
            if (!decision.allowed) {
              logger.warn(`[SOCKET_SECURITY] Unauthorized job join attempt by user ${user.id}`, { userId: user.id, jobId });
              const response: SocketAckResponse = {
                success: false,
                code: decision.code || "FORBIDDEN",
                message: decision.reason || "Forbidden: Not authorized to access this job",
              };
              socket.emit("error", response);
              callback?.(response);
              return;
            }
            job = rawJob;
          }
        }

        if (!job) {
          const response: SocketAckResponse = {
            success: false,
            code: "RESOURCE_NOT_FOUND",
            message: "Job not found",
          };
          socket.emit("error", response);
          callback?.(response);
          return;
        }

        const roomName = getJobRoom(jobId);
        socket.join(roomName);
        callback?.({ success: true, message: `Joined job room: ${roomName}` });
      } catch (err: any) {
        logger.error(`[SOCKET] Error processing join:job:`, { userId: user.id, error: err?.message });
        callback?.({ success: false, code: "INTERNAL_ERROR", message: "Failed to join job room" });
      }
    });

    // ========================================================================
    // Secure "join:requirement" Handler (Issue 6)
    // Enforces database-backed relationship authorization using requirementPolicy.scopeRead
    // ========================================================================
    socket.on("join:requirement", async (payload: { requirementId?: string } | string, callback?: (res: SocketAckResponse) => void) => {
      try {
        const requirementId = typeof payload === "string" ? payload : payload?.requirementId;
        if (!requirementId || typeof requirementId !== "string" || !isValidIdentifier(requirementId)) {
          const response: SocketAckResponse = {
            success: false,
            code: "INVALID_REQUEST",
            message: "Valid requirementId is required",
          };
          socket.emit("error", response);
          callback?.(response);
          return;
        }

        let requirement: any = null;
        if (prisma.job_requirement?.findFirst) {
          requirement = await prisma.job_requirement.findFirst({
            where: requirementPolicy.scopeRead(user, requirementId),
            select: { id: true, job_id: true },
          });
        }

        if (!requirement && prisma.job_requirement?.findUnique) {
          const rawReq = await prisma.job_requirement.findUnique({
            where: { id: requirementId },
            include: {
              job: { select: { customer_id: true } },
              job_dispatch: { select: { worker_id: true } },
              booking: { select: { worker_id: true } },
            },
          });
          if (rawReq) {
            const decision = requirementPolicy.canRead(user, rawReq as any);
            if (!decision.allowed) {
              logger.warn(`[SOCKET_SECURITY] Unauthorized requirement join attempt by user ${user.id}`, { userId: user.id, requirementId });
              const response: SocketAckResponse = {
                success: false,
                code: decision.code || "FORBIDDEN",
                message: decision.reason || "Forbidden: Not authorized to access this requirement",
              };
              socket.emit("error", response);
              callback?.(response);
              return;
            }
            requirement = rawReq;
          }
        }

        if (!requirement) {
          const response: SocketAckResponse = {
            success: false,
            code: "RESOURCE_NOT_FOUND",
            message: "Requirement not found",
          };
          socket.emit("error", response);
          callback?.(response);
          return;
        }

        const roomName = getRequirementRoom(requirementId);
        socket.join(roomName);
        callback?.({ success: true, message: `Joined requirement room: ${roomName}` });
      } catch (err: any) {
        logger.error(`[SOCKET] Error processing join:requirement:`, { userId: user.id, error: err?.message });
        callback?.({ success: false, code: "INTERNAL_ERROR", message: "Failed to join requirement room" });
      }
    });

    // ========================================================================
    // 6. Secure "chat:message" Handler
    // Enforces participant authorization and derives sender identity from user.id
    // ========================================================================
    socket.on(
      "chat:message",
      async (payload: SendChatMessagePayload, callback?: (res: SocketAckResponse) => void) => {
        try {
          const { bookingId, content } = payload || {};

          if (
            !bookingId ||
            typeof bookingId !== "string" ||
            !isValidIdentifier(bookingId) ||
            !content ||
            typeof content !== "string" ||
            content.trim().length === 0
          ) {
            const response: SocketAckResponse = {
              success: false,
              code: "INVALID_REQUEST",
              message: "Valid bookingId and non-empty content are required",
            };
            socket.emit("error", response);
            callback?.(response);
            return;
          }

          if (content.trim().length > 2000) {
            const response: SocketAckResponse = {
              success: false,
              code: "INVALID_REQUEST",
              message: "Message content cannot exceed 2000 characters",
            };
            socket.emit("error", response);
            callback?.(response);
            return;
          }

          // Authoritative sender is ALWAYS socket.data.user.id
          const rawMessage = await chatService.sendMessage(bookingId, user.id, content.trim(), user);
          const message = toChatMessageDTO(rawMessage);

          // Broadcast to authorized canonical booking room
          io.to(getBookingChatRoom(bookingId)).emit("chat:message", message);

          callback?.({ success: true, data: message });
        } catch (err: any) {
          logger.warn(`[SOCKET] Chat message failed for user ${user.id}:`, { userId: user.id, error: err?.message });
          const isForbidden =
            err instanceof AuthorizationError
              ? err.statusCode === 403
              : err.code === "NOT_PARTICIPANT" ||
                err.message === "Unauthorized" ||
                err.message?.includes("Forbidden");

          const isNotFound =
            err instanceof AuthorizationError
              ? err.statusCode === 404
              : err.code === "RESOURCE_NOT_FOUND" ||
                err.message === "Booking not found";

          const response: SocketAckResponse = {
            success: false,
            code: isForbidden ? "FORBIDDEN" : (isNotFound ? "RESOURCE_NOT_FOUND" : (err.code || "INTERNAL_ERROR")),
            message: err.message || "Failed to send message",
          };
          socket.emit("error", response);
          callback?.(response);
        }
      }
    );

    socket.on("disconnect", () => {
      logger.info(`[SOCKET] Disconnected: ${socket.id} (user: ${user.id})`, { socketId: socket.id, userId: user.id });
    });
  });
}
