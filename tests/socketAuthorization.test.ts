import http from "http";
import { Server as SocketIOServer } from "socket.io";
import { io as Client, Socket as ClientSocket } from "socket.io-client";
import { socketAuthMiddleware } from "../src/socket/socketAuth";
import { registerSocketHandlers } from "../src/socket/socketHandlers";
import { UserRole } from "../src/middlewares/authMiddleware";
import { generateToken } from "../src/utils/authUtils";

// Mock Bull Board to prevent any background tasks
jest.mock("@bull-board/api", () => ({ createBullBoard: jest.fn().mockReturnValue({}) }));
jest.mock("@bull-board/api/bullMQAdapter", () => ({ BullMQAdapter: jest.fn().mockImplementation(() => ({})) }));
jest.mock("@bull-board/express", () => ({
  ExpressAdapter: jest.fn().mockImplementation(() => ({
    setBasePath: jest.fn(),
    getRouter: jest.fn().mockReturnValue((req: any, res: any, next: any) => next()),
  })),
}));
jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({ add: jest.fn().mockResolvedValue({}) })),
  Worker: jest.fn().mockImplementation(() => ({ on: jest.fn(), close: jest.fn() })),
}));
jest.mock("../src/config/bullmq", () => ({
  dispatchQueue: { add: jest.fn() },
  timeoutQueue: { add: jest.fn() },
  connection: {},
}));
jest.mock("../src/features/dispatch/simpleDispatch", () => ({ dispatchJobSimple: jest.fn() }));

// Mock Prisma
jest.mock("../src/config/prisma", () => ({
  __esModule: true,
  default: {
    customer: {
      findUnique: jest.fn(),
    },
    worker: {
      findUnique: jest.fn(),
    },
    booking: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
    conversation: {
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    message: {
      create: jest.fn(),
    },
  },
}));

import prisma from "../src/config/prisma";

describe("Socket.IO Authorization & Policy Layer Enforcement", () => {
  const CUSTOMER_A_ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const CUSTOMER_B_ID = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
  const WORKER_A_ID = "11111111-1111-4111-a111-111111111111";
  const WORKER_B_ID = "22222222-2222-4222-a222-222222222222";
  const BOOKING_ID = "aaaa2222-aaaa-4aaa-aaaa-aaaaaaaaaaaa";

  let httpServer: http.Server;
  let ioServer: SocketIOServer;
  let serverPort: number;

  let customerAToken: string;
  let customerBToken: string;
  let workerAToken: string;
  let workerBToken: string;

  beforeAll((done) => {
    customerAToken = generateToken({ id: CUSTOMER_A_ID, phone: "+919876543210", role: UserRole.CUSTOMER });
    customerBToken = generateToken({ id: CUSTOMER_B_ID, phone: "+919876543219", role: UserRole.CUSTOMER });
    workerAToken = generateToken({ id: WORKER_A_ID, phone: "+919876543211", role: UserRole.WORKER });
    workerBToken = generateToken({ id: WORKER_B_ID, phone: "+919876543212", role: UserRole.WORKER });

    httpServer = http.createServer();
    ioServer = new SocketIOServer(httpServer);
    ioServer.use(socketAuthMiddleware);
    registerSocketHandlers(ioServer);

    httpServer.listen(0, () => {
      serverPort = (httpServer.address() as any).port;
      done();
    });
  });

  afterAll((done) => {
    ioServer.close();
    httpServer.close(done);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.customer.findUnique as jest.Mock).mockImplementation(({ where }) => {
      if (where.id === CUSTOMER_A_ID || where.id === CUSTOMER_B_ID) {
        return Promise.resolve({ id: where.id, deleted_at: null });
      }
      return Promise.resolve(null);
    });
    (prisma.worker.findUnique as jest.Mock).mockImplementation(({ where }) => {
      if (where.id === WORKER_A_ID || where.id === WORKER_B_ID) {
        return Promise.resolve({ id: where.id, deleted_at: null });
      }
      return Promise.resolve(null);
    });
  });

  // Helper to connect a client
  function connectClient(token?: string): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const client = Client(`http://localhost:${serverPort}`, {
        auth: token ? { token } : undefined,
        transports: ["websocket"],
        reconnection: false,
      });
      client.on("connect", () => resolve(client));
      client.on("connect_error", (err) => reject(err));
    });
  }

  describe("1. Connection Handshake Authentication", () => {
    it("Rejects connection without authentication token", async () => {
      await expect(connectClient()).rejects.toThrow(/Authentication required/i);
    });

    it("Rejects connection with invalid token", async () => {
      await expect(connectClient("invalid.jwt.token")).rejects.toThrow(/Invalid authentication credentials/i);
    });

    it("Allows connection with valid customer token", async () => {
      const client = await connectClient(customerAToken);
      expect(client.connected).toBe(true);
      client.disconnect();
    });

    it("Allows connection with valid worker token", async () => {
      const client = await connectClient(workerAToken);
      expect(client.connected).toBe(true);
      client.disconnect();
    });
  });

  describe("2. Personal Room Isolation", () => {
    it("Customer A cannot join Customer B's personal room", async () => {
      const client = await connectClient(customerAToken);
      const res: any = await new Promise((resolve) => {
        client.emit("join:customer", CUSTOMER_B_ID, (ack: any) => resolve(ack));
      });
      expect(res.success).toBe(false);
      expect(res.code).toBe("FORBIDDEN");
      client.disconnect();
    });

    it("Worker A cannot join Worker B's personal room", async () => {
      const client = await connectClient(workerAToken);
      const res: any = await new Promise((resolve) => {
        client.emit("join:worker", WORKER_B_ID, (ack: any) => resolve(ack));
      });
      expect(res.success).toBe(false);
      expect(res.code).toBe("FORBIDDEN");
      client.disconnect();
    });
  });

  describe("3. join:booking Room Authorization", () => {
    it("Customer A CAN join booking room they own", async () => {
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        id: BOOKING_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
      });

      const client = await connectClient(customerAToken);
      const res: any = await new Promise((resolve) => {
        client.emit("join:booking", { bookingId: BOOKING_ID }, (ack: any) => resolve(ack));
      });

      expect(res.success).toBe(true);
      client.disconnect();
    });

    it("Worker A CAN join booking room they are assigned to", async () => {
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        id: BOOKING_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
      });

      const client = await connectClient(workerAToken);
      const res: any = await new Promise((resolve) => {
        client.emit("join:booking", { bookingId: BOOKING_ID }, (ack: any) => resolve(ack));
      });

      expect(res.success).toBe(true);
      client.disconnect();
    });

    it("Customer B CANNOT join Customer A's booking room (rejected with FORBIDDEN)", async () => {
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        id: BOOKING_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
      });

      const client = await connectClient(customerBToken);
      const res: any = await new Promise((resolve) => {
        client.emit("join:booking", { bookingId: BOOKING_ID }, (ack: any) => resolve(ack));
      });

      expect(res.success).toBe(false);
      expect(["FORBIDDEN", "NOT_PARTICIPANT"]).toContain(res.code);
      client.disconnect();
    });

    it("Worker B CANNOT join booking room assigned to Worker A (rejected with FORBIDDEN)", async () => {
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        id: BOOKING_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
      });

      const client = await connectClient(workerBToken);
      const res: any = await new Promise((resolve) => {
        client.emit("join:booking", { bookingId: BOOKING_ID }, (ack: any) => resolve(ack));
      });

      expect(res.success).toBe(false);
      expect(["FORBIDDEN", "NOT_PARTICIPANT"]).toContain(res.code);
      client.disconnect();
    });
  });

  describe("4. chat:message Authorization", () => {
    it("Customer A CAN send chat message to own booking", async () => {
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        id: BOOKING_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
        status: "CONFIRMED",
      });
      (prisma.conversation.findFirst as jest.Mock).mockResolvedValue({
        id: "conv-1",
        booking_id: BOOKING_ID,
      });
      (prisma.message.create as jest.Mock).mockResolvedValue({
        id: "msg-101",
        conversation_id: "conv-1",
        content: "Hello Worker A",
        sender_id: CUSTOMER_A_ID,
      });

      const client = await connectClient(customerAToken);
      const res: any = await new Promise((resolve) => {
        client.emit("chat:message", { bookingId: BOOKING_ID, content: "Hello Worker A" }, (ack: any) => resolve(ack));
      });

      expect(res.success).toBe(true);
      expect(res.data.id).toBe("msg-101");
      client.disconnect();
    });

    it("Customer B CANNOT send chat message to Customer A's booking (rejected)", async () => {
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        id: BOOKING_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
        status: "CONFIRMED",
      });

      const client = await connectClient(customerBToken);
      const res: any = await new Promise((resolve) => {
        client.emit("chat:message", { bookingId: BOOKING_ID, content: "Intruder message" }, (ack: any) => resolve(ack));
      });

      expect(res.success).toBe(false);
      client.disconnect();
    });

    it("Worker B CANNOT send chat message to Worker A's booking (rejected)", async () => {
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        id: BOOKING_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
        status: "CONFIRMED",
      });

      const client = await connectClient(workerBToken);
      const res: any = await new Promise((resolve) => {
        client.emit("chat:message", { bookingId: BOOKING_ID, content: "Intruder worker message" }, (ack: any) => resolve(ack));
      });

      expect(res.success).toBe(false);
      client.disconnect();
    });
  });

  describe("5. worker:location_update Authorization & Spoofing", () => {
    it("Customer CANNOT emit worker:location_update (rejected with FORBIDDEN)", async () => {
      const client = await connectClient(customerAToken);
      const res: any = await new Promise((resolve) => {
        client.emit("worker:location_update", { customerId: CUSTOMER_A_ID, lat: 28.0, lng: 77.0 }, (ack: any) => resolve(ack));
      });

      expect(res.success).toBe(false);
      expect(res.code).toBe("FORBIDDEN");
      client.disconnect();
    });

    it("Worker cannot spoof workerId in worker:location_update payload", async () => {
      const client = await connectClient(workerAToken);
      const res: any = await new Promise((resolve) => {
        client.emit(
          "worker:location_update",
          { customerId: CUSTOMER_A_ID, lat: 28.0, lng: 77.0, workerId: WORKER_B_ID },
          (ack: any) => resolve(ack)
        );
      });

      expect(res.success).toBe(false);
      expect(res.code).toBe("FORBIDDEN");
      client.disconnect();
    });
  });
});
