import express, { Request, Response } from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import helmet from "helmet";
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
import storageRoutes from "./providers/storage/storage.routes";

import { setupSwagger } from "./config/swagger";
import { requestLogger } from "./middlewares/requestLogger";
import { requestTimeout } from "./middlewares/requestTimeout";
import { errorHandler } from "./middlewares/errorHandler";
import { lifecycleManager } from "./lifecycle/lifecycleManager";
import { logger } from "./utils/logger";

dotenv.config();

const app = express();
const httpServer = createServer(app);

const port = process.env.PORT || 5000;

// 1. Explicit Trusted Proxy Configuration (Issue #43)
const trustProxyConfig = process.env.TRUST_PROXY || (process.env.NODE_ENV === "production" ? 1 : false);
app.set("trust proxy", trustProxyConfig);

// 2. Helmet Security Headers (Issue #43)
app.use(
  helmet({
    contentSecurityPolicy: process.env.NODE_ENV === "production" ? undefined : false,
    crossOriginEmbedderPolicy: false,
  })
);

/**
 * Allowed Origins (Issue #43)
 */
const allowedOrigins = [
  process.env.FRONT_END_URL,
  process.env.APP_URL,
  "https://labourbaba.in",
  "https://labourbaba.com",
  "https://www.labourbaba.in",
  "https://www.labourbaba.com"
].filter(Boolean) as string[];

/**
 * Express CORS (Issue #43)
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
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-ID", "X-Correlation-ID", "X-Device-ID"],
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

// 3. Request Logging & Correlation Context (Issue #41)
app.use(requestLogger);

// 4. Bounded Request Timeout (Issue #43)
app.use(requestTimeout({ timeoutMs: process.env.NODE_ENV === "test" ? 10000 : 30000 }));

// 5. Explicit Body Limit Parsers (1MB limit with rawBody preservation for webhooks) (Issue #43)
app.use(
  express.json({
    limit: "1mb",
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(
  express.urlencoded({
    extended: true,
    limit: "1mb",
  })
);

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
if (lifecycleManager && typeof lifecycleManager.registerServers === 'function') {
  lifecycleManager.registerServers(httpServer, io);
}

import { metricsService } from "./metrics/metrics.service";

/**
 * Routes
 */
app.get("/metrics", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.send(metricsService.formatPrometheus());
});

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
app.use("/api/storage", storageRoutes);

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

// Issue #22 & #44: Background notification and outbox workers
import "./workers/notificationWorker";
import "./workers/outboxWorker";

async function startServer() {
  try {
    // Execute authoritative, validated startup sequence (Issue #38 & #45)
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
