import { Socket, Server } from "socket.io";
import { UserRole } from "../type/userRole";

/**
 * Authoritative principal representation attached to socket.data.user
 * after cryptographic verification of JWT access token during handshake.
 */
export interface SocketUserData {
  id: string;
  role: UserRole;
  phone?: string;
}

/**
 * Strongly typed Socket instance carrying authenticated user identity.
 */
export interface AuthenticatedSocket extends Socket {
  data: {
    user: SocketUserData;
  };
}

/**
 * Strongly typed Server instance.
 */
export type AuthenticatedServer = Server;

/**
 * Client payload for worker real-time location updates.
 * Note: Authoritative worker identity is always derived from socket.data.user.id.
 * Any client-supplied workerId is strictly validated to match socket.data.user.id.
 */
export interface WorkerLocationPayload {
  customerId: string;
  lat: number;
  lng: number;
  workerId?: string;
}

/**
 * Client payload for joining booking or chat rooms.
 */
export interface JoinBookingPayload {
  bookingId: string;
}

/**
 * Client payload for sending real-time chat messages via Socket.IO.
 */
export interface SendChatMessagePayload {
  bookingId: string;
  content: string;
}

/**
 * Standardized socket operation acknowledgment response.
 */
export interface SocketAckResponse<T = any> {
  success: boolean;
  message?: string;
  code?: string;
  data?: T;
}
