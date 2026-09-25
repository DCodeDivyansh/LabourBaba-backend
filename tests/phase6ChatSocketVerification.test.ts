/**
 * tests/phase6ChatSocketVerification.test.ts
 *
 * LabourBaba Backend — T0 Phase 6: Chat & Socket.IO Real-Runtime Verification Harness
 *
 * Real Infrastructure Tested:
 * - Real Supabase PostgreSQL 17.6 + PostGIS (customers, workers, bookings, conversations, messages)
 * - Real Redis 7 (Docker container on port 6381) via @socket.io/redis-adapter
 * - Real Socket.IO server instances created via createSocketServer
 * - Real socket.io-client TCP connections over WebSockets
 * - Real Express HTTP endpoints via supertest
 */

import http from "http";
import crypto from "crypto";
import request from "supertest";
import { Server as SocketIOServer } from "socket.io";
import { io as Client, Socket as ClientSocket } from "socket.io-client";
import IORedis from "ioredis";
import prisma from "../src/config/prisma";
import { app } from "../src/server";
import { createSocketServer } from "../src/socket/createSocketServer";
import { setupSocketRedisAdapter } from "../src/socket/socketRedisAdapter";
import { startTestRedisServer, TestRedisServerInstance } from "./fixtures/testRedisServer";
import { signAccessToken, signRefreshToken, hashPassword } from "../src/utils/authUtils";
import { UserRole } from "../src/type/userRole";
import { getBookingChatRoom, getWorkerPersonalRoom, getCustomerPersonalRoom } from "../src/socket/roomHelpers";
import { disconnectUserSockets } from "../src/socket/socketLifecycle";

// Unique phone generator
let phoneSeq = 0;
function uniquePhone(): string {
  phoneSeq++;
  const pid = String((process.pid % 90) + 10);
  const s = String((phoneSeq % 90) + 10);
  const r = String(crypto.randomInt(1000, 9999));
  return `+9176${pid}${s}${r}`;
}

describe("T0 Phase 6: Real-Runtime Chat & Socket.IO Verification Suite", () => {
  jest.setTimeout(60000);

  // Database Fixture IDs
  let skillCatId: string;
  let customerAId: string;
  let customerBId: string;
  let workerAId: string;
  let workerBId: string;
  let suspendedWorkerId: string;
  let deletedCustomerId: string;
  let jobId: string;
  let reqId: string;
  let bookingAId: string;
  let bookingBId: string;

  // Tokens
  let customerAToken: string;
  let customerBToken: string;
  let workerAToken: string;
  let workerBToken: string;
  let adminToken: string;
  let suspendedWorkerToken: string;
  let deletedCustomerToken: string;

  // Real HTTP / Socket.IO Servers
  let httpServerA: http.Server;
  let httpServerB: http.Server;
  let ioServerA: SocketIOServer;
  let ioServerB: SocketIOServer;
  let portA: number;
  let portB: number;

  let redisInstance: TestRedisServerInstance;
  let pubClientA: IORedis;
  let subClientA: IORedis;
  let pubClientB: IORedis;
  let subClientB: IORedis;

  const activeClients: ClientSocket[] = [];

  function createClient(port: number, token?: string, extraOptions?: any): ClientSocket {
    const client = Client(`http://127.0.0.1:${port}`, {
      auth: token ? { token } : undefined,
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
      timeout: 4000,
      ...extraOptions,
    });
    activeClients.push(client);
    return client;
  }

  function connectClient(port: number, token: string): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const client = createClient(port, token);
      client.on("connect", () => resolve(client));
      client.on("connect_error", (err) => reject(err));
    });
  }

  beforeAll(async () => {
    const pw = await hashPassword("ChatPass@123");

    // 1. Create Skill Category
    const cat = await prisma.skill_category.create({
      data: { name: `ChatPhase6Cat_${Date.now()}_${crypto.randomInt(100, 999)}` },
    });
    skillCatId = cat.id;

    // 2. Create Real Customers
    const custA = await prisma.customer.create({
      data: { name: "Chat Cust A", phone: uniquePhone(), password: pw },
    });
    customerAId = custA.id;

    const custB = await prisma.customer.create({
      data: { name: "Chat Cust B", phone: uniquePhone(), password: pw },
    });
    customerBId = custB.id;

    const custDeleted = await prisma.customer.create({
      data: { name: "Chat Cust Deleted", phone: uniquePhone(), password: pw, deleted_at: new Date() },
    });
    deletedCustomerId = custDeleted.id;

    // 3. Create Real Workers
    const workA = await prisma.worker.create({
      data: {
        name: "Chat Worker A",
        phone: uniquePhone(),
        password: pw,
        skill_type: "Electrician",
        skill_category_id: skillCatId,
        verification_status: "verified",
      },
    });
    workerAId = workA.id;

    const workB = await prisma.worker.create({
      data: {
        name: "Chat Worker B",
        phone: uniquePhone(),
        password: pw,
        skill_type: "Electrician",
        skill_category_id: skillCatId,
        verification_status: "verified",
      },
    });
    workerBId = workB.id;

    const workSuspended = await prisma.worker.create({
      data: {
        name: "Chat Worker Suspended",
        phone: uniquePhone(),
        password: pw,
        skill_type: "Electrician",
        skill_category_id: skillCatId,
        verification_status: "suspended",
      },
    });
    suspendedWorkerId = workSuspended.id;

    // 4. Create Real Job & Requirement
    const job = await prisma.job.create({
      data: {
        customer_id: customerAId,
        location: "Lucknow Test Site",
        status: "OPEN",
      },
    });
    jobId = job.id;

    const req = await prisma.job_requirement.create({
      data: {
        job_id: jobId,
        skill_id: skillCatId,
        worker_count_needed: 2,
        rate_per_day: 650,
      },
    });
    reqId = req.id;

    // 5. Create Real Bookings
    // Booking A: Customer A <-> Worker A
    const bA = await prisma.booking.create({
      data: {
        job_id: jobId,
        requirement_id: reqId,
        customer_id: customerAId,
        worker_id: workerAId,
        status: "IN_PROGRESS",
      },
    });
    bookingAId = bA.id;

    // Booking B: Customer B <-> Worker B
    const jobB = await prisma.job.create({
      data: {
        customer_id: customerBId,
        location: "Kanpur Test Site",
        status: "OPEN",
      },
    });
    const reqB = await prisma.job_requirement.create({
      data: {
        job_id: jobB.id,
        skill_id: skillCatId,
        worker_count_needed: 1,
        rate_per_day: 700,
      },
    });
    const bB = await prisma.booking.create({
      data: {
        job_id: jobB.id,
        requirement_id: reqB.id,
        customer_id: customerBId,
        worker_id: workerBId,
        status: "IN_PROGRESS",
      },
    });
    bookingBId = bB.id;

    // 6. Generate Tokens
    customerAToken = signAccessToken({ id: customerAId, role: UserRole.CUSTOMER, phone: custA.phone });
    customerBToken = signAccessToken({ id: customerBId, role: UserRole.CUSTOMER, phone: custB.phone });
    workerAToken = signAccessToken({ id: workerAId, role: UserRole.WORKER, phone: workA.phone });
    workerBToken = signAccessToken({ id: workerBId, role: UserRole.WORKER, phone: workB.phone });
    adminToken = signAccessToken({ id: "99999999-9999-4999-a999-999999999999", role: UserRole.ADMIN, phone: "+919999999999" });
    suspendedWorkerToken = signAccessToken({ id: suspendedWorkerId, role: UserRole.WORKER, phone: workSuspended.phone });
    deletedCustomerToken = signAccessToken({ id: deletedCustomerId, role: UserRole.CUSTOMER, phone: custDeleted.phone });

    // 7. Start Redis server fixture
    redisInstance = await startTestRedisServer();
    const redisPort = redisInstance.port;

    // 8. Boot Server A with Redis Adapter
    httpServerA = http.createServer();
    ioServerA = createSocketServer(httpServerA);
    pubClientA = new IORedis({ host: "127.0.0.1", port: redisPort, maxRetriesPerRequest: null });
    subClientA = pubClientA.duplicate();
    await setupSocketRedisAdapter(ioServerA, { pubClient: pubClientA, subClient: subClientA, forceEnable: true });

    await new Promise<void>((resolve) => httpServerA.listen(0, "127.0.0.1", () => resolve()));
    portA = (httpServerA.address() as any).port;

    // 9. Boot Server B with Redis Adapter
    httpServerB = http.createServer();
    ioServerB = createSocketServer(httpServerB);
    pubClientB = new IORedis({ host: "127.0.0.1", port: redisPort, maxRetriesPerRequest: null });
    subClientB = pubClientB.duplicate();
    await setupSocketRedisAdapter(ioServerB, { pubClient: pubClientB, subClient: subClientB, forceEnable: true });

    await new Promise<void>((resolve) => httpServerB.listen(0, "127.0.0.1", () => resolve()));
    portB = (httpServerB.address() as any).port;
  });

  afterAll(async () => {
    // Disconnect any active client sockets
    for (const c of activeClients) {
      if (c?.connected) c.disconnect();
    }

    if (ioServerA) ioServerA.close();
    if (ioServerB) ioServerB.close();
    if (httpServerA) await new Promise<void>((res) => httpServerA.close(() => res()));
    if (httpServerB) await new Promise<void>((res) => httpServerB.close(() => res()));

    await Promise.allSettled([
      pubClientA?.quit(),
      subClientA?.quit(),
      pubClientB?.quit(),
      subClientB?.quit(),
    ]);

    if (redisInstance) {
      await redisInstance.stop();
    }

    // Clean up test records
    try {
      await prisma.message.deleteMany({
        where: {
          conversation: {
            booking_id: { in: [bookingAId, bookingBId] },
          },
        },
      });
      await prisma.conversation.deleteMany({
        where: { booking_id: { in: [bookingAId, bookingBId] } },
      });
      await prisma.booking.deleteMany({
        where: { id: { in: [bookingAId, bookingBId] } },
      });
      await prisma.job_requirement.deleteMany({
        where: { job_id: jobId },
      });
      await prisma.job.deleteMany({
        where: { id: jobId },
      });
      await prisma.customer.deleteMany({
        where: { id: { in: [customerAId, customerBId, deletedCustomerId] } },
      });
      await prisma.worker.deleteMany({
        where: { id: { in: [workerAId, workerBId, suspendedWorkerId] } },
      });
      await prisma.skill_category.deleteMany({
        where: { id: skillCatId },
      });
    } catch {
      // Best-effort cleanup
    }

    await prisma.$disconnect();
  });

  afterEach(() => {
    // Cleanup temporary client connections
    for (const c of activeClients) {
      if (c?.connected) c.disconnect();
    }
    activeClients.length = 0;
  });

  // =========================================================================
  // 1. Authentication Verification (Real PostgreSQL & JWT)
  // =========================================================================
  describe("1. Real-Runtime Handshake Authentication", () => {
    it("connects successfully with valid customer JWT and auto-joins personal room", async () => {
      const client = await connectClient(portA, customerAToken);
      expect(client.connected).toBe(true);
      const serverSocket = ioServerA.sockets.sockets.get(client.id!);
      expect(serverSocket?.data.user.id).toBe(customerAId);
      expect(serverSocket?.data.user.role).toBe(UserRole.CUSTOMER);
      expect(serverSocket?.rooms.has(getCustomerPersonalRoom(customerAId))).toBe(true);
    });

    it("connects successfully with valid worker JWT and auto-joins personal room", async () => {
      const client = await connectClient(portA, workerAToken);
      expect(client.connected).toBe(true);
      const serverSocket = ioServerA.sockets.sockets.get(client.id!);
      expect(serverSocket?.data.user.id).toBe(workerAId);
      expect(serverSocket?.data.user.role).toBe(UserRole.WORKER);
      expect(serverSocket?.rooms.has(getWorkerPersonalRoom(workerAId))).toBe(true);
    });

    it("rejects connection cleanly when auth token is missing (401 / Authentication required)", async () => {
      await expect(
        new Promise<void>((resolve, reject) => {
          const client = createClient(portA);
          client.on("connect", () => {
            client.disconnect();
            reject(new Error("Should not connect without token"));
          });
          client.on("connect_error", (err) => {
            expect(err.message).toMatch(/Authentication required/i);
            resolve();
          });
        })
      ).resolves.not.toThrow();
    });

    it("rejects connection with malformed token", async () => {
      await expect(
        new Promise<void>((resolve, reject) => {
          const client = createClient(portA, "not.a.valid.jwt");
          client.on("connect", () => reject(new Error("Should not connect with malformed token")));
          client.on("connect_error", (err) => {
            expect(err.message).toMatch(/Invalid authentication credentials/i);
            resolve();
          });
        })
      ).resolves.not.toThrow();
    });

    it("rejects connection with expired token", async () => {
      const expiredToken = signAccessToken({ id: customerAId, role: UserRole.CUSTOMER }, "-1s");
      await expect(
        new Promise<void>((resolve, reject) => {
          const client = createClient(portA, expiredToken);
          client.on("connect", () => reject(new Error("Should not connect with expired token")));
          client.on("connect_error", (err) => {
            expect(err.message).toMatch(/Invalid authentication credentials/i);
            resolve();
          });
        })
      ).resolves.not.toThrow();
    });

    it("rejects connection when refresh token is presented instead of access token", async () => {
      const refreshToken = signRefreshToken({ id: customerAId, role: UserRole.CUSTOMER });
      await expect(
        new Promise<void>((resolve, reject) => {
          const client = createClient(portA, refreshToken);
          client.on("connect", () => reject(new Error("Should not connect with refresh token")));
          client.on("connect_error", (err) => {
            expect(err.message).toMatch(/Invalid authentication credentials/i);
            resolve();
          });
        })
      ).resolves.not.toThrow();
    });

    it("rejects connection when worker account is suspended in real PostgreSQL", async () => {
      await expect(
        new Promise<void>((resolve, reject) => {
          const client = createClient(portA, suspendedWorkerToken);
          client.on("connect", () => reject(new Error("Should not connect with suspended account")));
          client.on("connect_error", (err) => {
            expect(err.message).toMatch(/Invalid authentication credentials/i);
            resolve();
          });
        })
      ).resolves.not.toThrow();
    });

    it("rejects connection when customer account is deleted in real PostgreSQL", async () => {
      await expect(
        new Promise<void>((resolve, reject) => {
          const client = createClient(portA, deletedCustomerToken);
          client.on("connect", () => reject(new Error("Should not connect with deleted account")));
          client.on("connect_error", (err) => {
            expect(err.message).toMatch(/Invalid authentication credentials/i);
            resolve();
          });
        })
      ).resolves.not.toThrow();
    });
  });

  // =========================================================================
  // 2. Principal Derivation & Identity Anti-Spoofing
  // =========================================================================
  describe("2. Principal Derivation & Anti-Spoofing", () => {
    it("rejects Worker A attempting to join Worker B personal room (join:worker spoofing)", async () => {
      const client = await connectClient(portA, workerAToken);
      const ack: any = await new Promise((resolve) => {
        client.emit("join:worker", workerBId, (res: any) => resolve(res));
      });
      expect(ack.success).toBe(false);
      expect(ack.code).toBe("FORBIDDEN");
      expect(ack.message).toContain("Cannot join another worker's room");
      const serverSocket = ioServerA.sockets.sockets.get(client.id!);
      expect(serverSocket?.rooms.has(getWorkerPersonalRoom(workerBId))).toBe(false);
    });

    it("rejects Customer A attempting to join Customer B personal room (join:customer spoofing)", async () => {
      const client = await connectClient(portA, customerAToken);
      const ack: any = await new Promise((resolve) => {
        client.emit("join:customer", customerBId, (res: any) => resolve(res));
      });
      expect(ack.success).toBe(false);
      expect(ack.code).toBe("FORBIDDEN");
      expect(ack.message).toContain("Cannot join another customer's room");
      const serverSocket = ioServerA.sockets.sockets.get(client.id!);
      expect(serverSocket?.rooms.has(getCustomerPersonalRoom(customerBId))).toBe(false);
    });

    it("rejects location update with spoofed workerId in payload", async () => {
      const client = await connectClient(portA, workerAToken);
      const ack: any = await new Promise((resolve) => {
        client.emit(
          "worker:location_update",
          { customerId: customerAId, lat: 26.85, lng: 80.95, workerId: workerBId },
          (res: any) => resolve(res)
        );
      });
      expect(ack.success).toBe(false);
      expect(ack.code).toBe("FORBIDDEN");
      expect(ack.message).toContain("Cannot spoof worker identity");
    });
  });

  // =========================================================================
  // 3. Room Authorization & IDOR Verification
  // =========================================================================
  describe("3. Room Authorization & Cross-IDOR Protection", () => {
    it("allows Customer A to join legitimate Booking A room", async () => {
      const client = await connectClient(portA, customerAToken);
      const ack: any = await new Promise((resolve) => {
        client.emit("join:booking", { bookingId: bookingAId }, (res: any) => resolve(res));
      });
      expect(ack.success).toBe(true);
      const serverSocket = ioServerA.sockets.sockets.get(client.id!);
      expect(serverSocket?.rooms.has(getBookingChatRoom(bookingAId))).toBe(true);
    });

    it("allows Worker A to join legitimate Booking A room", async () => {
      const client = await connectClient(portA, workerAToken);
      const ack: any = await new Promise((resolve) => {
        client.emit("join:booking", { bookingId: bookingAId }, (res: any) => resolve(res));
      });
      expect(ack.success).toBe(true);
      const serverSocket = ioServerA.sockets.sockets.get(client.id!);
      expect(serverSocket?.rooms.has(getBookingChatRoom(bookingAId))).toBe(true);
    });

    it("strictly blocks Customer B from joining Booking A room (FORBIDDEN / IDOR Guard)", async () => {
      const client = await connectClient(portA, customerBToken);
      const ack: any = await new Promise((resolve) => {
        client.emit("join:booking", { bookingId: bookingAId }, (res: any) => resolve(res));
      });
      expect(ack.success).toBe(false);
      expect(["FORBIDDEN", "RESOURCE_NOT_FOUND"]).toContain(ack.code);
      const serverSocket = ioServerA.sockets.sockets.get(client.id!);
      expect(serverSocket?.rooms.has(getBookingChatRoom(bookingAId))).toBe(false);
    });

    it("strictly blocks Worker B from joining Booking A room (FORBIDDEN / IDOR Guard)", async () => {
      const client = await connectClient(portA, workerBToken);
      const ack: any = await new Promise((resolve) => {
        client.emit("join:booking", { bookingId: bookingAId }, (res: any) => resolve(res));
      });
      expect(ack.success).toBe(false);
      expect(["FORBIDDEN", "RESOURCE_NOT_FOUND"]).toContain(ack.code);
      const serverSocket = ioServerA.sockets.sockets.get(client.id!);
      expect(serverSocket?.rooms.has(getBookingChatRoom(bookingAId))).toBe(false);
    });

    it("rejects join:booking with malformed UUID (INVALID_REQUEST)", async () => {
      const client = await connectClient(portA, customerAToken);
      const ack: any = await new Promise((resolve) => {
        client.emit("join:booking", { bookingId: "invalid-uuid-format" }, (res: any) => resolve(res));
      });
      expect(ack.success).toBe(false);
      expect(ack.code).toBe("INVALID_REQUEST");
    });

    it("rejects join:booking with nonexistent UUID (RESOURCE_NOT_FOUND)", async () => {
      const client = await connectClient(portA, customerAToken);
      const ack: any = await new Promise((resolve) => {
        client.emit("join:booking", { bookingId: "00000000-0000-4000-a000-000000000099" }, (res: any) => resolve(res));
      });
      expect(ack.success).toBe(false);
      expect(["RESOURCE_NOT_FOUND", "FORBIDDEN"]).toContain(ack.code);
    });
  });

  // =========================================================================
  // 4. HTTP vs Socket.IO Authorization Equivalence
  // =========================================================================
  describe("4. HTTP vs Socket.IO Authorization Equivalence", () => {
    it("HTTP GET messages: Customer A succeeds (200 OK) with same policy", async () => {
      const res = await request(app)
        .get(`/api/chat/${bookingAId}/messages`)
        .set("Authorization", `Bearer ${customerAToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("HTTP GET messages: Worker A succeeds (200 OK) with same policy", async () => {
      const res = await request(app)
        .get(`/api/chat/${bookingAId}/messages`)
        .set("Authorization", `Bearer ${workerAToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("HTTP GET messages: Customer B is rejected (403/404) matching Socket.IO decision", async () => {
      const res = await request(app)
        .get(`/api/chat/${bookingAId}/messages`)
        .set("Authorization", `Bearer ${customerBToken}`);
      expect([403, 404]).toContain(res.status);
      expect(res.body.success).toBe(false);
    });

    it("HTTP GET messages: Worker B is rejected (403/404) matching Socket.IO decision", async () => {
      const res = await request(app)
        .get(`/api/chat/${bookingAId}/messages`)
        .set("Authorization", `Bearer ${workerBToken}`);
      expect([403, 404]).toContain(res.status);
      expect(res.body.success).toBe(false);
    });
  });

  // =========================================================================
  // 5. Message Delivery, Real-time Emission & Database Persistence
  // =========================================================================
  describe("5. Real-Time Message Exchange & PostgreSQL Persistence", () => {
    it("Customer A sends chat:message -> persisted in DB and delivered in real-time to Worker A", async () => {
      const clientCustA = await connectClient(portA, customerAToken);
      const clientWorkA = await connectClient(portA, workerAToken);

      // Both join Booking A room
      await new Promise<void>((resolve) => {
        clientCustA.emit("join:booking", { bookingId: bookingAId }, () => resolve());
      });
      await new Promise<void>((resolve) => {
        clientWorkA.emit("join:booking", { bookingId: bookingAId }, () => resolve());
      });

      const messageContent = `Realtime test message ${Date.now()}`;

      // Worker listener
      const receivePromise = new Promise<any>((resolve) => {
        clientWorkA.once("chat:message", (msg) => resolve(msg));
      });

      // Customer sends message
      const ack: any = await new Promise((resolve) => {
        clientCustA.emit("chat:message", { bookingId: bookingAId, content: messageContent }, (res: any) => resolve(res));
      });

      expect(ack.success).toBe(true);
      expect(ack.data.sender_id).toBe(customerAId);

      const receivedMsg = await Promise.race([
        receivePromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout on message receipt")), 4000)),
      ]);

      expect(receivedMsg.content).toBe(messageContent);
      expect(receivedMsg.sender_id).toBe(customerAId);

      // Verify message actually persisted in real PostgreSQL database
      const dbMsg = await prisma.message.findFirst({
        where: { id: ack.data.id },
      });
      expect(dbMsg).toBeDefined();
      expect(dbMsg?.content).toBe(messageContent);
      expect(dbMsg?.sender_id).toBe(customerAId);
    });

    it("strictly blocks Customer B from sending chat:message to Booking A (FORBIDDEN, no DB insert)", async () => {
      const clientCustB = await connectClient(portA, customerBToken);
      const ack: any = await new Promise((resolve) => {
        clientCustB.emit(
          "chat:message",
          { bookingId: bookingAId, content: "Intruder message from Customer B" },
          (res: any) => resolve(res)
        );
      });
      expect(ack.success).toBe(false);
      expect(["FORBIDDEN", "RESOURCE_NOT_FOUND"]).toContain(ack.code);

      // Verify no message was inserted into PostgreSQL
      const dbMsg = await prisma.message.findFirst({
        where: { content: "Intruder message from Customer B" },
      });
      expect(dbMsg).toBeNull();
    });
  });

  // =========================================================================
  // 6. Validation Edge Cases
  // =========================================================================
  describe("6. Message Validation Edge Cases", () => {
    it("rejects empty message content", async () => {
      const client = await connectClient(portA, customerAToken);
      const ack: any = await new Promise((resolve) => {
        client.emit("chat:message", { bookingId: bookingAId, content: "" }, (res: any) => resolve(res));
      });
      expect(ack.success).toBe(false);
      expect(ack.code).toBe("INVALID_REQUEST");
    });

    it("rejects whitespace-only message content", async () => {
      const client = await connectClient(portA, customerAToken);
      const ack: any = await new Promise((resolve) => {
        client.emit("chat:message", { bookingId: bookingAId, content: "   \n\t  " }, (res: any) => resolve(res));
      });
      expect(ack.success).toBe(false);
      expect(ack.code).toBe("INVALID_REQUEST");
    });

    it("rejects message exceeding 2000 characters", async () => {
      const client = await connectClient(portA, customerAToken);
      const oversized = "A".repeat(2001);
      const ack: any = await new Promise((resolve) => {
        client.emit("chat:message", { bookingId: bookingAId, content: oversized }, (res: any) => resolve(res));
      });
      expect(ack.success).toBe(false);
      expect(ack.code).toBe("INVALID_REQUEST");
      expect(ack.message).toContain("cannot exceed 2000 characters");
    });

    it("handles Hindi Unicode and emojis correctly without corruption", async () => {
      const client = await connectClient(portA, customerAToken);
      await new Promise<void>((resolve) => client.emit("join:booking", { bookingId: bookingAId }, () => resolve()));

      const unicodeText = "नमस्ते, काम कब शुरू होगा? 🛠️ 👷 🇮🇳";
      const ack: any = await new Promise((resolve) => {
        client.emit("chat:message", { bookingId: bookingAId, content: unicodeText }, (res: any) => resolve(res));
      });
      expect(ack.success).toBe(true);
      expect(ack.data.content).toBe(unicodeText);

      // Verify in PostgreSQL
      const dbMsg = await prisma.message.findFirst({ where: { id: ack.data.id } });
      expect(dbMsg?.content).toBe(unicodeText);
    });

    it("stores HTML and script tags harmlessly as plaintext", async () => {
      const client = await connectClient(portA, customerAToken);
      await new Promise<void>((resolve) => client.emit("join:booking", { bookingId: bookingAId }, () => resolve()));

      const xssPayload = "<script>alert('XSS')</script><b>Bold Text</b>";
      const ack: any = await new Promise((resolve) => {
        client.emit("chat:message", { bookingId: bookingAId, content: xssPayload }, (res: any) => resolve(res));
      });
      expect(ack.success).toBe(true);
      expect(ack.data.content).toBe(xssPayload);

      const dbMsg = await prisma.message.findFirst({ where: { id: ack.data.id } });
      expect(dbMsg?.content).toBe(xssPayload);
    });
  });

  // =========================================================================
  // 7. Disconnect, Reconnect & Client Restart
  // =========================================================================
  describe("7. Disconnect, Reconnect & Recovery Semantics", () => {
    it("client disconnects, reconnects with fresh socket and re-validates identity", async () => {
      // 1. Connect first socket
      const client1 = await connectClient(portA, customerAToken);
      expect(client1.connected).toBe(true);
      client1.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(client1.connected).toBe(false);

      // 2. Reconnect fresh socket
      const client2 = await connectClient(portA, customerAToken);
      expect(client2.connected).toBe(true);

      // Must re-join booking room explicitly
      const ack: any = await new Promise((resolve) => {
        client2.emit("join:booking", { bookingId: bookingAId }, (res: any) => resolve(res));
      });
      expect(ack.success).toBe(true);
    });

    it("offline recovery: worker was offline, customer sends message, worker recovers history via HTTP", async () => {
      // Customer sends message while worker is offline
      const offlineMsg = `Offline recovery message ${Date.now()}`;
      const postRes = await request(app)
        .post(`/api/chat/${bookingAId}/messages`)
        .set("Authorization", `Bearer ${customerAToken}`)
        .send({ content: offlineMsg });
      expect(postRes.status).toBe(201);

      // Worker comes online and retrieves message history
      const getRes = await request(app)
        .get(`/api/chat/${bookingAId}/messages`)
        .set("Authorization", `Bearer ${workerAToken}`);
      expect(getRes.status).toBe(200);
      const messages = getRes.body.data;
      const found = messages.find((m: any) => m.content === offlineMsg);
      expect(found).toBeDefined();
      expect(found.sender_id).toBe(customerAId);
    });

    it("verifies chronological message ordering (sent_at asc)", async () => {
      const getRes = await request(app)
        .get(`/api/chat/${bookingAId}/messages`)
        .set("Authorization", `Bearer ${customerAToken}`);
      expect(getRes.status).toBe(200);
      const messages = getRes.body.data;
      expect(messages.length).toBeGreaterThan(1);

      for (let i = 0; i < messages.length - 1; i++) {
        const t1 = new Date(messages[i].sent_at).getTime();
        const t2 = new Date(messages[i + 1].sent_at).getTime();
        expect(t1).toBeLessThanOrEqual(t2);
      }
    });
  });

  // =========================================================================
  // 8. Multi-Instance Cross-Instance Scaling with Real Redis Adapter
  // =========================================================================
  describe("8. Multi-Instance Scaling & Cross-Instance Redis Pub/Sub Backplane", () => {
    it("delivers room event from Instance A to an authorized client connected to Instance B", async () => {
      const clientA = await connectClient(portA, customerAToken);
      const clientB = await connectClient(portB, workerAToken);

      await new Promise<void>((resolve) => clientA.emit("join:booking", { bookingId: bookingAId }, () => resolve()));
      await new Promise<void>((resolve) => clientB.emit("join:booking", { bookingId: bookingAId }, () => resolve()));

      const crossMsg = `Cross instance A -> B: ${Date.now()}`;

      const receivePromise = new Promise<any>((resolve) => {
        clientB.once("chat:message", (data) => resolve(data));
      });

      // Emit from client on Instance A
      const ack: any = await new Promise((resolve) => {
        clientA.emit("chat:message", { bookingId: bookingAId, content: crossMsg }, (res: any) => resolve(res));
      });
      expect(ack.success).toBe(true);

      const received = await Promise.race([
        receivePromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout on cross-instance delivery")), 5000)),
      ]);

      expect(received.content).toBe(crossMsg);
      expect(received.sender_id).toBe(customerAId);
    });

    it("delivers room event from Instance B to an authorized client connected to Instance A", async () => {
      const clientA = await connectClient(portA, customerAToken);
      const clientB = await connectClient(portB, workerAToken);

      await new Promise<void>((resolve) => clientA.emit("join:booking", { bookingId: bookingAId }, () => resolve()));
      await new Promise<void>((resolve) => clientB.emit("join:booking", { bookingId: bookingAId }, () => resolve()));

      const crossMsg = `Cross instance B -> A: ${Date.now()}`;

      const receivePromise = new Promise<any>((resolve) => {
        clientA.once("chat:message", (data) => resolve(data));
      });

      // Emit from client on Instance B
      const ack: any = await new Promise((resolve) => {
        clientB.emit("chat:message", { bookingId: bookingAId, content: crossMsg }, (res: any) => resolve(res));
      });
      expect(ack.success).toBe(true);

      const received = await Promise.race([
        receivePromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout on B -> A delivery")), 5000)),
      ]);

      expect(received.content).toBe(crossMsg);
      expect(received.sender_id).toBe(workerAId);
    });

    it("verifies room isolation across instances (events in Booking A do not leak to Booking B)", async () => {
      const clientCustA = await connectClient(portA, customerAToken);
      const clientCustB = await connectClient(portB, customerBToken);

      await new Promise<void>((resolve) => clientCustA.emit("join:booking", { bookingId: bookingAId }, () => resolve()));
      await new Promise<void>((resolve) => clientCustB.emit("join:booking", { bookingId: bookingBId }, () => resolve()));

      let custBReceived = false;
      clientCustB.on("chat:message", () => { custBReceived = true; });

      const confidentialMsg = `Confidential to Booking A: ${Date.now()}`;
      await new Promise<void>((resolve) => {
        clientCustA.emit("chat:message", { bookingId: bookingAId, content: confidentialMsg }, () => resolve());
      });

      // Allow 400ms to ensure no leaked cross-instance packet
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(custBReceived).toBe(false);
    });
  });

  // =========================================================================
  // 9. Real Concurrency Stress
  // =========================================================================
  describe("9. Real Concurrency Testing", () => {
    it("handles 10 concurrent clients sending messages simultaneously without dropped records or deadlocks", async () => {
      const CONCURRENT_COUNT = 10;
      const clients: ClientSocket[] = [];

      for (let i = 0; i < CONCURRENT_COUNT; i++) {
        const client = await connectClient(portA, customerAToken);
        clients.push(client);
        await new Promise<void>((resolve) => client.emit("join:booking", { bookingId: bookingAId }, () => resolve()));
      }

      const sendPromises = clients.map((c, idx) => {
        return new Promise<any>((resolve, reject) => {
          c.emit(
            "chat:message",
            { bookingId: bookingAId, content: `Concurrent message #${idx} - ${Date.now()}` },
            (res: any) => {
              if (res?.success) resolve(res);
              else reject(new Error(res?.message || "Failed send"));
            }
          );
        });
      });

      const results = await Promise.all(sendPromises);
      expect(results).toHaveLength(CONCURRENT_COUNT);
      for (const r of results) {
        expect(r.success).toBe(true);
        expect(r.data.sender_id).toBe(customerAId);
      }
    });
  });
});
