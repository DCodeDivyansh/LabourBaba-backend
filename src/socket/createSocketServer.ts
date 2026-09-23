/**
 * createSocketServer.ts
 *
 * LabourBaba Backend — Authoritative Socket.IO Server Factory
 *
 * Constructs, configures, and secures a Socket.IO server instance attached to an HTTP server.
 * Ensures identical CORS policy, transport policy, authentication middleware, and event handlers
 * across both the production entrypoint and multi-instance test harnesses.
 */

import { Server as HttpServer } from "http";
import { Server as SocketIOServer, ServerOptions } from "socket.io";
import { socketAuthMiddleware } from "./socketAuth";
import { registerSocketHandlers } from "./socketHandlers";
import { logger } from "../utils/logger";

export interface CreateSocketServerOptions {
  allowedOrigins?: string[];
  transports?: string[];
  serverOptions?: Partial<ServerOptions>;
}

export function createSocketServer(
  httpServer: HttpServer,
  options?: CreateSocketServerOptions
): SocketIOServer {
  const allowedOrigins = options?.allowedOrigins || [
    "http://localhost:3000",
    "http://localhost:5173",
    process.env.FRONTEND_URL,
    process.env.ADMIN_PORTAL_URL,
  ].filter(Boolean) as string[];

  const io = new SocketIOServer(httpServer, {
    transports: (options?.transports as any) || ["websocket", "polling"],
    cors: {
      origin(origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) {
          return callback(null, true);
        }
        return callback(new Error(`Origin ${origin} not allowed by CORS`));
      },
      credentials: true,
      methods: ["GET", "POST"],
    },
    ...options?.serverOptions,
  });

  io.engine.on("connection_error", (err) => {
    logger.warn("[SOCKET_ENGINE_ERROR]", { code: err.code, message: err.message, context: err.context });
  });

  // 1. Handshake Authentication (JWT access token & principal validation)
  io.use(socketAuthMiddleware);

  // 2. Authoritative, role-guarded event & room handlers
  registerSocketHandlers(io);

  return io;
}
