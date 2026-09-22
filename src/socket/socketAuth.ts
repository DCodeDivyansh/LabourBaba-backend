import { Socket } from "socket.io";
import prisma from "../config/prisma";
import { verifyAccessToken } from "../utils/authUtils";
import { UserRole, isValidUserRole } from "../type/userRole";
import { AuthenticatedSocket } from "./socketTypes";
import { logger } from "../utils/logger";

/**
 * Socket.IO Handshake Authentication Middleware.
 *
 * Validates the JWT access token during the connection handshake.
 * Strict Security Invariants:
 * 1. Only verified access tokens signed with JWT_ACCESS_SECRET (HS256) are accepted.
 * 2. Refresh tokens are strictly rejected.
 * 3. Principal existence and active status (deleted_at == null) are verified in PostgreSQL.
 * 4. Authenticated identity is attached to socket.data.user as the sole authoritative principal.
 * 5. Safe generic error messages are returned to prevent internal leakage.
 */
export async function socketAuthMiddleware(
  socket: Socket,
  next: (err?: Error) => void
): Promise<void> {
  try {
    // 1. Extract token from handshake auth payload or authorization header
    let token: string | undefined = socket.handshake.auth?.token;

    if (!token && socket.handshake.headers?.authorization) {
      const authHeader = socket.handshake.headers.authorization;
      if (authHeader.startsWith("Bearer ")) {
        token = authHeader.slice(7).trim();
      } else {
        token = authHeader.trim();
      }
    }

    if (!token || typeof token !== "string" || token.trim().length === 0) {
      logger.warn(`[SOCKET_AUTH] Connection rejected: Missing authentication token (socket ${socket.id})`, { socketId: socket.id });
      return next(new Error("Authentication required"));
    }

    // 2. Cryptographic verification using centralized verifyAccessToken
    // Enforces HS256 algorithm and token_type: "access"
    const decoded = verifyAccessToken(token.trim());

    if (!decoded || typeof decoded !== "object" || !decoded.id || !decoded.role) {
      logger.warn(`[SOCKET_AUTH] Connection rejected: Invalid or expired token (socket ${socket.id})`, { socketId: socket.id });
      return next(new Error("Invalid authentication credentials"));
    }

    // 3. Role claim validation
    if (!isValidUserRole(decoded.role)) {
      logger.warn(
        `[SOCKET_AUTH] Connection rejected: Unsupported role '${decoded.role}' for user ${decoded.id}`,
        { socketId: socket.id, userId: decoded.id, role: decoded.role }
      );
      return next(new Error("Invalid authentication credentials"));
    }

    // 4. Database principal validation & active status check
    if (decoded.role === UserRole.WORKER) {
      const worker = await prisma.worker.findUnique({
        where: { id: decoded.id },
        select: { id: true, phone: true, deleted_at: true, verification_status: true },
      });

      if (!worker || worker.deleted_at || worker.verification_status === "suspended") {
        logger.warn(
          `[SOCKET_AUTH] Connection rejected: Worker account ${decoded.id} not found, inactive, or suspended`,
          { socketId: socket.id, userId: decoded.id }
        );
        return next(new Error("Invalid authentication credentials"));
      }

      (socket as AuthenticatedSocket).data.user = {
        id: worker.id,
        role: UserRole.WORKER,
        phone: worker.phone,
      };
    } else if (decoded.role === UserRole.CUSTOMER) {
      const customer = await prisma.customer.findUnique({
        where: { id: decoded.id },
        select: { id: true, phone: true, deleted_at: true },
      });

      if (!customer || customer.deleted_at) {
        logger.warn(
          `[SOCKET_AUTH] Connection rejected: Customer account ${decoded.id} not found or inactive`,
          { socketId: socket.id, userId: decoded.id }
        );
        return next(new Error("Invalid authentication credentials"));
      }

      (socket as AuthenticatedSocket).data.user = {
        id: customer.id,
        role: UserRole.CUSTOMER,
        phone: customer.phone,
      };
    } else if (decoded.role === UserRole.ADMIN) {
      (socket as AuthenticatedSocket).data.user = {
        id: decoded.id,
        role: UserRole.ADMIN,
        phone: decoded.phone,
      };
    } else {
      return next(new Error("Invalid authentication credentials"));
    }

    // Handshake passed: socket is authenticated
    next();
  } catch (err: any) {
    logger.error(`[SOCKET_AUTH] Unexpected error during socket authentication:`, { socketId: socket.id, error: err?.message });
    next(new Error("Invalid authentication credentials"));
  }
}
