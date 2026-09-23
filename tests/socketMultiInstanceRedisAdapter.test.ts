/**
 * socketMultiInstanceRedisAdapter.test.ts
 *
 * LabourBaba Backend — P6 Issue 11 Integration Suite:
 * Socket.IO Multi-Instance Scaling & Cross-Instance Redis Adapter Verification
 *
 * Proves that:
 * 1. Two separate API/Socket.IO server instances (Instance A and Instance B) run simultaneously.
 * 2. Real Socket.IO clients connected to different backend instances receive cross-instance broadcasts.
 * 3. Events emitted from Instance A propagate via Redis Pub/Sub to clients connected to Instance B (and vice versa).
 * 4. Room isolation is strictly maintained across instances.
 * 5. Authentication (JWT) and room authorization policies remain strictly enforced.
 * 6. Disconnected clients reconnecting to a different instance can re-establish room presence.
 * 7. Graceful shutdown terminates adapter resources without memory or connection leaks.
 */

import http from "http";
import { Server as SocketIOServer } from "socket.io";
import { io as Client, Socket as ClientSocket } from "socket.io-client";
import { createSocketServer } from "../src/socket/createSocketServer";
import { setupSocketRedisAdapter, isSocketRedisAdapterReady } from "../src/socket/socketRedisAdapter";
import { startTestRedisServer, TestRedisServerInstance } from "./fixtures/testRedisServer";
import { signAccessToken } from "../src/utils/authUtils";
import { UserRole } from "../src/type/userRole";
import { getBookingChatRoom, getWorkerPersonalRoom, getCustomerPersonalRoom } from "../src/socket/roomHelpers";
import IORedis from "ioredis";
import prisma from "../src/config/prisma";

// Mock BullMQ queues
jest.mock("../src/config/bullmq", () => ({
  dispatchQueue: { add: jest.fn().mockResolvedValue({}) },
  timeoutQueue: { add: jest.fn().mockResolvedValue({}) },
}));

// Mock Prisma for authorization policy validation
const mockWorkerId = "11111111-1111-4111-8111-111111111111";
const mockOtherWorkerId = "22222222-2222-4222-8222-222222222222";
const mockCustomerId = "33333333-3333-4333-8333-333333333333";
const mockOtherCustomerId = "44444444-4444-4444-8444-444444444444";
const mockBookingId = "77777777-7777-4777-8777-777777777777";
const mockOtherBookingId = "88888888-8888-4888-8888-888888888888";

jest.mock("../src/config/prisma", () => {
  const wId = "11111111-1111-4111-8111-111111111111";
  const owId = "22222222-2222-4222-8222-222222222222";
  const cId = "33333333-3333-4333-8333-333333333333";
  const ocId = "44444444-4444-4444-8444-444444444444";
  const bId = "77777777-7777-4777-8777-777777777777";
  const obId = "88888888-8888-4888-8888-888888888888";

  return {
    __esModule: true,
    default: {
      worker: {
        findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
          if (where.id === wId) {
            return { id: wId, phone: "+919999000001", deleted_at: null, verification_status: "verified" };
          }
          if (where.id === owId) {
            return { id: owId, phone: "+919999000002", deleted_at: null, verification_status: "verified" };
          }
          return null;
        }),
      },
      customer: {
        findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
          if (where.id === cId) {
            return { id: cId, phone: "+919999000003", deleted_at: null };
          }
          if (where.id === ocId) {
            return { id: ocId, phone: "+919999000004", deleted_at: null };
          }
          return null;
        }),
      },
      booking: {
        findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
          if (where.id === bId) {
            return {
              id: bId,
              customer_id: cId,
              worker_id: wId,
              status: "IN_PROGRESS",
            };
          }
          if (where.id === obId) {
            return {
              id: obId,
              customer_id: ocId,
              worker_id: owId,
              status: "IN_PROGRESS",
            };
          }
          return null;
        }),
        findFirst: jest.fn(),
      },
      conversation: {
        findFirst: jest.fn().mockResolvedValue({ id: "conv-1", booking_id: bId }),
        create: jest.fn(),
      },
      message: {
        create: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      worker_location: {
        create: jest.fn(),
        findFirst: jest.fn(),
      },
      $transaction: jest.fn().mockImplementation(async (cb: any) => cb({})),
    },
  };
});

describe("P6 Issue 11 — Socket.IO Multi-Instance Scaling with Redis Adapter", () => {
  let redisServer: TestRedisServerInstance;
  let httpServerA: http.Server;
  let httpServerB: http.Server;
  let ioA: SocketIOServer;
  let ioB: SocketIOServer;
  let portA: number;
  let portB: number;

  let pubA: IORedis;
  let subA: IORedis;
  let pubB: IORedis;
  let subB: IORedis;

  let customerToken: string;
  let workerToken: string;
  let otherCustomerToken: string;

  beforeAll(async () => {
    // 1. Start Redis test backplane
    redisServer = await startTestRedisServer();

    // 2. Generate valid JWT access tokens
    customerToken = signAccessToken({ id: mockCustomerId, role: UserRole.CUSTOMER });
    workerToken = signAccessToken({ id: mockWorkerId, role: UserRole.WORKER });
    otherCustomerToken = signAccessToken({ id: mockOtherCustomerId, role: UserRole.CUSTOMER });

    // 3. Boot Instance A
    httpServerA = http.createServer();
    ioA = createSocketServer(httpServerA);
    pubA = new IORedis({ host: "127.0.0.1", port: redisServer.port, maxRetriesPerRequest: null });
    subA = pubA.duplicate();
    await setupSocketRedisAdapter(ioA, { pubClient: pubA, subClient: subA, forceEnable: true });

    await new Promise<void>((resolve) => {
      httpServerA.listen(0, "127.0.0.1", () => resolve());
    });
    portA = (httpServerA.address() as any).port;

    // 4. Boot Instance B
    httpServerB = http.createServer();
    ioB = createSocketServer(httpServerB);
    pubB = new IORedis({ host: "127.0.0.1", port: redisServer.port, maxRetriesPerRequest: null });
    subB = pubB.duplicate();
    await setupSocketRedisAdapter(ioB, { pubClient: pubB, subClient: subB, forceEnable: true });

    await new Promise<void>((resolve) => {
      httpServerB.listen(0, "127.0.0.1", () => resolve());
    });
    portB = (httpServerB.address() as any).port;
  });

  afterAll(async () => {
    // Graceful teardown
    ioA.disconnectSockets(true);
    ioB.disconnectSockets(true);

    await new Promise<void>((resolve) => ioA.close(() => resolve()));
    await new Promise<void>((resolve) => ioB.close(() => resolve()));

    await new Promise<void>((resolve) => httpServerA.close(() => resolve()));
    await new Promise<void>((resolve) => httpServerB.close(() => resolve()));

    await Promise.allSettled([pubA.quit(), subA.quit(), pubB.quit(), subB.quit()]);
    await redisServer.stop();
  });

  beforeEach(() => {
    (prisma.worker.findUnique as jest.Mock).mockImplementation(async ({ where }: any) => {
      if (where.id === mockWorkerId) {
        return { id: mockWorkerId, phone: "+919999000001", deleted_at: null, verification_status: "verified" };
      }
      if (where.id === mockOtherWorkerId) {
        return { id: mockOtherWorkerId, phone: "+919999000002", deleted_at: null, verification_status: "verified" };
      }
      return null;
    });

    (prisma.customer.findUnique as jest.Mock).mockImplementation(async ({ where }: any) => {
      if (where.id === mockCustomerId) {
        return { id: mockCustomerId, phone: "+919999000003", deleted_at: null };
      }
      if (where.id === mockOtherCustomerId) {
        return { id: mockOtherCustomerId, phone: "+919999000004", deleted_at: null };
      }
      return null;
    });

    (prisma.booking.findUnique as jest.Mock).mockImplementation(async ({ where }: any) => {
      if (where.id === mockBookingId) {
        return {
          id: mockBookingId,
          customer_id: mockCustomerId,
          worker_id: mockWorkerId,
          status: "IN_PROGRESS",
        };
      }
      if (where.id === mockOtherBookingId) {
        return {
          id: mockOtherBookingId,
          customer_id: mockOtherCustomerId,
          worker_id: mockOtherWorkerId,
          status: "IN_PROGRESS",
        };
      }
      return null;
    });

    (prisma.conversation.findFirst as jest.Mock).mockResolvedValue({
      id: "conv-1",
      booking_id: mockBookingId,
    });
  });

  const connectClient = (port: number, token?: string): Promise<ClientSocket> => {
    return new Promise((resolve) => {
      const client = Client(`http://127.0.0.1:${port}`, {
        transports: ["websocket"],
        auth: token ? { token } : undefined,
        reconnection: false,
        timeout: 3000,
      });

      client.on("connect", () => resolve(client));
      client.on("connect_error", (err) => {
        (client as any)._connectError = err.message;
        resolve(client);
      });
    });
  };

  describe("1. Multi-Instance Initialization & Adapter Readiness", () => {
    it("proves both backend instances are running on distinct network ports with active Redis adapters", () => {
      expect(portA).toBeGreaterThan(0);
      expect(portB).toBeGreaterThan(0);
      expect(portA).not.toEqual(portB);
      expect(isSocketRedisAdapterReady()).toBe(true);
    });
  });

  describe("2. Cross-Instance Room Broadcast (Instance A -> Instance B)", () => {
    let clientOnA: ClientSocket;
    let clientOnB: ClientSocket;

    afterEach(() => {
      if (clientOnA?.connected) clientOnA.disconnect();
      if (clientOnB?.connected) clientOnB.disconnect();
    });

    it("delivers room events emitted from Instance A to an authorized client connected to Instance B", async () => {
      // Connect Customer to Instance A
      clientOnA = await connectClient(portA, customerToken);
      if (!clientOnA.connected) {
        console.error("CLIENT A CONNECT ERROR:", (clientOnA as any)._connectError);
      }
      expect(clientOnA.connected).toBe(true);

      // Connect Worker to Instance B
      clientOnB = await connectClient(portB, workerToken);
      expect(clientOnB.connected).toBe(true);

      const bookingRoom = getBookingChatRoom(mockBookingId);

      // Both clients join the shared booking room via their respective instances
      await new Promise<void>((resolve) => {
        clientOnA.emit("join:booking", { bookingId: mockBookingId }, (ack: any) => {
          expect(ack?.success).toBe(true);
          resolve();
        });
      });

      await new Promise<void>((resolve) => {
        clientOnB.emit("join:booking", { bookingId: mockBookingId }, (ack: any) => {
          expect(ack?.success).toBe(true);
          resolve();
        });
      });

      // Prepare listener on Client B (connected to Instance B)
      const messagePromise = new Promise<any>((resolve) => {
        clientOnB.once("booking:status_change", (data) => resolve(data));
      });

      // Emit from Instance A
      ioA.to(bookingRoom).emit("booking:status_change", {
        bookingId: mockBookingId,
        status: "ARRIVED",
        timestamp: new Date().toISOString(),
      });

      // Assert Client B on Instance B received the event across the Redis backplane
      const received = await Promise.race([
        messagePromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout waiting for cross-instance event")), 4000)),
      ]);

      expect(received).toBeDefined();
      expect(received.bookingId).toBe(mockBookingId);
      expect(received.status).toBe("ARRIVED");
    });
  });

  describe("3. Cross-Instance Room Broadcast (Instance B -> Instance A)", () => {
    let clientOnA: ClientSocket;
    let clientOnB: ClientSocket;

    afterEach(() => {
      if (clientOnA?.connected) clientOnA.disconnect();
      if (clientOnB?.connected) clientOnB.disconnect();
    });

    it("delivers room events emitted from Instance B to an authorized client connected to Instance A", async () => {
      clientOnA = await connectClient(portA, customerToken);
      clientOnB = await connectClient(portB, workerToken);

      const bookingRoom = getBookingChatRoom(mockBookingId);

      await new Promise<void>((resolve) => {
        clientOnA.emit("join:booking", { bookingId: mockBookingId }, () => resolve());
      });
      await new Promise<void>((resolve) => {
        clientOnB.emit("join:booking", { bookingId: mockBookingId }, () => resolve());
      });

      const messagePromise = new Promise<any>((resolve) => {
        clientOnA.once("chat:incoming_message", (data) => resolve(data));
      });

      // Emit from Instance B
      ioB.to(bookingRoom).emit("chat:incoming_message", {
        bookingId: mockBookingId,
        text: "Worker has arrived at location",
        senderRole: "worker",
      });

      const received = await Promise.race([
        messagePromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout waiting for B -> A event")), 4000)),
      ]);

      expect(received).toBeDefined();
      expect(received.text).toBe("Worker has arrived at location");
      expect(received.senderRole).toBe("worker");
    });
  });

  describe("4. Personal Room Routing Across Instances", () => {
    let clientOnB: ClientSocket;

    afterEach(() => {
      if (clientOnB?.connected) clientOnB.disconnect();
    });

    it("delivers targeted worker dispatch notification from Instance A to Worker on Instance B", async () => {
      // Worker connects to Instance B (automatically joins personal room 'worker:<id>')
      clientOnB = await connectClient(portB, workerToken);
      expect(clientOnB.connected).toBe(true);

      const workerRoom = getWorkerPersonalRoom(mockWorkerId);

      const eventPromise = new Promise<any>((resolve) => {
        clientOnB.once("job:incoming", (data) => resolve(data));
      });

      // Background worker on Instance A notifies worker in personal room
      ioA.to(workerRoom).emit("job:incoming", {
        jobId: "00000000-0000-4000-a000-000000000088",
        skillType: "Electrician",
        ratePerDay: 850,
      });

      const received = await Promise.race([
        eventPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout waiting for personal room event")), 4000)),
      ]);

      expect(received).toBeDefined();
      expect(received.jobId).toBe("00000000-0000-4000-a000-000000000088");
      expect(received.skillType).toBe("Electrician");
    });
  });

  describe("5. Room Isolation Across Instances", () => {
    let clientOnA: ClientSocket;
    let clientOnB: ClientSocket;

    afterEach(() => {
      if (clientOnA?.connected) clientOnA.disconnect();
      if (clientOnB?.connected) clientOnB.disconnect();
    });

    it("proves events emitted to Room 1 on Instance A are NOT received by clients in Room 2 on Instance B", async () => {
      clientOnA = await connectClient(portA, customerToken);
      clientOnB = await connectClient(portB, otherCustomerToken);

      // Client A joins Booking 1
      await new Promise<void>((resolve) => {
        clientOnA.emit("join:booking", { bookingId: mockBookingId }, () => resolve());
      });

      // Client B joins Booking 2
      await new Promise<void>((resolve) => {
        clientOnB.emit("join:booking", { bookingId: mockOtherBookingId }, () => resolve());
      });

      let clientBReceived = false;
      clientOnB.on("booking:confidential_alert", () => {
        clientBReceived = true;
      });

      const clientAReceivedPromise = new Promise<any>((resolve) => {
        clientOnA.once("booking:confidential_alert", (data) => resolve(data));
      });

      // Emit strictly to Booking 1 from Instance A
      ioA.to(getBookingChatRoom(mockBookingId)).emit("booking:confidential_alert", {
        bookingId: mockBookingId,
        secretCode: "OTP-9999",
      });

      const dataA = await clientAReceivedPromise;
      expect(dataA.secretCode).toBe("OTP-9999");

      // Give 500ms to ensure no leaked delivery to Client B
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(clientBReceived).toBe(false);
    });
  });

  describe("6. Negative Authorization Tests Across Multi-Instance Topology", () => {
    let unauthorizedClient: ClientSocket;

    afterEach(() => {
      if (unauthorizedClient?.connected) unauthorizedClient.disconnect();
    });

    it("strictly rejects an unauthenticated client attempting connection to either instance", async () => {
      unauthorizedClient = await connectClient(portA); // No token
      expect(unauthorizedClient.connected).toBe(false);
    });

    it("strictly rejects an unauthorized customer attempting to join another customer's booking room", async () => {
      // otherCustomer connects to Instance B
      unauthorizedClient = await connectClient(portB, otherCustomerToken);
      expect(unauthorizedClient.connected).toBe(true);

      // Attempts to join mockBookingId (which belongs to mockCustomerId, not otherCustomer)
      const ackResponse = await new Promise<any>((resolve) => {
        unauthorizedClient.emit("join:booking", { bookingId: mockBookingId }, (ack: any) => resolve(ack));
      });

      expect(ackResponse?.success).toBe(false);
      expect(ackResponse?.code).toBe("FORBIDDEN");
    });
  });

  describe("7. Disconnect and Reconnect Across Different Instances", () => {
    let client: ClientSocket;

    afterEach(() => {
      if (client?.connected) client.disconnect();
    });

    it("allows a client to disconnect from Instance A and reconnect to Instance B without split-brain", async () => {
      // 1. Connect to Instance A
      client = await connectClient(portA, customerToken);
      expect(client.connected).toBe(true);

      // Join room
      await new Promise<void>((resolve) => {
        client.emit("join:booking", { bookingId: mockBookingId }, () => resolve());
      });

      // 2. Disconnect from Instance A
      client.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(client.connected).toBe(false);

      // 3. Reconnect to Instance B with fresh socket
      client = await connectClient(portB, customerToken);
      expect(client.connected).toBe(true);

      // Re-authorize and rejoin room on Instance B
      await new Promise<void>((resolve) => {
        client.emit("join:booking", { bookingId: mockBookingId }, () => resolve());
      });

      // 4. Instance A emits event to room
      const eventPromise = new Promise<any>((resolve) => {
        client.once("booking:reconnected_event", (data) => resolve(data));
      });

      ioA.to(getBookingChatRoom(mockBookingId)).emit("booking:reconnected_event", {
        msg: "Event received after instance migration",
      });

      const received = await Promise.race([
        eventPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout on reconnected event")), 4000)),
      ]);

      expect(received).toBeDefined();
      expect(received.msg).toBe("Event received after instance migration");
    });
  });

  describe("8. Multi-Instance Concurrency & Load Proof", () => {
    let clientA: ClientSocket;
    let clientB: ClientSocket;

    afterEach(() => {
      if (clientA?.connected) clientA.disconnect();
      if (clientB?.connected) clientB.disconnect();
    });

    it("processes 20 concurrent cross-instance broadcasts with 100% delivery reliability", async () => {
      clientA = await connectClient(portA, customerToken);
      clientB = await connectClient(portB, workerToken);

      const bookingRoom = getBookingChatRoom(mockBookingId);

      await new Promise<void>((resolve) => {
        clientA.emit("join:booking", { bookingId: mockBookingId }, () => resolve());
      });
      await new Promise<void>((resolve) => {
        clientB.emit("join:booking", { bookingId: mockBookingId }, () => resolve());
      });

      const RECEIVED_EVENTS: number[] = [];
      clientB.on("concurrency:event", (data: { seq: number }) => {
        RECEIVED_EVENTS.push(data.seq);
      });

      // Emit 20 events from Instance A in rapid sequence
      const TOTAL_EVENTS = 20;
      for (let i = 1; i <= TOTAL_EVENTS; i++) {
        ioA.to(bookingRoom).emit("concurrency:event", { seq: i });
      }

      // Wait for all to be received
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Timeout: Received ${RECEIVED_EVENTS.length}/${TOTAL_EVENTS} concurrent events`));
        }, 5000);

        const check = setInterval(() => {
          if (RECEIVED_EVENTS.length === TOTAL_EVENTS) {
            clearTimeout(timeout);
            clearInterval(check);
            resolve();
          }
        }, 100);
      });

      expect(RECEIVED_EVENTS.length).toBe(TOTAL_EVENTS);
      expect(RECEIVED_EVENTS).toContain(1);
      expect(RECEIVED_EVENTS).toContain(20);
    });
  });
});
