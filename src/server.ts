import express, { Request, Response, NextFunction } from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import morgan from "morgan";
import dotenv from "dotenv";

import prisma from "./config/prisma";

import workerRoutes from "./routes/workerRoutes";
import clientRoute from "./routes/customerRoutes";
import skillRoute from "./routes/skillRouter";
import jobRoutes from "./routes/jobRoutes";
import authRoutes from "./routes/authRoutes";
import dispatchRoutes from "./routes/dispatchRoutes";
import bookingRoutes from "./routes/bookingRoutes";
import paymentRoutes from "./routes/paymentRoutes";
import reviewRoutes from "./routes/reviewRoutes";
import chatRoutes from "./routes/chatRoutes";
import adminRoutes from "./routes/adminRoutes";
import workerLocationRoute from "./routes/worker_location.routes";

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

app.use(express.json());
app.use(morgan("dev"));

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

io.on("connection", (socket) => {
  console.log(`Socket Connected: ${socket.id}`);

  socket.on("join:worker", (workerId: string) => {
    socket.join(`worker:${workerId}`);
    console.log(`Worker ${workerId} joined room`);
  });

  socket.on("join:customer", (customerId: string) => {
    socket.join(`customer:${customerId}`);
    console.log(`Customer ${customerId} joined room`);
  });

  socket.on(
    "worker:location_update",
    async ({
      workerId,
      customerId,
      lat,
      lng,
    }: {
      workerId: string;
      customerId: string;
      lat: number;
      lng: number;
    }) => {
      // BUG FIX: this previously emitted to the literal room name
      // "customer:CUSTOMER_ID" (a hardcoded string, not a variable),
      // so the location update never reached any real customer.
      // The worker app now needs to send `customerId` in this event's
      // payload (the active job's customer) so we can target the
      // correct room.
      if (!customerId) {
        console.warn(
          `worker:location_update from worker ${workerId} missing customerId; dropping event`
        );
        return;
      }

      io.to(`customer:${customerId}`).emit("worker:location", {
        workerId,
        lat,
        lng,
      });
    }
  );

  socket.on("disconnect", () => {
    console.log(`Socket Disconnected: ${socket.id}`);
  });
});

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

async function startServer() {
  try {
    await prisma.$connect();

    console.log("Database Connected");

    httpServer.listen(port, () => {
      console.log(`Server running on port ${port}`);
      console.log("Allowed Origins:");
      console.table(allowedOrigins);
    });
  } catch (err) {
    console.error(err);
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

export { app, io };