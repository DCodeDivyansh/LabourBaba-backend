import { io as Client, Socket as ClientSocket } from "socket.io-client";
import { httpServer, io } from "../src/server";
import { signAccessToken, signRefreshToken } from "../src/utils/authUtils";
import { UserRole } from "../src/type/userRole";
import prisma from "../src/config/prisma";
import jwt from "jsonwebtoken";

// Mock BullMQ queues
jest.mock("../src/config/bullmq", () => ({
  dispatchQueue: { add: jest.fn().mockResolvedValue({}) },
  timeoutQueue: { add: jest.fn().mockResolvedValue({}) },
}));

const MOCK_WORKER_A_ID = "11111111-1111-4111-8111-111111111111";
const MOCK_WORKER_B_ID = "22222222-2222-4222-8222-222222222222";
const MOCK_CUSTOMER_A_ID = "33333333-3333-4333-8333-333333333333";
const MOCK_CUSTOMER_B_ID = "44444444-4444-4444-8444-444444444444";
const MOCK_ADMIN_ID = "55555555-5555-4555-8555-555555555555";
const MOCK_DELETED_WORKER_ID = "66666666-6666-4666-8666-666666666666";
const MOCK_BOOKING_B_ID = "77777777-7777-4777-8777-777777777777";

jest.mock("../src/config/prisma", () => {
  return {
    __esModule: true,
    default: {
      worker: {
        findUnique: jest.fn(),
      },
      customer: {
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
        findMany: jest.fn(),
      },
      worker_location: {
        create: jest.fn().mockResolvedValue({ id: "loc-1", worker_id: "22222222-2222-4222-8222-222222222222", updated_at: new Date() }),
        findFirst: jest.fn(),
      },
      $transaction: jest.fn().mockImplementation(async (cb: any) => cb({
        worker: {
          findUnique: jest.fn().mockResolvedValue({ id: "22222222-2222-4222-8222-222222222222", deleted_at: null }),
        },
        worker_location: {
          create: jest.fn().mockResolvedValue({ id: "loc-1", worker_id: "22222222-2222-4222-8222-222222222222", updated_at: new Date() }),
        },
        $executeRaw: jest.fn().mockResolvedValue(1),
      })),
      $executeRaw: jest.fn().mockResolvedValue(1),
      $connect: jest.fn().mockResolvedValue(undefined),
      $disconnect: jest.fn().mockResolvedValue(undefined),
    },
  };
});

describe("P0 Security Regression Tests — Finding #5: Socket.IO Identity Spoofing", () => {
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
    io.close();
    httpServer.close(done);
  });

  beforeEach(() => {
    // Default Prisma mock configurations
    (prisma.worker.findUnique as jest.Mock).mockImplementation(({ where }: any) => {
      if (where.id === MOCK_WORKER_A_ID) {
        return Promise.resolve({ id: MOCK_WORKER_A_ID, phone: "+919999999901", deleted_at: null });
      }
      if (where.id === MOCK_WORKER_B_ID) {
        return Promise.resolve({ id: MOCK_WORKER_B_ID, phone: "+919999999902", deleted_at: null });
      }
      if (where.id === MOCK_DELETED_WORKER_ID) {
        return Promise.resolve({ id: MOCK_DELETED_WORKER_ID, phone: "+919999999903", deleted_at: new Date() });
      }
      return Promise.resolve(null);
    });

    (prisma.customer.findUnique as jest.Mock).mockImplementation(({ where }: any) => {
      if (where.id === MOCK_CUSTOMER_A_ID) {
        return Promise.resolve({ id: MOCK_CUSTOMER_A_ID, phone: "+919888888801", deleted_at: null });
      }
      if (where.id === MOCK_CUSTOMER_B_ID) {
        return Promise.resolve({ id: MOCK_CUSTOMER_B_ID, phone: "+919888888802", deleted_at: null });
      }
      return Promise.resolve(null);
    });

    (prisma.booking.findUnique as jest.Mock).mockImplementation(({ where }: any) => {
      if (where.id === MOCK_BOOKING_B_ID) {
        return Promise.resolve({
          id: MOCK_BOOKING_B_ID,
          customer_id: MOCK_CUSTOMER_B_ID,
          worker_id: MOCK_WORKER_B_ID,
          status: "in_progress",
        });
      }
      return Promise.resolve(null);
    });

    (prisma.booking.findFirst as jest.Mock).mockImplementation(({ where }: any) => {
      // Authorized assignment: Worker B is assigned to Customer B
      if (where.worker_id === MOCK_WORKER_B_ID && where.customer_id === MOCK_CUSTOMER_B_ID) {
        return Promise.resolve({ id: MOCK_BOOKING_B_ID });
      }
      return Promise.resolve(null);
    });

    (prisma.conversation.findFirst as jest.Mock).mockImplementation(({ where }: any) => {
      if (where.booking_id === MOCK_BOOKING_B_ID) {
        return Promise.resolve({
          id: "conv-booking-b",
          booking_id: MOCK_BOOKING_B_ID,
          customer_id: MOCK_CUSTOMER_B_ID,
          worker_id: MOCK_WORKER_B_ID,
        });
      }
      return Promise.resolve(null);
    });

    (prisma.message.create as jest.Mock).mockImplementation(({ data }: any) => {
      return Promise.resolve({
        id: "msg-123",
        conversation_id: data.conversation_id,
        sender_id: data.sender_id,
        content: data.content,
        sent_at: new Date(),
      });
    });
  });

  // Helper function to create client socket with promise
  function createClientSocket(token?: string, extraHeaders?: any): ClientSocket {
    return Client(serverUrl, {
      auth: token !== undefined ? { token } : undefined,
      extraHeaders,
      transports: ["websocket"],
      reconnection: false,
      timeout: 3000,
    });
  }

  function connectClient(token: string): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const client = createClientSocket(token);
      client.on("connect", () => resolve(client));
      client.on("connect_error", (err) => reject(err));
    });
  }

  // ==========================================================================
  // Invariant 1: Handshake Authentication & Token Validation
  // ==========================================================================
  describe("Invariant 1: Handshake Authentication", () => {
    it("MUST reject connection when no authentication token is provided", (done) => {
      const client = createClientSocket();

      client.on("connect_error", (err) => {
        expect(err.message).toBe("Authentication required");
        client.close();
        done();
      });

      client.on("connect", () => {
        client.close();
        done(new Error("Should not have connected without token"));
      });
    });

    it("MUST reject connection with malformed token", (done) => {
      const client = createClientSocket("malformed.jwt.token");

      client.on("connect_error", (err) => {
        expect(err.message).toBe("Invalid authentication credentials");
        client.close();
        done();
      });
    });

    it("MUST reject connection with invalid signature token", (done) => {
      const fakeToken = jwt.sign(
        { id: MOCK_WORKER_A_ID, role: UserRole.WORKER, token_type: "access" },
        "wrong_cryptographic_secret_key_32_characters_long",
        { algorithm: "HS256" }
      );
      const client = createClientSocket(fakeToken);

      client.on("connect_error", (err) => {
        expect(err.message).toBe("Invalid authentication credentials");
        client.close();
        done();
      });
    });

    it("MUST reject connection with expired token", (done) => {
      const expiredToken = signAccessToken(
        { id: MOCK_WORKER_A_ID, role: UserRole.WORKER },
        "-1s" // expired 1 second ago
      );
      const client = createClientSocket(expiredToken);

      client.on("connect_error", (err) => {
        expect(err.message).toBe("Invalid authentication credentials");
        client.close();
        done();
      });
    });

    it("MUST reject connection when refresh token is presented instead of access token", (done) => {
      const refreshToken = signRefreshToken({
        id: MOCK_WORKER_A_ID,
        role: UserRole.WORKER,
      });
      const client = createClientSocket(refreshToken);

      client.on("connect_error", (err) => {
        expect(err.message).toBe("Invalid authentication credentials");
        client.close();
        done();
      });
    });

    it("MUST reject connection when user account is deleted/inactive in database", (done) => {
      const deletedWorkerToken = signAccessToken({
        id: MOCK_DELETED_WORKER_ID,
        role: UserRole.WORKER,
      });
      const client = createClientSocket(deletedWorkerToken);

      client.on("connect_error", (err) => {
        expect(err.message).toBe("Invalid authentication credentials");
        client.close();
        done();
      });
    });

    it("MUST accept connection with valid worker access token and auto-join worker personal room", (done) => {
      const validToken = signAccessToken({
        id: MOCK_WORKER_A_ID,
        role: UserRole.WORKER,
      });
      const client = createClientSocket(validToken);

      client.on("connect", () => {
        // Assert socket is authenticated and joined its own room
        const serverSocket = io.sockets.sockets.get(client.id!);
        expect(serverSocket).toBeDefined();
        expect(serverSocket?.data.user.id).toBe(MOCK_WORKER_A_ID);
        expect(serverSocket?.data.user.role).toBe(UserRole.WORKER);
        expect(serverSocket?.rooms.has(`worker:${MOCK_WORKER_A_ID}`)).toBe(true);

        client.close();
        done();
      });

      client.on("connect_error", (err) => {
        client.close();
        done(err);
      });
    });

    it("MUST accept connection with valid customer access token and auto-join customer personal room", (done) => {
      const validToken = signAccessToken({
        id: MOCK_CUSTOMER_A_ID,
        role: UserRole.CUSTOMER,
      });
      const client = createClientSocket(validToken);

      client.on("connect", () => {
        const serverSocket = io.sockets.sockets.get(client.id!);
        expect(serverSocket).toBeDefined();
        expect(serverSocket?.data.user.id).toBe(MOCK_CUSTOMER_A_ID);
        expect(serverSocket?.data.user.role).toBe(UserRole.CUSTOMER);
        expect(serverSocket?.rooms.has(`customer:${MOCK_CUSTOMER_A_ID}`)).toBe(true);

        client.close();
        done();
      });
    });

    it("MUST accept connection with valid admin access token", (done) => {
      const validToken = signAccessToken({
        id: MOCK_ADMIN_ID,
        role: UserRole.ADMIN,
      });
      const client = createClientSocket(validToken);

      client.on("connect", () => {
        const serverSocket = io.sockets.sockets.get(client.id!);
        expect(serverSocket?.data.user.role).toBe(UserRole.ADMIN);
        expect(serverSocket?.rooms.has(`admin:${MOCK_ADMIN_ID}`)).toBe(true);

        client.close();
        done();
      });
    });
  });

  // ==========================================================================
  // Invariant 2: Room Isolation & Identity Spoofing Prevention
  // ==========================================================================
  describe("Invariant 2: Room Isolation & Identity Spoofing", () => {
    it("MUST reject Worker A attempting to join Worker B's room (join:worker)", (done) => {
      const workerAToken = signAccessToken({
        id: MOCK_WORKER_A_ID,
        role: UserRole.WORKER,
      });
      const client = createClientSocket(workerAToken);

      client.on("connect", () => {
        client.emit("join:worker", MOCK_WORKER_B_ID, (res: any) => {
          expect(res.success).toBe(false);
          expect(res.code).toBe("FORBIDDEN");
          expect(res.message).toBe("Forbidden: Cannot join another worker's room");

          // Assert Worker A is NOT in Worker B's room
          const serverSocket = io.sockets.sockets.get(client.id!);
          expect(serverSocket?.rooms.has(`worker:${MOCK_WORKER_B_ID}`)).toBe(false);

          client.close();
          done();
        });
      });
    });

    it("MUST reject Customer A attempting to join Customer B's room (join:customer)", (done) => {
      const customerAToken = signAccessToken({
        id: MOCK_CUSTOMER_A_ID,
        role: UserRole.CUSTOMER,
      });
      const client = createClientSocket(customerAToken);

      client.on("connect", () => {
        client.emit("join:customer", MOCK_CUSTOMER_B_ID, (res: any) => {
          expect(res.success).toBe(false);
          expect(res.code).toBe("FORBIDDEN");
          expect(res.message).toBe("Forbidden: Cannot join another customer's room");

          const serverSocket = io.sockets.sockets.get(client.id!);
          expect(serverSocket?.rooms.has(`customer:${MOCK_CUSTOMER_B_ID}`)).toBe(false);

          client.close();
          done();
        });
      });
    });

    it("MUST reject a Customer attempting to call join:worker (Role Violation)", (done) => {
      const customerToken = signAccessToken({
        id: MOCK_CUSTOMER_A_ID,
        role: UserRole.CUSTOMER,
      });
      const client = createClientSocket(customerToken);

      client.on("connect", () => {
        client.emit("join:worker", MOCK_CUSTOMER_A_ID, (res: any) => {
          expect(res.success).toBe(false);
          expect(res.code).toBe("FORBIDDEN");
          expect(res.message).toBe("Forbidden: Worker role required");

          client.close();
          done();
        });
      });
    });

    it("MUST reject a Worker attempting to call join:customer (Role Violation)", (done) => {
      const workerToken = signAccessToken({
        id: MOCK_WORKER_A_ID,
        role: UserRole.WORKER,
      });
      const client = createClientSocket(workerToken);

      client.on("connect", () => {
        client.emit("join:customer", MOCK_WORKER_A_ID, (res: any) => {
          expect(res.success).toBe(false);
          expect(res.code).toBe("FORBIDDEN");
          expect(res.message).toBe("Forbidden: Customer role required");

          client.close();
          done();
        });
      });
    });
  });

  // ==========================================================================
  // Invariant 3: Location Spoofing & Recipient Authorization
  // ==========================================================================
  describe("Invariant 3: Worker Location Updates & Spoofing Defense", () => {
    it("MUST reject location update if non-worker (Customer) attempts to emit worker:location_update", (done) => {
      const customerToken = signAccessToken({
        id: MOCK_CUSTOMER_A_ID,
        role: UserRole.CUSTOMER,
      });
      const client = createClientSocket(customerToken);

      client.on("connect", () => {
        client.emit(
          "worker:location_update",
          { customerId: MOCK_CUSTOMER_B_ID, lat: 26.8467, lng: 80.9462 },
          (res: any) => {
            expect(res.success).toBe(false);
            expect(res.code).toBe("FORBIDDEN");
            expect(res.message).toContain("Only workers can broadcast location updates");

            client.close();
            done();
          }
        );
      });
    });

    it("MUST reject location update if Worker A attempts to spoof Worker B's identity (payload.workerId = Worker B)", (done) => {
      const workerAToken = signAccessToken({
        id: MOCK_WORKER_A_ID,
        role: UserRole.WORKER,
      });
      const client = createClientSocket(workerAToken);

      client.on("connect", () => {
        client.emit(
          "worker:location_update",
          {
            workerId: MOCK_WORKER_B_ID, // Attempted spoof
            customerId: MOCK_CUSTOMER_B_ID,
            lat: 26.8467,
            lng: 80.9462,
          },
          (res: any) => {
            expect(res.success).toBe(false);
            expect(res.code).toBe("FORBIDDEN");
            expect(res.message).toBe("Forbidden: Cannot spoof worker identity");

            client.close();
            done();
          }
        );
      });
    });

    it("MUST reject location update if Worker A is NOT assigned to target customer", (done) => {
      const workerAToken = signAccessToken({
        id: MOCK_WORKER_A_ID,
        role: UserRole.WORKER,
      });
      const client = createClientSocket(workerAToken);

      client.on("connect", () => {
        client.emit(
          "worker:location_update",
          {
            customerId: MOCK_CUSTOMER_B_ID, // Worker A is not assigned to Customer B
            lat: 26.8467,
            lng: 80.9462,
          },
          (res: any) => {
            expect(res.success).toBe(false);
            expect(res.code).toBe("FORBIDDEN");
            expect(res.message).toBe("Forbidden: Not assigned to this customer");

            client.close();
            done();
          }
        );
      });
    });

    it("MUST deliver location update with authoritative worker identity when Worker B is assigned to Customer B", async () => {
      const workerBToken = signAccessToken({
        id: MOCK_WORKER_B_ID,
        role: UserRole.WORKER,
      });
      const customerBToken = signAccessToken({
        id: MOCK_CUSTOMER_B_ID,
        role: UserRole.CUSTOMER,
      });

      const customerClient = await connectClient(customerBToken);
      const workerClient = await connectClient(workerBToken);

      const locationPromise = new Promise<void>((resolve) => {
        customerClient.on("worker:location", (data: any) => {
          expect(data.workerId).toBe(MOCK_WORKER_B_ID); // Strictly authoritative
          expect(data.lat).toBe(26.85);
          expect(data.lng).toBe(80.95);
          resolve();
        });
      });

      const ackPromise = new Promise<void>((resolve, reject) => {
        workerClient.emit(
          "worker:location_update",
          {
            customerId: MOCK_CUSTOMER_B_ID,
            lat: 26.85,
            lng: 80.95,
          },
          (res: any) => {
            if (res?.success) resolve();
            else reject(new Error(res?.message || "Location update failed"));
          }
        );
      });

      await Promise.all([locationPromise, ackPromise]);

      customerClient.close();
      workerClient.close();
    });
  });

  // ==========================================================================
  // Invariant 4: Booking & Chat Room Authorization
  // ==========================================================================
  describe("Invariant 4: Booking & Chat Room Authorization", () => {
    it("MUST reject unauthorized Customer A attempting to join Booking B room", (done) => {
      const customerAToken = signAccessToken({
        id: MOCK_CUSTOMER_A_ID,
        role: UserRole.CUSTOMER,
      });
      const client = createClientSocket(customerAToken);

      client.on("connect", () => {
        client.emit("join:booking", { bookingId: MOCK_BOOKING_B_ID }, (res: any) => {
          expect(res.success).toBe(false);
          expect(res.code).toBe("FORBIDDEN");
          expect(res.message).toBe("Forbidden: Not an authorized participant of this booking");

          const serverSocket = io.sockets.sockets.get(client.id!);
          expect(serverSocket?.rooms.has(`booking:${MOCK_BOOKING_B_ID}`)).toBe(false);

          client.close();
          done();
        });
      });
    });

    it("MUST reject unauthorized Worker A attempting to join Booking B room", (done) => {
      const workerAToken = signAccessToken({
        id: MOCK_WORKER_A_ID,
        role: UserRole.WORKER,
      });
      const client = createClientSocket(workerAToken);

      client.on("connect", () => {
        client.emit("join:booking", { bookingId: MOCK_BOOKING_B_ID }, (res: any) => {
          expect(res.success).toBe(false);
          expect(res.code).toBe("FORBIDDEN");
          expect(res.message).toBe("Forbidden: Not an authorized participant of this booking");

          const serverSocket = io.sockets.sockets.get(client.id!);
          expect(serverSocket?.rooms.has(`booking:${MOCK_BOOKING_B_ID}`)).toBe(false);

          client.close();
          done();
        });
      });
    });

    it("MUST allow authorized participant (Customer B) to join Booking B room", (done) => {
      const customerBToken = signAccessToken({
        id: MOCK_CUSTOMER_B_ID,
        role: UserRole.CUSTOMER,
      });
      const client = createClientSocket(customerBToken);

      client.on("connect", () => {
        client.emit("join:booking", { bookingId: MOCK_BOOKING_B_ID }, (res: any) => {
          expect(res.success).toBe(true);

          const serverSocket = io.sockets.sockets.get(client.id!);
          expect(serverSocket?.rooms.has(`booking:${MOCK_BOOKING_B_ID}`)).toBe(true);

          client.close();
          done();
        });
      });
    });

    it("MUST allow authorized participant (Worker B) to join Booking B room", (done) => {
      const workerBToken = signAccessToken({
        id: MOCK_WORKER_B_ID,
        role: UserRole.WORKER,
      });
      const client = createClientSocket(workerBToken);

      client.on("connect", () => {
        client.emit("join:booking", { bookingId: MOCK_BOOKING_B_ID }, (res: any) => {
          expect(res.success).toBe(true);

          const serverSocket = io.sockets.sockets.get(client.id!);
          expect(serverSocket?.rooms.has(`booking:${MOCK_BOOKING_B_ID}`)).toBe(true);

          client.close();
          done();
        });
      });
    });

    it("MUST reject unauthorized user attempting to send chat message on Booking B", (done) => {
      const unauthorizedClient = createClientSocket(
        signAccessToken({ id: MOCK_CUSTOMER_A_ID, role: UserRole.CUSTOMER })
      );

      unauthorizedClient.on("connect", () => {
        unauthorizedClient.emit(
          "chat:message",
          { bookingId: MOCK_BOOKING_B_ID, content: "Hello from intruder" },
          (res: any) => {
            expect(res.success).toBe(false);
            expect(res.code).toBe("FORBIDDEN");

            unauthorizedClient.close();
            done();
          }
        );
      });
    });

    it("MUST deliver chat message using authoritative sender identity when authorized participant sends message", async () => {
      const customerBToken = signAccessToken({ id: MOCK_CUSTOMER_B_ID, role: UserRole.CUSTOMER });
      const workerBToken = signAccessToken({ id: MOCK_WORKER_B_ID, role: UserRole.WORKER });

      const customerClient = await connectClient(customerBToken);
      const workerClient = await connectClient(workerBToken);

      await new Promise<void>((resolve) => {
        customerClient.emit("join:booking", { bookingId: MOCK_BOOKING_B_ID }, () => resolve());
      });
      await new Promise<void>((resolve) => {
        workerClient.emit("join:booking", { bookingId: MOCK_BOOKING_B_ID }, () => resolve());
      });

      const messagePromise = new Promise<void>((resolve) => {
        workerClient.on("chat:message", (msg: any) => {
          expect(msg.content).toBe("Hello Worker B!");
          expect(msg.sender_id).toBe(MOCK_CUSTOMER_B_ID); // Strictly authoritative sender
          resolve();
        });
      });

      await new Promise<void>((resolve, reject) => {
        customerClient.emit(
          "chat:message",
          { bookingId: MOCK_BOOKING_B_ID, content: "Hello Worker B!" },
          (res: any) => {
            if (res?.success) resolve();
            else reject(new Error(res?.message || "Chat send failed"));
          }
        );
      });

      await messagePromise;

      customerClient.close();
      workerClient.close();
    });
  });
});
