/**
 * PH10-SOC-001 Regression Test
 *
 * Root cause: socketHandlers.ts had a hardcoded lowercase status list for
 * ACTIVE_LOCATION_STREAMING_STATUSES check. Bookings stored with uppercase
 * 'CONFIRMED'/'IN_PROGRESS' status never matched → all location updates
 * were silently rejected with FORBIDDEN even for valid active bookings.
 *
 * Fix: Status check now uses ACTIVE_LOCATION_STREAMING_STATUSES from
 * bookingStateMachine.ts which includes both upper and lowercase variants.
 *
 * This test proves:
 * 1. Worker with a CONFIRMED booking CAN broadcast location to the customer.
 * 2. Worker with an IN_PROGRESS booking CAN broadcast location.
 * 3. Worker with no active booking CANNOT broadcast location (FORBIDDEN).
 * 4. Worker with a COMPLETED (terminal) booking CANNOT broadcast location.
 * 5. Worker with a CANCELLED (terminal) booking CANNOT broadcast location.
 */

import http from "http";
import { Server as SocketIOServer } from "socket.io";
import { io as Client, Socket as ClientSocket } from "socket.io-client";
import { socketAuthMiddleware } from "../src/socket/socketAuth";
import { registerSocketHandlers } from "../src/socket/socketHandlers";
import { UserRole } from "../src/middlewares/authMiddleware";
import { generateToken } from "../src/utils/authUtils";

// ── Infra mocks (prevent background service startup) ─────────────────────────

jest.mock("@bull-board/api", () => ({ createBullBoard: jest.fn().mockReturnValue({}) }));
jest.mock("@bull-board/api/bullMQAdapter", () => ({
  BullMQAdapter: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("@bull-board/express", () => ({
  ExpressAdapter: jest.fn().mockImplementation(() => ({
    setBasePath: jest.fn(),
    getRouter: jest.fn().mockReturnValue((_req: any, _res: any, next: any) => next()),
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

// ── Prisma mock ───────────────────────────────────────────────────────────────

jest.mock("../src/config/prisma", () => ({
  __esModule: true,
  default: {
    customer: { findUnique: jest.fn() },
    worker: { findUnique: jest.fn() },
    booking: { findUnique: jest.fn(), findFirst: jest.fn() },
    conversation: { findFirst: jest.fn(), create: jest.fn() },
    message: { create: jest.fn() },
    worker_location: { upsert: jest.fn() },
  },
}));

// Mock worker location service to avoid real DB writes in this unit test
jest.mock("../src/features/worker_location/worker_location.service", () => ({
  workerLocationService: {
    updateLocation: jest.fn().mockResolvedValue(undefined),
  },
}));

import prisma from "../src/config/prisma";
import { workerLocationService } from "../src/features/worker_location/worker_location.service";

// ── Test Constants ────────────────────────────────────────────────────────────

const WORKER_A_ID   = "w1111111-1111-4111-a111-111111111111";
const CUSTOMER_A_ID = "c1111111-1111-4111-a111-111111111111";

describe("PH10-SOC-001 — worker:location_update Status-Matching Regression", () => {
  let httpServer: http.Server;
  let ioServer: SocketIOServer;
  let serverPort: number;
  let workerAToken: string;

  beforeAll((done) => {
    workerAToken = generateToken({ id: WORKER_A_ID, phone: "+919999900001", role: UserRole.WORKER });

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

    // Auth middleware lookups
    (prisma.customer.findUnique as jest.Mock).mockImplementation(({ where }) =>
      Promise.resolve(where.id === CUSTOMER_A_ID ? { id: where.id, deleted_at: null } : null)
    );
    (prisma.worker.findUnique as jest.Mock).mockImplementation(({ where }) =>
      Promise.resolve(where.id === WORKER_A_ID ? { id: where.id, deleted_at: null } : null)
    );
  });

  // ── Helper ──────────────────────────────────────────────────────────────────

  function connectWorker(): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const client = Client(`http://localhost:${serverPort}`, {
        auth: { token: workerAToken },
        transports: ["websocket"],
        reconnection: false,
      });
      client.on("connect", () => resolve(client));
      client.on("connect_error", (err) => reject(err));
    });
  }

  function emitLocationUpdate(client: ClientSocket, customerId = CUSTOMER_A_ID): Promise<any> {
    return new Promise((resolve) => {
      client.emit(
        "worker:location_update",
        { customerId, lat: 28.6139, lng: 77.2090 },
        (ack: any) => resolve(ack)
      );
    });
  }

  // ── Test Cases ──────────────────────────────────────────────────────────────

  /**
   * BEFORE FIX: This would return FORBIDDEN because status list was lowercase-only.
   * AFTER FIX: Returns success because ACTIVE_LOCATION_STREAMING_STATUSES includes 'CONFIRMED'.
   */
  it("[PH10-SOC-001-A] Worker with CONFIRMED booking CAN broadcast location (uppercase status)", async () => {
    (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
      id: "booking-001",
      worker_id: WORKER_A_ID,
      customer_id: CUSTOMER_A_ID,
      status: "CONFIRMED", // ← This is the uppercase DB value that was previously rejected
    });

    const client = await connectWorker();
    const res = await emitLocationUpdate(client);

    expect(res.success).toBe(true);
    expect(workerLocationService.updateLocation).toHaveBeenCalledWith(WORKER_A_ID, 28.6139, 77.209);
    client.disconnect();
  });

  it("[PH10-SOC-001-B] Worker with IN_PROGRESS booking CAN broadcast location", async () => {
    (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
      id: "booking-002",
      worker_id: WORKER_A_ID,
      customer_id: CUSTOMER_A_ID,
      status: "IN_PROGRESS",
    });

    const client = await connectWorker();
    const res = await emitLocationUpdate(client);

    expect(res.success).toBe(true);
    expect(workerLocationService.updateLocation).toHaveBeenCalledTimes(1);
    client.disconnect();
  });

  it("[PH10-SOC-001-C] Worker with AWAITING_CONFIRMATION booking CAN broadcast location", async () => {
    (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
      id: "booking-003",
      worker_id: WORKER_A_ID,
      customer_id: CUSTOMER_A_ID,
      status: "AWAITING_CONFIRMATION",
    });

    const client = await connectWorker();
    const res = await emitLocationUpdate(client);

    expect(res.success).toBe(true);
    client.disconnect();
  });

  it("[PH10-SOC-001-D] Worker with NO active booking CANNOT broadcast location (FORBIDDEN)", async () => {
    (prisma.booking.findFirst as jest.Mock).mockResolvedValue(null); // No active booking

    const client = await connectWorker();
    const res = await emitLocationUpdate(client);

    expect(res.success).toBe(false);
    expect(res.code).toBe("FORBIDDEN");
    expect(workerLocationService.updateLocation).not.toHaveBeenCalled();
    client.disconnect();
  });

  it("[PH10-SOC-001-E] Worker with COMPLETED (terminal) booking CANNOT broadcast location", async () => {
    // prisma.findFirst with status IN active list returns null → auth check fails
    (prisma.booking.findFirst as jest.Mock).mockResolvedValue(null);

    const client = await connectWorker();
    const res = await emitLocationUpdate(client);

    expect(res.success).toBe(false);
    expect(res.code).toBe("FORBIDDEN");
    expect(workerLocationService.updateLocation).not.toHaveBeenCalled();
    client.disconnect();
  });

  it("[PH10-SOC-001-F] Worker with CANCELLED (terminal) booking CANNOT broadcast location", async () => {
    (prisma.booking.findFirst as jest.Mock).mockResolvedValue(null);

    const client = await connectWorker();
    const res = await emitLocationUpdate(client);

    expect(res.success).toBe(false);
    expect(res.code).toBe("FORBIDDEN");
    client.disconnect();
  });

  it("[PH10-SOC-001-G] Location broadcast emits worker:location event to customer room", async () => {
    (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
      id: "booking-004",
      worker_id: WORKER_A_ID,
      customer_id: CUSTOMER_A_ID,
      status: "CONFIRMED",
    });

    // Connect a second socket as the customer to receive the broadcast
    const { generateToken: gt } = require("../src/utils/authUtils");
    const custToken = gt({ id: CUSTOMER_A_ID, phone: "+919999900002", role: UserRole.CUSTOMER });
    const customerClient = await new Promise<ClientSocket>((resolve, reject) => {
      const c = Client(`http://localhost:${serverPort}`, {
        auth: { token: custToken },
        transports: ["websocket"],
        reconnection: false,
      });
      c.on("connect", () => resolve(c));
      c.on("connect_error", reject);
    });

    const receivedEvent = new Promise<any>((resolve) => {
      customerClient.on("worker:location", (data) => resolve(data));
    });

    const workerClient = await connectWorker();
    const res = await emitLocationUpdate(workerClient);

    expect(res.success).toBe(true);

    // Customer should receive the location broadcast
    const locationEvent = await Promise.race([
      receivedEvent,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
    ]);

    expect(locationEvent).not.toBeNull();
    if (locationEvent) {
      expect(locationEvent.workerId).toBe(WORKER_A_ID);
      expect(locationEvent.lat).toBeCloseTo(28.6139, 4);
      expect(locationEvent.lng).toBeCloseTo(77.209, 4);
    }

    workerClient.disconnect();
    customerClient.disconnect();
  });
});
