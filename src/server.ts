import express, { Request, Response } from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";

import workerRoutes from "./features/worker/workerRoutes";
import clientRoute from "./features/auth/customerRoutes";
import skillRoute from "./features/skill/skillRouter";
import jobRoutes from "./features/jobs/jobRoutes";
import authRoutes from "./features/auth/auth.routes";
import dispatchRoutes from "./features/dispatch/dispatchRoutes";
import bookingRoutes from "./features/booking/bookingRoutes";
import paymentRoutes from "./features/payment/paymentRoutes";
import reviewRoutes from "./features/review/reviewRoutes";
import chatRoutes from "./features/chat/chatRoutes";
import adminRoutes from "./features/admin/adminRoutes";
import workerLocationRoute from "./features/worker_location/worker_location.routes";
import healthRoutes from "./features/health/healthRoutes";

import { setupSwagger } from "./config/swagger";
import { requestLogger } from "./middlewares/requestLogger";
import { errorHandler } from "./middlewares/errorHandler";
import { lifecycleManager } from "./lifecycle/lifecycleManager";
import { logger } from "./utils/logger";

dotenv.config();

const app = express();
const httpServer = createServer(app);

const port = process.env.PORT || 5000;

/**
 * Allowed Origins
 */
const allowedOrigins = [
  process.env.FRONT_END_URL,
  process.env.APP_URL,
  "https://labourbaba.in",
  "https://labourbaba.com",
  "https://www.labourbaba.in",
  "https://www.labourbaba.com"
].filter(Boolean);

/**
 * Express CORS
 */
app.use(
  cors({
    origin(origin, callback) {
      // Allow server-to-server and Postman requests
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-ID", "X-Correlation-ID"],
  })
);

// Extend Express Request to carry rawBody buffer for webhook signature verification
declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

app.use(express.json({
  verify: (req: any, _res, buf) => {
    req.rawBody = buf;
  },
}));

// Canonical structured request logging (Issue #39)
app.use(requestLogger);

/**
 * Socket.IO
 */
const io = new Server(httpServer, {
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
});

io.engine.on("connection_error", (err) => {
  logger.warn("[SOCKET_ENGINE_ERROR]", { code: err.code, message: err.message, context: err.context });
});

import { socketAuthMiddleware } from "./socket/socketAuth";
import { registerSocketHandlers } from "./socket/socketHandlers";

// Authenticate handshake using JWT access token & database principal resolution
io.use(socketAuthMiddleware);

// Register authoritative, role-guarded socket event handlers
registerSocketHandlers(io);

// Register servers with lifecycle manager
lifecycleManager.registerServers(httpServer, io);

/**
 * Routes
 */
app.use("/health", healthRoutes);
app.use("/api/clients", clientRoute);
app.use("/api/workers", workerRoutes);
app.use("/api/skill", skillRoute);
app.use("/api/worker_location", workerLocationRoute);
app.use("/api/jobs", jobRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/dispatch", dispatchRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/admin", adminRoutes);

setupSwagger(app);

/**
 * 404 handler - must come after all routes
 */
app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: {
      code: "RESOURCE_NOT_FOUND",
      message: "The requested endpoint was not found.",
      request_id: req.id,
    },
  });
});

/**
 * Global Safe Error Handler (Issue #40)
 */
app.use(errorHandler);

// Issue #22: import notification worker so BullMQ consumer starts on bootstrap
import "./workers/notificationWorker";

async function startServer() {
  try {
    // Execute authoritative, validated startup sequence (Issue #38)
    await lifecycleManager.startup();

    httpServer.listen(port, () => {
      logger.info(`Server running on port ${port}`);
      logger.info("Allowed Origins initialized", { allowedOrigins });
    });
  } catch (err: any) {
    logger.error("[STARTUP ERROR]", { error: err.message || err });
    await lifecycleManager.shutdown("STARTUP_ERROR", true);
  }
}

if (process.env.NODE_ENV !== "test") {
  startServer();
}

// Graceful signal handlers
process.on("SIGTERM", () => lifecycleManager.shutdown("SIGTERM", true));
process.on("SIGINT", () => lifecycleManager.shutdown("SIGINT", true));

export { app, io, httpServer };
