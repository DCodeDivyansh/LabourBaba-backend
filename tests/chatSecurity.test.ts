import request from "supertest";
import { app, httpServer, io } from "../src/server";
import { io as Client, Socket as ClientSocket } from "socket.io-client";
import { generateToken, signAccessToken } from "../src/utils/authUtils";
import { UserRole } from "../src/type/userRole";
import prisma from "../src/config/prisma";
import { chatService } from "../src/features/chat/chatServices";
import { AuthorizationError } from "../src/policies";
import { getBookingChatRoom } from "../src/socket/roomHelpers";

// Mock BullMQ queues
jest.mock("../src/config/bullmq", () => ({
  dispatchQueue: { add: jest.fn().mockResolvedValue({}) },
  timeoutQueue: { add: jest.fn().mockResolvedValue({}) },
  connection: {},
}));

jest.mock("../src/features/dispatch/simpleDispatch", () => ({
  dispatchJobSimple: jest.fn().mockResolvedValue({}),
}));

// Mock Prisma
jest.mock("../src/config/prisma", () => ({
  __esModule: true,
  default: {
    booking: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    conversation: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    message: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
    worker: {
      findUnique: jest.fn(),
    },
    customer: {
      findUnique: jest.fn(),
    },
    $connect: jest.fn().mockResolvedValue(undefined),
    $disconnect: jest.fn().mockResolvedValue(undefined),
  },
}));

// Identifiers
const CUSTOMER_A_ID = "11111111-1111-4111-a111-111111111111";
const CUSTOMER_B_ID = "22222222-2222-4222-a222-222222222222";
const WORKER_A_ID   = "33333333-3333-4333-a333-333333333333";
const WORKER_B_ID   = "44444444-4444-4444-a444-444444444444";
const ADMIN_ID      = "99999999-9999-4999-a999-999999999999";

const BOOKING_A_ID  = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const CONV_A_ID     = "caaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const BOOKING_B_ID  = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const CONV_B_ID     = "cbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const SUSPENDED_WORKER_ID = "55555555-5555-4555-a555-555555555555";

const customerAToken = generateToken({ id: CUSTOMER_A_ID, role: UserRole.CUSTOMER, phone: "+919876543210" });
const customerBToken = generateToken({ id: CUSTOMER_B_ID, role: UserRole.CUSTOMER, phone: "+919876543211" });
const workerAToken   = generateToken({ id: WORKER_A_ID, role: UserRole.WORKER, phone: "+919876543212" });
const workerBToken   = generateToken({ id: WORKER_B_ID, role: UserRole.WORKER, phone: "+919876543213" });
const adminToken     = generateToken({ id: ADMIN_ID, role: UserRole.ADMIN, phone: "+919876543214" });
const suspendedWorkerToken = generateToken({ id: SUSPENDED_WORKER_ID, role: UserRole.WORKER, phone: "+919876543215" });

describe("Issue #7 — Lock Down Chat HTTP + Socket.IO", () => {
  let serverPort: number;
  let serverUrl: string;

  beforeAll((done) => {
    httpServer.listen(0, () => {
      const address = httpServer.address() as any;
      serverPort = address.port;
      serverUrl = `http://localhost:${serverPort}`;
      done();
    });
  });

  afterAll((done) => {
    httpServer.close(() => done());
  });

  beforeEach(() => {
    jest.clearAllMocks();

    // Default mock user lookups for socket handshake authentication
    (prisma.worker.findUnique as jest.Mock).mockImplementation(({ where }: any) => {
      if (where.id === WORKER_A_ID) return Promise.resolve({ id: WORKER_A_ID, phone: "+919876543212", deleted_at: null, verification_status: "verified" });
      if (where.id === WORKER_B_ID) return Promise.resolve({ id: WORKER_B_ID, phone: "+919876543213", deleted_at: null, verification_status: "verified" });
      if (where.id === SUSPENDED_WORKER_ID) return Promise.resolve({ id: SUSPENDED_WORKER_ID, phone: "+919876543215", deleted_at: null, verification_status: "suspended" });
      return Promise.resolve(null);
    });

    (prisma.customer.findUnique as jest.Mock).mockImplementation(({ where }: any) => {
      if (where.id === CUSTOMER_A_ID) return Promise.resolve({ id: CUSTOMER_A_ID, phone: "+919876543210", deleted_at: null });
      if (where.id === CUSTOMER_B_ID) return Promise.resolve({ id: CUSTOMER_B_ID, phone: "+919876543211", deleted_at: null });
      return Promise.resolve(null);
    });
  });

  function createClientSocket(token?: string): ClientSocket {
    return Client(serverUrl, {
      auth: token ? { token } : undefined,
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
    });
  }

  function connectClient(token: string): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const socket = createClientSocket(token);
      socket.on("connect", () => resolve(socket));
      socket.on("connect_error", (err) => reject(err));
    });
  }

  // =========================================================================
  // 1. HTTP Authentication & 4-Way Cross-IDOR Authorization
  // =========================================================================
  describe("1. HTTP Authentication & 4-Way Cross-IDOR Authorization", () => {
    it("Anonymous user cannot retrieve chat history (401 Unauthorized)", async () => {
      const res = await request(app).get(`/api/chat/${BOOKING_A_ID}/messages`);
      expect(res.status).toBe(401);
    });

    it("Anonymous user cannot send a message (401 Unauthorized)", async () => {
      const res = await request(app)
        .post(`/api/chat/${BOOKING_A_ID}/messages`)
        .send({ content: "Hello without auth" });
      expect(res.status).toBe(401);
    });

    it("Customer A CAN retrieve Customer A's booking chat history (200 OK)", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
      });
      (prisma.conversation.findFirst as jest.Mock).mockResolvedValue({
        id: CONV_A_ID,
        booking_id: BOOKING_A_ID,
      });
      (prisma.message.findMany as jest.Mock).mockResolvedValue([
        { id: "m1", conversation_id: CONV_A_ID, sender_id: CUSTOMER_A_ID, content: "Hello", sent_at: new Date() },
      ]);

      const res = await request(app)
        .get(`/api/chat/${BOOKING_A_ID}/messages`)
        .set("Authorization", `Bearer ${customerAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].content).toBe("Hello");
    });

    it("Customer B CANNOT retrieve Customer A's chat history (403/404 IDOR protection)", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
      });

      const res = await request(app)
        .get(`/api/chat/${BOOKING_A_ID}/messages`)
        .set("Authorization", `Bearer ${customerBToken}`);

      expect([403, 404]).toContain(res.status);
      expect(res.body.success).toBe(false);
    });

    it("Worker A (assigned) CAN retrieve Customer A's booking chat history (200 OK)", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
      });
      (prisma.conversation.findFirst as jest.Mock).mockResolvedValue({
        id: CONV_A_ID,
        booking_id: BOOKING_A_ID,
      });
      (prisma.message.findMany as jest.Mock).mockResolvedValue([
        { id: "m1", conversation_id: CONV_A_ID, sender_id: CUSTOMER_A_ID, content: "Hello Worker", sent_at: new Date() },
      ]);

      const res = await request(app)
        .get(`/api/chat/${BOOKING_A_ID}/messages`)
        .set("Authorization", `Bearer ${workerAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
    });

    it("Worker B (unrelated) CANNOT retrieve Worker A's booking chat history (403/404 IDOR protection)", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
      });

      const res = await request(app)
        .get(`/api/chat/${BOOKING_A_ID}/messages`)
        .set("Authorization", `Bearer ${workerBToken}`);

      expect([403, 404]).toContain(res.status);
      expect(res.body.success).toBe(false);
    });

    it("Customer B CAN retrieve Customer B's booking chat history (Booking B) (200 OK)", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
        id: BOOKING_B_ID,
        customer_id: CUSTOMER_B_ID,
        worker_id: WORKER_B_ID,
      });
      (prisma.conversation.findFirst as jest.Mock).mockResolvedValue({
        id: CONV_B_ID,
        booking_id: BOOKING_B_ID,
      });
      (prisma.message.findMany as jest.Mock).mockResolvedValue([
        { id: "m2", conversation_id: CONV_B_ID, sender_id: CUSTOMER_B_ID, content: "Hello Booking B", sent_at: new Date() },
      ]);

      const res = await request(app)
        .get(`/api/chat/${BOOKING_B_ID}/messages`)
        .set("Authorization", `Bearer ${customerBToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("Worker B (assigned) CAN retrieve Booking B chat history (200 OK)", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
        id: BOOKING_B_ID,
        customer_id: CUSTOMER_B_ID,
        worker_id: WORKER_B_ID,
      });
      (prisma.conversation.findFirst as jest.Mock).mockResolvedValue({
        id: CONV_B_ID,
        booking_id: BOOKING_B_ID,
      });
      (prisma.message.findMany as jest.Mock).mockResolvedValue([]);

      const res = await request(app)
        .get(`/api/chat/${BOOKING_B_ID}/messages`)
        .set("Authorization", `Bearer ${workerBToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("Customer A CANNOT retrieve Customer B's booking chat history (Booking B) (403/404 IDOR protection)", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        id: BOOKING_B_ID,
        customer_id: CUSTOMER_B_ID,
        worker_id: WORKER_B_ID,
      });

      const res = await request(app)
        .get(`/api/chat/${BOOKING_B_ID}/messages`)
        .set("Authorization", `Bearer ${customerAToken}`);

      expect([403, 404]).toContain(res.status);
      expect(res.body.success).toBe(false);
    });

    it("Worker A CANNOT retrieve Booking B chat history (403/404 IDOR protection)", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        id: BOOKING_B_ID,
        customer_id: CUSTOMER_B_ID,
        worker_id: WORKER_B_ID,
      });

      const res = await request(app)
        .get(`/api/chat/${BOOKING_B_ID}/messages`)
        .set("Authorization", `Bearer ${workerAToken}`);

      expect([403, 404]).toContain(res.status);
      expect(res.body.success).toBe(false);
    });

    it("Platform Admin CAN retrieve chat history for any booking (200 OK)", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
      });
      (prisma.conversation.findFirst as jest.Mock).mockResolvedValue({
        id: CONV_A_ID,
        booking_id: BOOKING_A_ID,
      });
      (prisma.message.findMany as jest.Mock).mockResolvedValue([]);

      const res = await request(app)
        .get(`/api/chat/${BOOKING_A_ID}/messages`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("Malformed bookingId returns 400 Bad Request without hitting database", async () => {
      const res = await request(app)
        .get("/api/chat/not-a-valid-uuid/messages")
        .set("Authorization", `Bearer ${customerAToken}`);

      expect(res.status).toBe(400);
      expect(prisma.booking.findFirst).not.toHaveBeenCalled();
      expect(prisma.booking.findUnique).not.toHaveBeenCalled();
    });

    it("Nonexistent booking returns 404 Not Found", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue(null);

      const res = await request(app)
        .get(`/api/chat/${BOOKING_A_ID}/messages`)
        .set("Authorization", `Bearer ${customerAToken}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  // =========================================================================
  // 2. HTTP Message Creation & Identity Spoofing Protection
  // =========================================================================
  describe("2. HTTP Message Creation & Identity Spoofing Protection", () => {
    it("Customer A CAN send message to own booking (201 Created)", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
      });
      (prisma.conversation.findFirst as jest.Mock).mockResolvedValue({
        id: CONV_A_ID,
        booking_id: BOOKING_A_ID,
      });
      (prisma.message.create as jest.Mock).mockResolvedValue({
        id: "msg-created-1",
        conversation_id: CONV_A_ID,
        sender_id: CUSTOMER_A_ID,
        content: "Hi Worker, arriving soon?",
        sent_at: new Date(),
      });

      const res = await request(app)
        .post(`/api/chat/${BOOKING_A_ID}/messages`)
        .set("Authorization", `Bearer ${customerAToken}`)
        .send({ content: "Hi Worker, arriving soon?" });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.sender_id).toBe(CUSTOMER_A_ID);
    });

    it("Customer B CANNOT send message to Customer A's booking (403/404 denied)", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
      });

      const res = await request(app)
        .post(`/api/chat/${BOOKING_A_ID}/messages`)
        .set("Authorization", `Bearer ${customerBToken}`)
        .send({ content: "Intruder message" });

      expect([403, 404]).toContain(res.status);
      expect(res.body.success).toBe(false);
      expect(prisma.message.create).not.toHaveBeenCalled();
    });

    it("Worker A (assigned) CAN send message to booking (201 Created)", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
      });
      (prisma.conversation.findFirst as jest.Mock).mockResolvedValue({
        id: CONV_A_ID,
        booking_id: BOOKING_A_ID,
      });
      (prisma.message.create as jest.Mock).mockResolvedValue({
        id: "msg-created-2",
        conversation_id: CONV_A_ID,
        sender_id: WORKER_A_ID,
        content: "Yes, I am on my way!",
        sent_at: new Date(),
      });

      const res = await request(app)
        .post(`/api/chat/${BOOKING_A_ID}/messages`)
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({ content: "Yes, I am on my way!" });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.sender_id).toBe(WORKER_A_ID);
    });

    it("Worker B (unrelated) CANNOT send message to Worker A's booking (403/404 denied)", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
      });

      const res = await request(app)
        .post(`/api/chat/${BOOKING_A_ID}/messages`)
        .set("Authorization", `Bearer ${workerBToken}`)
        .send({ content: "Unrelated worker message" });

      expect([403, 404]).toContain(res.status);
      expect(res.body.success).toBe(false);
      expect(prisma.message.create).not.toHaveBeenCalled();
    });

    it("Customer A CANNOT send message to Customer B's booking (Booking B) (403/404 denied)", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        id: BOOKING_B_ID,
        customer_id: CUSTOMER_B_ID,
        worker_id: WORKER_B_ID,
      });

      const res = await request(app)
        .post(`/api/chat/${BOOKING_B_ID}/messages`)
        .set("Authorization", `Bearer ${customerAToken}`)
        .send({ content: "Customer A targeting Booking B" });

      expect([403, 404]).toContain(res.status);
      expect(res.body.success).toBe(false);
      expect(prisma.message.create).not.toHaveBeenCalled();
    });

    it("Worker A CANNOT send message to Booking B (403/404 denied)", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        id: BOOKING_B_ID,
        customer_id: CUSTOMER_B_ID,
        worker_id: WORKER_B_ID,
      });

      const res = await request(app)
        .post(`/api/chat/${BOOKING_B_ID}/messages`)
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({ content: "Worker A targeting Booking B" });

      expect([403, 404]).toContain(res.status);
      expect(res.body.success).toBe(false);
      expect(prisma.message.create).not.toHaveBeenCalled();
    });

    it("Client attempting to inject sender_id or customer_id in body is REJECTED by strict schema (400 Bad Request)", async () => {
      const res = await request(app)
        .post(`/api/chat/${BOOKING_A_ID}/messages`)
        .set("Authorization", `Bearer ${customerAToken}`)
        .send({
          content: "Valid content",
          sender_id: CUSTOMER_B_ID, // Attempted spoofing
        });

      expect(res.status).toBe(400);
      expect(prisma.message.create).not.toHaveBeenCalled();
    });

    it("Chat message DTO does not leak sensitive internal database fields", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
      });
      (prisma.conversation.findFirst as jest.Mock).mockResolvedValue({
        id: CONV_A_ID,
        booking_id: BOOKING_A_ID,
      });
      (prisma.message.create as jest.Mock).mockResolvedValue({
        id: "msg-dto-1",
        conversation_id: CONV_A_ID,
        sender_id: CUSTOMER_A_ID,
        content: "DTO verification",
        sent_at: new Date(),
        password: "leaked_password_hash",
        otp_hash: "leaked_otp",
        internal_meta: "sensitive",
      });

      const res = await request(app)
        .post(`/api/chat/${BOOKING_A_ID}/messages`)
        .set("Authorization", `Bearer ${customerAToken}`)
        .send({ content: "DTO verification" });

      expect(res.status).toBe(201);
      expect(res.body.data).toHaveProperty("id");
      expect(res.body.data).toHaveProperty("conversation_id");
      expect(res.body.data).toHaveProperty("sender_id");
      expect(res.body.data).toHaveProperty("content");
      expect(res.body.data).toHaveProperty("sent_at");
      expect(res.body.data).not.toHaveProperty("password");
      expect(res.body.data).not.toHaveProperty("otp_hash");
      expect(res.body.data).not.toHaveProperty("internal_meta");
    });
  });

  // =========================================================================
  // 3. Socket.IO Room Joining, Messaging & Cross-Room Isolation
  // =========================================================================
  describe("3. Socket.IO Room Joining, Messaging & Cross-Room Isolation", () => {
    it("Unauthenticated socket handshake is rejected", (done) => {
      const unauthClient = createClientSocket();
      unauthClient.on("connect_error", (err) => {
        expect(err.message).toContain("Authentication required");
        unauthClient.close();
        done();
      });
    });

    it("Suspended worker socket connection is rejected during handshake", (done) => {
      const suspendedClient = createClientSocket(suspendedWorkerToken);
      suspendedClient.on("connect_error", (err) => {
        expect(err.message).toBe("Invalid authentication credentials");
        suspendedClient.close();
        done();
      });
    });

    it("Customer A CAN join Booking A room (join:booking)", (done) => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
      });

      const client = createClientSocket(customerAToken);
      client.on("connect", () => {
        client.emit("join:booking", { bookingId: BOOKING_A_ID }, (res: any) => {
          expect(res.success).toBe(true);
          const serverSocket = io.sockets.sockets.get(client.id!);
          expect(serverSocket?.rooms.has(getBookingChatRoom(BOOKING_A_ID))).toBe(true);

          client.close();
          done();
        });
      });
    });

    it("Customer A CAN join booking room via alias (join:chat)", (done) => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
      });

      const client = createClientSocket(customerAToken);
      client.on("connect", () => {
        client.emit("join:chat", { bookingId: BOOKING_A_ID }, (res: any) => {
          expect(res.success).toBe(true);
          const serverSocket = io.sockets.sockets.get(client.id!);
          expect(serverSocket?.rooms.has(getBookingChatRoom(BOOKING_A_ID))).toBe(true);

          client.close();
          done();
        });
      });
    });

    it("Worker A (assigned) CAN join Booking A room (join:booking)", (done) => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
      });

      const client = createClientSocket(workerAToken);
      client.on("connect", () => {
        client.emit("join:booking", { bookingId: BOOKING_A_ID }, (res: any) => {
          expect(res.success).toBe(true);
          const serverSocket = io.sockets.sockets.get(client.id!);
          expect(serverSocket?.rooms.has(getBookingChatRoom(BOOKING_A_ID))).toBe(true);

          client.close();
          done();
        });
      });
    });

    it("Customer B CANNOT join Customer A's Booking A room (FORBIDDEN, not joined)", (done) => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
      });

      const client = createClientSocket(customerBToken);
      client.on("connect", () => {
        client.emit("join:booking", { bookingId: BOOKING_A_ID }, (res: any) => {
          expect(res.success).toBe(false);
          expect(res.code).toBe("FORBIDDEN");
          const serverSocket = io.sockets.sockets.get(client.id!);
          expect(serverSocket?.rooms.has(getBookingChatRoom(BOOKING_A_ID))).toBe(false);

          client.close();
          done();
        });
      });
    });

    it("Worker B CANNOT join Worker A's Booking A room (FORBIDDEN, not joined)", (done) => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
      });

      const client = createClientSocket(workerBToken);
      client.on("connect", () => {
        client.emit("join:booking", { bookingId: BOOKING_A_ID }, (res: any) => {
          expect(res.success).toBe(false);
          expect(res.code).toBe("FORBIDDEN");
          const serverSocket = io.sockets.sockets.get(client.id!);
          expect(serverSocket?.rooms.has(getBookingChatRoom(BOOKING_A_ID))).toBe(false);

          client.close();
          done();
        });
      });
    });

    it("Customer A CANNOT join Booking B room (FORBIDDEN, not joined)", (done) => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        id: BOOKING_B_ID,
        customer_id: CUSTOMER_B_ID,
        worker_id: WORKER_B_ID,
      });

      const client = createClientSocket(customerAToken);
      client.on("connect", () => {
        client.emit("join:booking", { bookingId: BOOKING_B_ID }, (res: any) => {
          expect(res.success).toBe(false);
          expect(res.code).toBe("FORBIDDEN");
          const serverSocket = io.sockets.sockets.get(client.id!);
          expect(serverSocket?.rooms.has(getBookingChatRoom(BOOKING_B_ID))).toBe(false);

          client.close();
          done();
        });
      });
    });

    it("Worker A CANNOT join Booking B room (FORBIDDEN, not joined)", (done) => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        id: BOOKING_B_ID,
        customer_id: CUSTOMER_B_ID,
        worker_id: WORKER_B_ID,
      });

      const client = createClientSocket(workerAToken);
      client.on("connect", () => {
        client.emit("join:booking", { bookingId: BOOKING_B_ID }, (res: any) => {
          expect(res.success).toBe(false);
          expect(res.code).toBe("FORBIDDEN");
          const serverSocket = io.sockets.sockets.get(client.id!);
          expect(serverSocket?.rooms.has(getBookingChatRoom(BOOKING_B_ID))).toBe(false);

          client.close();
          done();
        });
      });
    });

    it("Malformed bookingId on join:booking is rejected (INVALID_REQUEST)", (done) => {
      const client = createClientSocket(customerAToken);
      client.on("connect", () => {
        client.emit("join:booking", { bookingId: "not-a-uuid" }, (res: any) => {
          expect(res.success).toBe(false);
          expect(res.code).toBe("INVALID_REQUEST");
          client.close();
          done();
        });
      });
    });

    it("Customer A sends chat:message -> emitted to booking room with authoritative sender_id", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
      });
      (prisma.conversation.findFirst as jest.Mock).mockResolvedValue({
        id: CONV_A_ID,
        booking_id: BOOKING_A_ID,
      });
      (prisma.message.create as jest.Mock).mockResolvedValue({
        id: "msg-socket-1",
        conversation_id: CONV_A_ID,
        sender_id: CUSTOMER_A_ID,
        content: "Socket hello to Worker",
        sent_at: new Date(),
      });

      const customerClient = await connectClient(customerAToken);
      const workerClient = await connectClient(workerAToken);

      await new Promise<void>((resolve) => {
        workerClient.emit("join:booking", { bookingId: BOOKING_A_ID }, () => resolve());
      });

      const receivePromise = new Promise<void>((resolve) => {
        workerClient.on("chat:message", (data: any) => {
          expect(data.content).toBe("Socket hello to Worker");
          expect(data.sender_id).toBe(CUSTOMER_A_ID); // Strictly authoritative
          resolve();
        });
      });

      const sendPromise = new Promise<void>((resolve, reject) => {
        customerClient.emit(
          "chat:message",
          { bookingId: BOOKING_A_ID, content: "Socket hello to Worker" },
          (res: any) => {
            if (res.success) resolve();
            else reject(new Error(res.message));
          }
        );
      });

      await Promise.all([sendPromise, receivePromise]);

      customerClient.close();
      workerClient.close();
    });

    it("Customer B CANNOT send chat:message to Customer A's booking (FORBIDDEN)", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
      });

      const intruderClient = await connectClient(customerBToken);

      const res: any = await new Promise((resolve) => {
        intruderClient.emit(
          "chat:message",
          { bookingId: BOOKING_A_ID, content: "Intruder socket message" },
          (ack: any) => resolve(ack)
        );
      });

      expect(res.success).toBe(false);
      expect(res.code).toBe("FORBIDDEN");

      intruderClient.close();
    });

    it("Cross-Room Isolation: Booking A broadcast is NOT received by Booking B participants", async () => {
      // Setup Booking A
      (prisma.booking.findFirst as jest.Mock).mockImplementation(({ where }: any) => {
        if (where.id === BOOKING_A_ID && (where.customer_id === CUSTOMER_A_ID || where.worker_id === WORKER_A_ID)) {
          return Promise.resolve({ id: BOOKING_A_ID, customer_id: CUSTOMER_A_ID, worker_id: WORKER_A_ID });
        }
        if (where.id === BOOKING_B_ID && (where.customer_id === CUSTOMER_B_ID || where.worker_id === WORKER_B_ID)) {
          return Promise.resolve({ id: BOOKING_B_ID, customer_id: CUSTOMER_B_ID, worker_id: WORKER_B_ID });
        }
        return Promise.resolve(null);
      });

      (prisma.conversation.findFirst as jest.Mock).mockResolvedValue({
        id: CONV_A_ID,
        booking_id: BOOKING_A_ID,
      });

      (prisma.message.create as jest.Mock).mockResolvedValue({
        id: "msg-isolated-1",
        conversation_id: CONV_A_ID,
        sender_id: CUSTOMER_A_ID,
        content: "Private Booking A message",
        sent_at: new Date(),
      });

      const clientCustA = await connectClient(customerAToken);
      const clientWorkA = await connectClient(workerAToken);
      const clientCustB = await connectClient(customerBToken);
      const clientWorkB = await connectClient(workerBToken);

      // Join respective authorized rooms
      await new Promise<void>((resolve) => clientCustA.emit("join:booking", { bookingId: BOOKING_A_ID }, () => resolve()));
      await new Promise<void>((resolve) => clientWorkA.emit("join:booking", { bookingId: BOOKING_A_ID }, () => resolve()));
      await new Promise<void>((resolve) => clientCustB.emit("join:booking", { bookingId: BOOKING_B_ID }, () => resolve()));
      await new Promise<void>((resolve) => clientWorkB.emit("join:booking", { bookingId: BOOKING_B_ID }, () => resolve()));

      let custBReceived = false;
      let workBReceived = false;

      clientCustB.on("chat:message", () => { custBReceived = true; });
      clientWorkB.on("chat:message", () => { workBReceived = true; });

      const workAReceivePromise = new Promise<void>((resolve) => {
        clientWorkA.on("chat:message", (data: any) => {
          expect(data.content).toBe("Private Booking A message");
          resolve();
        });
      });

      await new Promise<void>((resolve, reject) => {
        clientCustA.emit(
          "chat:message",
          { bookingId: BOOKING_A_ID, content: "Private Booking A message" },
          (res: any) => {
            if (res.success) resolve();
            else reject(new Error(res.message));
          }
        );
      });

      await workAReceivePromise;

      // Allow small delay to ensure no unexpected broadcast reached B clients
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(custBReceived).toBe(false);
      expect(workBReceived).toBe(false);

      clientCustA.close();
      clientWorkA.close();
      clientCustB.close();
      clientWorkB.close();
    });
  });

  // =========================================================================
  // 4. Service-Layer Invariants & Concurrency
  // =========================================================================
  describe("4. Service-Layer Direct Authorization Invariants & Concurrency", () => {
    it("chatService.getMessages throws 401 when actor is missing", async () => {
      await expect(chatService.getMessages(BOOKING_A_ID, undefined as any)).rejects.toThrow(
        expect.objectContaining({ statusCode: 401 })
      );
    });

    it("chatService.sendMessage throws 401 when actor is missing", async () => {
      await expect(
        chatService.sendMessage(BOOKING_A_ID, CUSTOMER_A_ID, "msg", undefined as any)
      ).rejects.toThrow(expect.objectContaining({ statusCode: 401 }));
    });

    it("chatService.sendMessage strictly overrides any passed senderId with actor.id", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
      });
      (prisma.conversation.findFirst as jest.Mock).mockResolvedValue({
        id: CONV_A_ID,
        booking_id: BOOKING_A_ID,
      });
      (prisma.message.create as jest.Mock).mockImplementation(({ data }: any) => Promise.resolve(data));

      const message = await chatService.sendMessage(
        BOOKING_A_ID,
        "spoofed-sender-id", // Passed spoofed ID
        "Test message",
        { id: CUSTOMER_A_ID, role: UserRole.CUSTOMER, phone: "+919876543210" }
      );

      expect(message.sender_id).toBe(CUSTOMER_A_ID); // Must match actor.id
    });

    it("Concurrent messages sent to chatService are all processed with correct sender identity", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
      });
      (prisma.conversation.findFirst as jest.Mock).mockResolvedValue({
        id: CONV_A_ID,
        booking_id: BOOKING_A_ID,
      });

      let messageSeq = 0;
      (prisma.message.create as jest.Mock).mockImplementation(({ data }: any) => {
        messageSeq += 1;
        return Promise.resolve({
          id: `msg-concurrent-${messageSeq}`,
          conversation_id: data.conversation_id,
          sender_id: data.sender_id,
          content: data.content,
          sent_at: new Date(),
        });
      });

      const customerActor = { id: CUSTOMER_A_ID, role: UserRole.CUSTOMER, phone: "+919876543210" };
      const workerActor = { id: WORKER_A_ID, role: UserRole.WORKER, phone: "+919876543212" };

      const promises = [
        chatService.sendMessage(BOOKING_A_ID, CUSTOMER_A_ID, "Message 1 from Customer", customerActor),
        chatService.sendMessage(BOOKING_A_ID, WORKER_A_ID, "Message 2 from Worker", workerActor),
        chatService.sendMessage(BOOKING_A_ID, CUSTOMER_A_ID, "Message 3 from Customer", customerActor),
      ];

      const results = await Promise.all(promises);

      expect(results).toHaveLength(3);
      expect(results[0].sender_id).toBe(CUSTOMER_A_ID);
      expect(results[1].sender_id).toBe(WORKER_A_ID);
      expect(results[2].sender_id).toBe(CUSTOMER_A_ID);
    });
  });
});
