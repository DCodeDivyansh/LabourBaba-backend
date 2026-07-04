import express, { Request, Response } from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import prisma from './config/prisma';
import workerRoutes from './routes/workerRoutes';
import clientRoute from './routes/customerRoutes';
import skillRoute from './routes/skillRouter';
import jobRoutes from './routes/jobRoutes';
import authRoutes from './routes/authRoutes';
import dispatchRoutes from './routes/dispatchRoutes';
import bookingRoutes from './routes/bookingRoutes';
import paymentRoutes from './routes/paymentRoutes';
import reviewRoutes from './routes/reviewRoutes';
import chatRoutes from './routes/chatRoutes';
import adminRoutes from './routes/adminRoutes';
import { setupSwagger } from './config/swagger';
import workerLocationRoute from './routes/worker_location.routes';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { dispatchQueue, timeoutQueue } from './config/bullmq';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const port = process.env.PORT || 5000;

// ── Socket.IO ────────────────────────────────────────────────────────────────

export const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONT_END_URL || process.env.APP_URL,
    methods: ['GET', 'POST'],
  },
});

io.on('connection', (socket) => {
  console.log(`[socket.io] Client connected: ${socket.id}`);

  // Workers join their personal room so dispatch events reach them
  socket.on('join:worker', (workerId: string) => {
    socket.join(`worker:${workerId}`);
    console.log(`[socket.io] Worker ${workerId} joined room worker:${workerId}`);
  });

  // Customers join their personal room for booking updates
  socket.on('join:customer', (customerId: string) => {
    socket.join(`customer:${customerId}`);
    console.log(`[socket.io] Customer ${customerId} joined room customer:${customerId}`);
  });

  socket.on('worker:location_update', async ({ workerId, lat, lng }) => {
    // Write to Redis (fast cache)
    // Then find active booking for this worker
    // Emit to customer watching that booking
    io.to(`customer:CUSTOMER_ID`).emit('worker:location', { lat, lng });
  });

  // ── Chat messages ───────────────────────────────────
  // socket.on('chat:message', async ({ bookingId, content, senderId, role }) => {
  //   // Save to DB
  //   // Emit to other party
  //   const target = role === 'worker'
  //     ? `customer:${CUSTOMER_ID}`
  //     : `worker:${WORKER_ID}`;
  //   io.to(target).emit('chat:message', { content, senderId, sentAt: new Date() });
  // });

  socket.on('disconnect', () => {
    console.log(`[socket.io] Client disconnected: ${socket.id}`);
  });
});

// ── Middlewares ───────────────────────────────────────────────────────────────

app.use(cors({ origin: [String(process.env.FRONT_END_URL), String(process.env.APP_URL)] }));
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// ── Routes ────────────────────────────────────────────────────────────────────

app.use('/api/clients', clientRoute);
app.use('/api/workers', workerRoutes);
app.use('/api/skill', skillRoute);
app.use('/api/worker_location', workerLocationRoute);
app.use('/api/jobs', jobRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/dispatch', dispatchRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/admin', adminRoutes);

// Setup Swagger UI
setupSwagger(app);

// Setup Bull Board Dashboard
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');
createBullBoard({
  queues: [
    new BullMQAdapter(dispatchQueue),
    new BullMQAdapter(timeoutQueue),
  ],
  serverAdapter,
});
app.use('/admin/queues', serverAdapter.getRouter());

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'OK', timestamp: new Date() });
});

// ── Database connection test and startup ─────────────────────────────────────

async function startServer() {
  try {
    // console.log("Socket.IO server version:", require("socket.io/package.json").version);
    console.log('Connecting to Supabase PostgreSQL database...');
    try {
      await prisma.$connect();
      console.log('Database connection established successfully via Prisma Client.');
    } catch (e) {
      console.log('there is error in the connecting the db', e);
    }
    // start the sockert server
    httpServer.listen(port, () => {
      console.log(`Server running on http://localhost:${port}`);
    });
  } catch (error) {
    console.error('Failed to connect to the database:', error);
    await prisma.$disconnect();
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== 'test') {
  startServer();
}

// ── BullMQ Workers (started as side-effect imports) ──────────────────────────
// These must be imported AFTER `io` is defined so workers can import it
import './workers/dispatchWorker';
import './workers/timeoutWorker';

export { app };
