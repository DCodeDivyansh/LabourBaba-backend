/**
 * socketLifecycle.ts
 *
 * Issue #11 — Revoke Sessions on Suspension/Deletion
 *
 * Manages runtime Socket.IO server reference and provides authoritative
 * connection invalidation primitives for account suspension and session revocation.
 */

import { Server } from "socket.io";
import { UserRole } from "../type/userRole";
import {
  getWorkerPersonalRoom,
  getCustomerPersonalRoom,
  getAdminPersonalRoom,
} from "./roomHelpers";

import { logger } from "../utils/logger";

let socketServerInstance: Server | null = null;

/**
 * Registers the active Socket.IO Server instance on application startup.
 */
export function setSocketServer(io: Server): void {
  socketServerInstance = io;
}

/**
 * Retrieves the registered Socket.IO Server instance, if available.
 */
export function getSocketServer(): Server | null {
  return socketServerInstance;
}

/**
 * Authoritatively disconnects all active sockets for a specific user across
 * all their connected devices. Called immediately upon account suspension or deletion.
 *
 * @param userId The UUID of the worker or customer
 * @param role The UserRole of the principal
 */
export function disconnectUserSockets(userId: string, role: UserRole): void {
  if (!socketServerInstance) {
    return;
  }

  try {
    let room: string;
    if (role === UserRole.WORKER) {
      room = getWorkerPersonalRoom(userId);
    } else if (role === UserRole.CUSTOMER) {
      room = getCustomerPersonalRoom(userId);
    } else if (role === UserRole.ADMIN) {
      room = getAdminPersonalRoom(userId);
    } else {
      return;
    }

    // Force disconnect all sockets currently in the user's personal room
    socketServerInstance.in(room).disconnectSockets(true);
    logger.info(`[SOCKET_SECURITY] Disconnected all active sockets in room '${room}' for user ${userId}`, { userId, room, role });
  } catch (err: any) {
    logger.error(`[SOCKET_SECURITY] Failed to disconnect sockets for user ${userId}:`, { userId, error: err?.message });
  }
}
