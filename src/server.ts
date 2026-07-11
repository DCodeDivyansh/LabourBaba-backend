import express, { Request, Response } from "express";
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
  "https://www.labourbaba.in",
  "https://www.labourbaba.com",
  "https://labour-baba-website.vercel.app",
  "https://labourbaba-website-production.up.railway.app",
  "https://labour-baba-website-divyanshyadav87s-projects.vercel.app",
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
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.options("/{*any}", cors());

app.use(express.json());
app.use(morgan("dev"));

/**
 * Socket.IO
 */
export const io = new Server(httpServer, {
  cors: {
    origin(origin, callback) {
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error(`Socket Origin ${origin} not allowed`));
    },
    credentials: true,
    methods: ["GET", "POST"],
  },

  transports: ["websocket", "polling"],
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
      lat,
      lng,
    }: {
      workerId: string;
      lat: number;
      lng: number;
    }) => {
      io.to(`customer:CUSTOMER_ID`).emit("worker:location", {
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

export { app };