import express, { Request, Response, NextFunction } from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import logs from "./middlewares/morgan";
import dotenv from "dotenv";

import prisma from "./config/prisma";

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

import { setupSwagger } from "./config/swagger";

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
 *
 * NOTE: previously there was a second `app.use(cors({ origin: true, credentials: true }))`
 * registered right after this one. That second call reflected ANY origin back with
 * credentials allowed, which completely defeated the allow-list below (any site could
 * make credentialed requests to the API). It has been removed - this is the only
 * CORS middleware now, and it enforces allowedOrigins.
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
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);


// Extend Express Request to carry the raw body buffer for webhook signature verification.
// This is set by the express.json verify callback below.
declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

// these are the middlewares that are used in the app, they are used to parse the request body and log the requests.
// The `verify` callback captures the exact raw bytes before JSON parsing — required for
// Razorpay webhook HMAC-SHA256 verification (see paymentRoutes.ts and paymentServices.ts).
app.use(express.json({
  verify: (req: any, _res, buf) => {
    req.rawBody = buf;
  },
}));
app.use(logs());


app.use((req, res, next) => {
  if (req.url.startsWith("/socket.io")) {
    console.log("==== SOCKET REQUEST ====");
    console.log(req.method);
    console.log(req.url);
    console.log(req.headers.origin);
  }
  next();
});

/**
 * Socket.IO
 */
const io = new Server(httpServer, {
  cors: {
    origin(origin, callback) {
      // Same allow-list as the Express CORS config above, so sockets get
      // the same protection as regular HTTP requests. `!origin` covers
      // native mobile clients (React Native worker app) which typically
      // don't send an Origin header at all.
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
  console.log("========== ENGINE ERROR ==========");
  console.log(err.code);
  console.log(err.message);
  console.log(err.context);
});

import { socketAuthMiddleware } from "./socket/socketAuth";
import { registerSocketHandlers } from "./socket/socketHandlers";

// Authenticate handshake using JWT access token & database principal resolution
io.use(socketAuthMiddleware);

// Register authoritative, role-guarded socket event handlers
registerSocketHandlers(io);

/**
 * Routes
 */

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

app.get("/health", (req: Request, res: Response) => {
  res.json({
    status: "OK",
    timestamp: new Date(),
  });
});

/**
 * 404 handler - must come after all routes
 */
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

/**
 * Global error handler - must be registered last, with 4 args,
 * so Express recognizes it as an error-handling middleware.
 * Previously there was no error handler at all, so any thrown/rejected
 * error in a route fell through to Express's default handler
 * (inconsistent responses, possible stack trace leakage).
 */
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error(err);

  if (err.message?.startsWith("Origin ") && err.message?.endsWith("not allowed by CORS")) {
    return res.status(403).json({ error: "Origin not allowed" });
  }

  res.status(500).json({
    error: "Internal server error",
    ...(process.env.NODE_ENV !== "production" && { detail: err.message }),
  });
});

import { assertJwtConfig, assertProductionAuthConfig } from "./config/authConfig";
import { assertProductionPaymentConfig } from "./config/paymentConfig";
import { assertBullMQConfig } from "./config/bullmq";
import { reconcileDispatchState } from "./features/dispatch/dispatchReconciliationService";
import { authService } from "./features/auth/auth.services";
// Issue #22: import notification worker so BullMQ consumer starts on bootstrap
// (the module's top-level guard `if (NODE_ENV !== 'test')` calls getNotificationWorker())
import "./workers/notificationWorker";


// Periodic hygiene cleanup for expired OTP challenges (runs daily, unref'd)
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const otpCleanupTimer = setInterval(async () => {
  try {
    await authService.cleanupExpiredOtpChallenges();
  } catch (err: any) {
    console.error("[AUTH_CLEANUP_ERROR] Periodic OTP cleanup failed:", err.message);
  }
}, CLEANUP_INTERVAL_MS);
otpCleanupTimer.unref();

async function startServer() {
  try {
    // 1. Fail-fast configuration gatekeepers (JWT security, payments, & BullMQ/Redis checks)
    assertJwtConfig();
    assertProductionAuthConfig();
    assertProductionPaymentConfig();
    assertBullMQConfig();

    await prisma.$connect();

    console.log("Database Connected");

    // 2. Authoritative startup reconciliation: reconstruct missing BullMQ jobs for orphaned states
    try {
      await reconcileDispatchState();
    } catch (err: any) {
      console.error("[DISPATCH_RECONCILIATION_ERROR] Startup reconciliation failed:", err.message);
      if (process.env.NODE_ENV === "production") {
        throw err;
      }
    }

    // Run initial startup hygiene cleanup
    authService.cleanupExpiredOtpChallenges().catch((err) => {
      console.warn("[AUTH_CLEANUP_WARN] Initial OTP cleanup skipped on startup:", err.message);
    });

    httpServer.listen(port, () => {
      console.log(`Server running on port ${port}`);
      console.log("Allowed Origins:");
      console.table(allowedOrigins);
    });
  } catch (err: any) {
    console.error("[STARTUP ERROR]", err.message || err);
    await prisma.$disconnect();
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== "test") {
  startServer();
}

process.on("SIGTERM", async () => {
  console.log("SIGTERM received, shutting down gracefully");
  await prisma.$disconnect();
  httpServer.close(() => process.exit(0));
});

export { app, io, httpServer };
