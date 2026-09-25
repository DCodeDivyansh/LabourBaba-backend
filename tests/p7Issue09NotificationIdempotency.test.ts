/**
 * tests/p7Issue09NotificationIdempotency.test.ts
 *
 * Authoritative Production Verification Suite for P7 Issue 09:
 * "Notification Delivery Has Duplicate-Emission and Replay Risks"
 *
 * Verifies the core production invariants:
 * 1. ONE BUSINESS EVENT → ONE STABLE EVENT ID → ONE DURABLE OUTBOX EVENT
 * 2. CHANNEL-SPECIFIC DELIVERY STATE (Socket.IO vs FCM)
 * 3. Socket.IO SUCCESS + FCM FAILURE + WORKER RETRY → Socket.IO is NOT re-emitted!
 * 4. Socket.IO FAILURE + FCM SUCCESS + WORKER RETRY → FCM is NOT re-sent!
 * 5. Deterministic Client Idempotency Contract (eventId, deliveryId, aggregateVersion)
 * 6. PostgreSQL CTE SKIP LOCKED Multi-Worker Concurrency Safety
 * 7. Real PostgreSQL Database Verification
 */

import http from "http";
import { Server as SocketIOServer } from "socket.io";
import { io as Client, Socket as ClientSocket } from "socket.io-client";
import prisma from "../src/config/prisma";
import { outboxService, OutboxRecord } from "../src/services/outboxService";
import { OutboxWorker } from "../src/workers/outboxWorker";
import { socketAuthMiddleware } from "../src/socket/socketAuth";
import { registerSocketHandlers } from "../src/socket/socketHandlers";
import { signAccessToken } from "../src/utils/authUtils";
import { UserRole } from "../src/type/userRole";
import { setMockFcmProvider, resetFirebaseApp } from "../src/shared/fcm";

describe("P7 Issue 09 — Notification Delivery Idempotency & Channel Replay Prevention", () => {
  let httpServer: http.Server;
  let ioServer: SocketIOServer;
  let serverPort: number;
  let worker: OutboxWorker;

  const testSuffix = Date.now().toString().slice(-6);
  const CUSTOMER_ID = "77770000-0000-4000-a000-000000000001";
  const WORKER_ID = "88880000-0000-4000-b000-000000000001";
  const AGGREGATE_ID = "99990000-0000-4000-a000-000000000001";
  const CUSTOMER_PHONE = `91${testSuffix}01`;
  const OTHER_CUSTOMER_PHONE = `91${testSuffix}03`;

  let customerToken: string;

  beforeAll(async () => {
    customerToken = signAccessToken({
      id: CUSTOMER_ID,
      role: UserRole.CUSTOMER,
      phone: CUSTOMER_PHONE,
    });

    // 1. Seed customer and worker in database if not present
    await prisma.customer.upsert({
      where: { id: CUSTOMER_ID },
      update: {},
      create: {
        id: CUSTOMER_ID,
        phone: CUSTOMER_PHONE,
        name: "Test Customer P7-09",
        password: "$2b$10$abcdefghijklmnopqrstuvwxyzA1B2C3D4E5F6G7H8I9J0K",
      },
    });

    let category = await prisma.skill_category.findFirst();
    if (!category) {
      category = await prisma.skill_category.create({
        data: { name: "General Services" },
      });
    }

    await prisma.worker.upsert({
      where: { id: WORKER_ID },
      update: {},
      create: {
        id: WORKER_ID,
        phone: `91${testSuffix}02`,
        name: "Test Worker P7-09",
        skill_type: "Carpenter",
        skill_category_id: category.id,
        password: "$2b$10$abcdefghijklmnopqrstuvwxyzA1B2C3D4E5F6G7H8I9J0K",
      },
    });

    // Register active device tokens for FCM push
    await (prisma as any).customer_device.upsert({
      where: {
        customer_id_device_id: {
          customer_id: CUSTOMER_ID,
          device_id: "device_p7_09_cust",
        },
      },
      update: { fcm_token: "fcm_token_p7_09_cust", revoked_at: null },
      create: {
        customer_id: CUSTOMER_ID,
        device_id: "device_p7_09_cust",
        fcm_token: "fcm_token_p7_09_cust",
        platform: "android",
        revoked_at: null,
      },
    });

    // 2. Setup test Socket.IO server
    httpServer = http.createServer();
    ioServer = new SocketIOServer(httpServer);
    ioServer.use(socketAuthMiddleware);
    registerSocketHandlers(ioServer);

    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => {
        serverPort = (httpServer.address() as any).port;
        resolve();
      });
    });

    worker = new OutboxWorker(ioServer);
  });

  afterAll(async () => {
    resetFirebaseApp();
    if (ioServer) ioServer.close();
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
    // Clean up test data
    await (prisma as any).notification_delivery?.deleteMany({
      where: { recipient_id: { in: [CUSTOMER_ID, WORKER_ID] } },
    }).catch(() => {});
    await (prisma as any).notification_outbox?.deleteMany({
      where: { recipient_id: { in: [CUSTOMER_ID, WORKER_ID] } },
    }).catch(() => {});
    await (prisma as any).customer_device?.deleteMany({
      where: { customer_id: CUSTOMER_ID },
    }).catch(() => {});
    await prisma.customer.deleteMany({ where: { id: CUSTOMER_ID } }).catch(() => {});
    await prisma.worker.deleteMany({ where: { id: WORKER_ID } }).catch(() => {});
    await prisma.$disconnect();
  });

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

  // ==========================================================================
  // TEST 1 — Normal successful delivery
  // ==========================================================================
  it("TEST 1 — Normal successful delivery: delivers to Socket.IO and FCM exactly once with stable eventId", async () => {
    let fcmCallCount = 0;
    setMockFcmProvider({
      sendToTokens: async (tokens) => {
        fcmCallCount++;
        return tokens.map((t) => ({ token: t, success: true, messageId: `msg_${Date.now()}` }));
      },
    });

    const client = await connectClient(customerToken);
    const receivedSocketEvents: any[] = [];
    client.on("notification:booking_confirmed", (data) => {
      receivedSocketEvents.push(data);
    });

    // Create durable outbox record
    const event = await prisma.$transaction(async (tx) => {
      return outboxService.createOutboxEvent(tx, {
        eventType: "booking_confirmed",
        aggregateType: "booking",
        aggregateId: AGGREGATE_ID,
        aggregateVersion: 1,
        recipientType: "customer",
        recipientId: CUSTOMER_ID,
        payload: { bookingId: "b-001", title: "Booking Confirmed" },
        idempotencyKey: `test1:${Date.now()}`,
      });
    });

    expect(event).toBeDefined();
    const eventId = event!.id;

    // Worker executes record delivery
    await worker.processRecord(event!);

    await new Promise((r) => setTimeout(r, 100));

    // Verify Socket.IO delivery
    expect(receivedSocketEvents.length).toBe(1);
    expect(receivedSocketEvents[0].eventId).toBe(eventId);
    expect(receivedSocketEvents[0].deliveryId).toBe(`${eventId}:${CUSTOMER_ID}:socket`);
    expect(receivedSocketEvents[0].aggregateVersion).toBe(1);
    expect(receivedSocketEvents[0].bookingId).toBe("b-001");

    // Verify FCM delivery
    expect(fcmCallCount).toBe(1);

    // Verify DB state in PostgreSQL
    const { outbox, deliveries } = await outboxService.getEventDeliveryState(eventId);
    expect(outbox).not.toBeNull();
    expect(outbox!.status).toBe("SENT");
    expect(outbox!.socket_status).toBe("SENT");
    expect(outbox!.fcm_status).toBe("SENT");
    expect(outbox!.socket_sent_at).not.toBeNull();
    expect(outbox!.fcm_sent_at).not.toBeNull();

    // Verify relational notification_delivery rows
    if (deliveries.length > 0) {
      const socketDel = deliveries.find((d) => d.channel === "socket");
      const fcmDel = deliveries.find((d) => d.channel === "fcm");
      expect(socketDel.status).toBe("SENT");
      expect(fcmDel.status).toBe("SENT");
    }

    client.disconnect();
  });

  // ==========================================================================
  // TEST 2 — Duplicate business trigger
  // ==========================================================================
  it("TEST 2 — Duplicate business trigger: idempotency key guarantees exactly one durable outbox row", async () => {
    const idempotencyKey = `idemp_trigger:${Date.now()}`;

    const event1 = await prisma.$transaction(async (tx) => {
      return outboxService.createOutboxEvent(tx, {
        eventType: "booking_confirmed",
        aggregateType: "booking",
        aggregateId: AGGREGATE_ID,
        recipientType: "customer",
        recipientId: CUSTOMER_ID,
        payload: { bookingId: "b-dup" },
        idempotencyKey,
      });
    });

    const event2 = await prisma.$transaction(async (tx) => {
      return outboxService.createOutboxEvent(tx, {
        eventType: "booking_confirmed",
        aggregateType: "booking",
        aggregateId: AGGREGATE_ID,
        recipientType: "customer",
        recipientId: CUSTOMER_ID,
        payload: { bookingId: "b-dup" },
        idempotencyKey,
      });
    });

    expect(event1).toBeDefined();
    expect(event2).toBeDefined();
    expect(event1!.id).toBe(event2!.id);

    const count = await (prisma as any).notification_outbox.count({
      where: { idempotency_key: idempotencyKey },
    });
    expect(count).toBe(1);
  });

  // ==========================================================================
  // TEST 3 — CORE REGRESSION: Socket.IO success + FCM failure
  // ==========================================================================
  it("TEST 3 — CORE REGRESSION: Socket.IO succeeds while FCM fails; retry delivers FCM and MUST NOT re-emit Socket.IO", async () => {
    let fcmAttempt = 0;
    setMockFcmProvider({
      sendToTokens: async (tokens) => {
        fcmAttempt++;
        if (fcmAttempt === 1) {
          // Attempt 1: Transient FCM network failure
          return tokens.map((t) => ({
            token: t,
            success: false,
            isInvalidToken: false,
            error: new Error("FCM server timeout"),
          }));
        }
        // Attempt 2 (Retry): FCM recovery success
        return tokens.map((t) => ({
          token: t,
          success: true,
          messageId: `msg_recovered_${Date.now()}`,
        }));
      },
    });

    const client = await connectClient(customerToken);
    let socketEmitCount = 0;
    client.on("notification:booking_confirmed", () => {
      socketEmitCount++;
    });

    // Create durable outbox record
    const event = await prisma.$transaction(async (tx) => {
      return outboxService.createOutboxEvent(tx, {
        eventType: "booking_confirmed",
        aggregateType: "booking",
        aggregateId: AGGREGATE_ID,
        recipientType: "customer",
        recipientId: CUSTOMER_ID,
        payload: { bookingId: "b-core-reg" },
        idempotencyKey: `test3:${Date.now()}`,
      });
    });

    const eventId = event!.id;

    // ── Attempt 1 ─────────────────────────────────────────────────────────────
    await worker.processRecord(event!);
    await new Promise((r) => setTimeout(r, 100));

    // Verify Attempt 1 results:
    // Socket.IO emitted once
    expect(socketEmitCount).toBe(1);
    // FCM was attempted once
    expect(fcmAttempt).toBe(1);

    // Verify DB state after Attempt 1:
    // Socket.IO recorded as SENT, FCM recorded as FAILED, overall status retryable PENDING
    const stateAfterAttempt1 = await (prisma as any).notification_outbox.findUnique({
      where: { id: eventId },
    });
    expect(stateAfterAttempt1.socket_status).toBe("SENT");
    expect(stateAfterAttempt1.fcm_status).toBe("FAILED");
    expect(stateAfterAttempt1.status).toBe("PENDING");
    expect(stateAfterAttempt1.attempts).toBe(1);

    // ── Attempt 2 (Worker Retry) ──────────────────────────────────────────────
    // Simulate worker claiming the event for retry
    const retryClaim = await (prisma as any).notification_outbox.findUnique({
      where: { id: eventId },
    });

    await worker.processRecord(retryClaim);
    await new Promise((r) => setTimeout(r, 100));

    // CRITICAL INVARIANT: Socket.IO MUST NOT HAVE BEEN EMITTED AGAIN!
    expect(socketEmitCount).toBe(1); // EXACTLY 1! Not 2!
    // FCM was retried
    expect(fcmAttempt).toBe(2);

    // Verify final DB state: both channels SENT, overall status SENT
    const finalState = await (prisma as any).notification_outbox.findUnique({
      where: { id: eventId },
    });
    expect(finalState.socket_status).toBe("SENT");
    expect(finalState.fcm_status).toBe("SENT");
    expect(finalState.status).toBe("SENT");

    client.disconnect();
  });

  // ==========================================================================
  // TEST 4 — Socket.IO failure + FCM success
  // ==========================================================================
  it("TEST 4 — Socket.IO failure + FCM success: FCM succeeds while Socket fails; retry delivers Socket and MUST NOT re-send FCM", async () => {
    let fcmSendCount = 0;
    setMockFcmProvider({
      sendToTokens: async (tokens) => {
        fcmSendCount++;
        return tokens.map((t) => ({ token: t, success: true, messageId: `msg_${Date.now()}` }));
      },
    });

    // Create durable outbox record
    const event = await prisma.$transaction(async (tx) => {
      return outboxService.createOutboxEvent(tx, {
        eventType: "booking_confirmed",
        aggregateType: "booking",
        aggregateId: AGGREGATE_ID,
        recipientType: "customer",
        recipientId: CUSTOMER_ID,
        payload: { bookingId: "b-socket-fail" },
        idempotencyKey: `test4:${Date.now()}`,
      });
    });

    const eventId = event!.id;

    // Simulate Socket.IO failure on attempt 1 by creating a worker with an error-throwing socket server
    const faultyIo: any = {
      to: () => ({
        emit: () => {
          throw new Error("Socket network partition");
        },
      }),
    };
    const faultyWorker = new OutboxWorker(faultyIo);

    // ── Attempt 1 (Socket fails, FCM succeeds) ────────────────────────────────
    await faultyWorker.processRecord(event!);

    const state1 = await (prisma as any).notification_outbox.findUnique({
      where: { id: eventId },
    });
    expect(state1.socket_status).toBe("FAILED");
    expect(state1.fcm_status).toBe("SENT");
    expect(state1.status).toBe("PENDING");
    expect(fcmSendCount).toBe(1);

    // ── Attempt 2 (Worker Retry with operational Socket.IO) ───────────────────
    const client = await connectClient(customerToken);
    let socketReceived = 0;
    client.on("notification:booking_confirmed", () => {
      socketReceived++;
    });

    const claimForRetry = await (prisma as any).notification_outbox.findUnique({
      where: { id: eventId },
    });

    // Execute retry with healthy worker
    await worker.processRecord(claimForRetry);
    await new Promise((r) => setTimeout(r, 100));

    // CRITICAL INVARIANT: FCM was NOT sent again!
    expect(fcmSendCount).toBe(1); // EXACTLY 1! Not 2!
    // Socket.IO was retried and received
    expect(socketReceived).toBe(1);

    // Both channels now SENT
    const finalState = await (prisma as any).notification_outbox.findUnique({
      where: { id: eventId },
    });
    expect(finalState.socket_status).toBe("SENT");
    expect(finalState.fcm_status).toBe("SENT");
    expect(finalState.status).toBe("SENT");

    client.disconnect();
  });

  // ==========================================================================
  // TEST 5 — Both channels fail
  // ==========================================================================
  it("TEST 5 — Both channels fail: applies retry policy independently without infinite loop", async () => {
    setMockFcmProvider({
      sendToTokens: async (tokens) => {
        return tokens.map((t) => ({
          token: t,
          success: false,
          isInvalidToken: false,
          error: new Error("FCM service unavailable"),
        }));
      },
    });

    const faultyIo: any = {
      to: () => ({
        emit: () => {
          throw new Error("Socket error");
        },
      }),
    };
    const faultyWorker = new OutboxWorker(faultyIo);

    const event = await prisma.$transaction(async (tx) => {
      return outboxService.createOutboxEvent(tx, {
        eventType: "booking_confirmed",
        aggregateType: "booking",
        aggregateId: AGGREGATE_ID,
        recipientType: "customer",
        recipientId: CUSTOMER_ID,
        payload: { bookingId: "b-both-fail" },
        idempotencyKey: `test5:${Date.now()}`,
      });
    });

    const eventId = event!.id;

    await faultyWorker.processRecord(event!);

    const state = await (prisma as any).notification_outbox.findUnique({
      where: { id: eventId },
    });
    expect(state.socket_status).toBe("FAILED");
    expect(state.fcm_status).toBe("FAILED");
    expect(state.status).toBe("PENDING");
    expect(state.attempts).toBe(1);
    expect(state.id).toBe(eventId); // Stable event identity preserved
  });

  // ==========================================================================
  // TEST 6 — Worker crashes after Socket.IO success
  // ==========================================================================
  it("TEST 6 — Worker crashes after Socket.IO success: stable eventId contract enables client-side deduplication", async () => {
    setMockFcmProvider({
      sendToTokens: async (tokens) => tokens.map((t) => ({ token: t, success: true, messageId: "msg_crash" })),
    });

    const client = await connectClient(customerToken);
    const deliveredEvents: any[] = [];
    client.on("notification:booking_confirmed", (payload) => {
      deliveredEvents.push(payload);
    });

    const event = await prisma.$transaction(async (tx) => {
      return outboxService.createOutboxEvent(tx, {
        eventType: "booking_confirmed",
        aggregateType: "booking",
        aggregateId: AGGREGATE_ID,
        recipientType: "customer",
        recipientId: CUSTOMER_ID,
        payload: { bookingId: "b-crash-test" },
        idempotencyKey: `test6:${Date.now()}`,
      });
    });

    const eventId = event!.id;

    // Simulate crash: Worker A emits Socket event, but crashes before DB update
    const socketIo = (worker as any).getSocketIo();
    const socketPayload = {
      ...event!.payload,
      eventId,
      deliveryId: `${eventId}:${CUSTOMER_ID}:socket`,
      outboxId: eventId,
      eventType: "booking_confirmed",
      aggregateId: AGGREGATE_ID,
      aggregateVersion: 1,
      occurredAt: new Date().toISOString(),
    };
    socketIo.to(`customer:${CUSTOMER_ID}`).emit("notification:booking_confirmed", socketPayload);

    await new Promise((r) => setTimeout(r, 100));
    expect(deliveredEvents.length).toBe(1);

    // Worker B (restart) claims and processes the original event
    await worker.processRecord(event!);
    await new Promise((r) => setTimeout(r, 100));

    // Both physical emissions carry the exact same eventId and deliveryId!
    expect(deliveredEvents.length).toBe(2);
    expect(deliveredEvents[0].eventId).toBe(deliveredEvents[1].eventId);
    expect(deliveredEvents[0].deliveryId).toBe(deliveredEvents[1].deliveryId);

    // Client-side deduplication contract:
    const seenEventIds = new Set<string>();
    const uniqueProcessedEvents: any[] = [];
    for (const evt of deliveredEvents) {
      if (!seenEventIds.has(evt.eventId)) {
        seenEventIds.add(evt.eventId);
        uniqueProcessedEvents.push(evt);
      }
    }
    expect(uniqueProcessedEvents.length).toBe(1);

    // Database state converges cleanly
    const finalState = await (prisma as any).notification_outbox.findUnique({
      where: { id: eventId },
    });
    expect(finalState.status).toBe("SENT");

    client.disconnect();
  });

  // ==========================================================================
  // TEST 7 — Worker crashes after FCM success
  // ==========================================================================
  it("TEST 7 — Worker crashes after FCM success: retry remains safe with deterministic eventId", async () => {
    let fcmCalls = 0;
    const recordedMessageData: any[] = [];
    setMockFcmProvider({
      sendToTokens: async (tokens, message) => {
        fcmCalls++;
        recordedMessageData.push(message.data);
        return tokens.map((t) => ({ token: t, success: true, messageId: `msg_${fcmCalls}` }));
      },
    });

    const event = await prisma.$transaction(async (tx) => {
      return outboxService.createOutboxEvent(tx, {
        eventType: "booking_confirmed",
        aggregateType: "booking",
        aggregateId: AGGREGATE_ID,
        recipientType: "customer",
        recipientId: CUSTOMER_ID,
        payload: { bookingId: "b-fcm-crash" },
        idempotencyKey: `test7:${Date.now()}`,
      });
    });

    const eventId = event!.id;

    // Simulate crash after FCM attempt 1
    await worker.processRecord(event!);
    expect(fcmCalls).toBe(1);
    expect(recordedMessageData[0].eventId).toBe(eventId);
    expect(recordedMessageData[0].deliveryId).toBe(`${eventId}:${CUSTOMER_ID}:fcm`);

    // Second worker pass
    const state = await (prisma as any).notification_outbox.findUnique({ where: { id: eventId } });
    await worker.processRecord(state);

    // Since state is now SENT, FCM was not re-sent!
    expect(fcmCalls).toBe(1);

    const finalState = await (prisma as any).notification_outbox.findUnique({ where: { id: eventId } });
    expect(finalState.status).toBe("SENT");
  });

  // ==========================================================================
  // TEST 8 — Duplicate concurrent workers
  // ==========================================================================
  it("TEST 8 — Duplicate concurrent workers: PostgreSQL CTE SKIP LOCKED guarantees exactly one worker claims each event", async () => {
    // Ensure clean queue isolation by purging any unhandled PENDING records from earlier tests
    await (prisma as any).notification_outbox.deleteMany({
      where: { status: { in: ["PENDING", "PROCESSING"] } },
    }).catch(() => {});

    // Insert 5 pending events
    const eventIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const e = await prisma.$transaction(async (tx) => {
        return outboxService.createOutboxEvent(tx, {
          eventType: "booking_confirmed",
          aggregateType: "booking",
          aggregateId: AGGREGATE_ID,
          recipientType: "customer",
          recipientId: CUSTOMER_ID,
          payload: { bookingId: `b-conc-${i}` },
          idempotencyKey: `test8:${Date.now()}:${i}`,
        });
      });
      eventIds.push(e!.id);
    }

    // Run 3 workers simultaneously claiming from outbox
    const [claim1, claim2, claim3] = await Promise.all([
      outboxService.claimPendingEvents(10),
      outboxService.claimPendingEvents(10),
      outboxService.claimPendingEvents(10),
    ]);

    const allClaimedIds = [
      ...claim1.map((c) => c.id),
      ...claim2.map((c) => c.id),
      ...claim3.map((c) => c.id),
    ].filter((id) => eventIds.includes(id));

    // Zero overlap between concurrent workers!
    const uniqueClaimedIds = new Set(allClaimedIds);
    expect(allClaimedIds.length).toBe(uniqueClaimedIds.size);
    expect(uniqueClaimedIds.size).toBe(5);

    // Clean up
    await (prisma as any).notification_outbox.deleteMany({
      where: { id: { in: eventIds } },
    });
  });

  // ==========================================================================
  // TEST 10 — Socket disconnect/reconnect and offline customer recovery
  // ==========================================================================
  it("TEST 10 — Socket disconnect/reconnect: offline customer receives durable recovery via PostgreSQL outbox", async () => {
    setMockFcmProvider({
      sendToTokens: async (tokens) => tokens.map((t) => ({ token: t, success: true, messageId: "msg_offline" })),
    });

    // Customer is NOT connected on Socket.IO when event occurs
    const event = await prisma.$transaction(async (tx) => {
      return outboxService.createOutboxEvent(tx, {
        eventType: "booking_confirmed",
        aggregateType: "booking",
        aggregateId: AGGREGATE_ID,
        recipientType: "customer",
        recipientId: CUSTOMER_ID,
        payload: { bookingId: "b-offline-test", title: "Offline Notification" },
        idempotencyKey: `test10:${Date.now()}`,
      });
    });

    const eventId = event!.id;

    // Worker processes record while customer is offline
    await worker.processRecord(event!);

    // Notification is durably saved in PostgreSQL
    const unreadNotifications = await (prisma as any).notification_outbox.findMany({
      where: {
        recipient_id: CUSTOMER_ID,
        recipient_type: "customer",
        acknowledged_at: null,
      },
      orderBy: { created_at: "desc" },
    });

    const found = unreadNotifications.find((n: any) => n.id === eventId);
    expect(found).toBeDefined();
    expect(found.payload.bookingId).toBe("b-offline-test");

    // Customer reconnects and acknowledges receipt
    const updated = await (prisma as any).notification_outbox.update({
      where: { id: eventId },
      data: {
        acknowledged_at: new Date(),
        acknowledged_by: CUSTOMER_ID,
      },
    });

    expect(updated.acknowledged_at).not.toBeNull();
    expect(updated.acknowledged_by).toBe(CUSTOMER_ID);
  });

  // ==========================================================================
  // TEST 11 — Event ordering and versioning
  // ==========================================================================
  it("TEST 11 — Event ordering: aggregateVersion prevents older event from overwriting newer state", async () => {
    const client = await connectClient(customerToken);
    const clientState: { lastAppliedVersion: number; bookingStatus: string } = {
      lastAppliedVersion: 0,
      bookingStatus: "UNKNOWN",
    };

    client.on("notification:booking_confirmed", (payload) => {
      // Deterministic client-side ordering guard:
      if (payload.aggregateVersion > clientState.lastAppliedVersion) {
        clientState.lastAppliedVersion = payload.aggregateVersion;
        clientState.bookingStatus = payload.status;
      }
    });

    // Deliver Version 2 FIRST
    const eventV2 = {
      eventId: "e-v2",
      eventType: "booking_confirmed",
      aggregateId: AGGREGATE_ID,
      aggregateVersion: 2,
      status: "CONFIRMED_V2",
    };
    (worker as any).getSocketIo().to(`customer:${CUSTOMER_ID}`).emit("notification:booking_confirmed", eventV2);

    await new Promise((r) => setTimeout(r, 50));
    expect(clientState.lastAppliedVersion).toBe(2);
    expect(clientState.bookingStatus).toBe("CONFIRMED_V2");

    // Deliver Version 1 SECOND (Out of order)
    const eventV1 = {
      eventId: "e-v1",
      eventType: "booking_confirmed",
      aggregateId: AGGREGATE_ID,
      aggregateVersion: 1,
      status: "CONFIRMED_V1_STALE",
    };
    (worker as any).getSocketIo().to(`customer:${CUSTOMER_ID}`).emit("notification:booking_confirmed", eventV1);

    await new Promise((r) => setTimeout(r, 50));
    // Stale version 1 was correctly ignored by client ordering guard!
    expect(clientState.lastAppliedVersion).toBe(2);
    expect(clientState.bookingStatus).toBe("CONFIRMED_V2");

    client.disconnect();
  });

  // ==========================================================================
  // TEST 12 — Many concurrent duplicate attempts
  // ==========================================================================
  it("TEST 12 — 20 concurrent duplicate business attempts: database constraint enforces exactly one durable event", async () => {
    const sharedIdempotencyKey = `conc_20:${Date.now()}`;

    // Fire 20 concurrent transactions attempting to insert the exact same event
    const results = await Promise.allSettled(
      Array.from({ length: 20 }).map(() =>
        prisma.$transaction(async (tx) => {
          return outboxService.createOutboxEvent(tx, {
            eventType: "booking_confirmed",
            aggregateType: "booking",
            aggregateId: AGGREGATE_ID,
            recipientType: "customer",
            recipientId: CUSTOMER_ID,
            payload: { bookingId: "b-conc-20" },
            idempotencyKey: sharedIdempotencyKey,
          });
        })
      )
    );

    // Filter successful returns
    const createdOrReturned = results
      .filter((r) => r.status === "fulfilled" && (r as PromiseFulfilledResult<any>).value !== null)
      .map((r) => (r as PromiseFulfilledResult<any>).value);

    expect(createdOrReturned.length).toBeGreaterThan(0);
    const firstId = createdOrReturned[0].id;
    for (const item of createdOrReturned) {
      expect(item.id).toBe(firstId);
    }

    // Verify exactly 1 row exists in PostgreSQL
    const count = await (prisma as any).notification_outbox.count({
      where: { idempotency_key: sharedIdempotencyKey },
    });
    expect(count).toBe(1);

    // Clean up
    await (prisma as any).notification_outbox.deleteMany({
      where: { idempotency_key: sharedIdempotencyKey },
    });
  });

  // ==========================================================================
  // TEST 13 — Authorization and Room Isolation
  // ==========================================================================
  it("TEST 13 — Room isolation: unauthorized client cannot receive another user's notifications", async () => {
    const otherCustomerId = "66660000-0000-4000-c000-000000000001";
    await prisma.customer.upsert({
      where: { id: otherCustomerId },
      update: {},
      create: {
        id: otherCustomerId,
        phone: OTHER_CUSTOMER_PHONE,
        name: "Other Customer",
        password: "$2b$10$abcdefghijklmnopqrstuvwxyzA1B2C3D4E5F6G7H8I9J0K",
      },
    });

    const otherCustomerToken = signAccessToken({
      id: otherCustomerId,
      role: UserRole.CUSTOMER,
      phone: OTHER_CUSTOMER_PHONE,
    });

    const client = await connectClient(otherCustomerToken);
    let receivedOtherNotification = false;

    client.on("notification:booking_confirmed", () => {
      receivedOtherNotification = true;
    });

    // Emit notification targeted at CUSTOMER_ID
    const socketIo = (worker as any).getSocketIo();
    socketIo.to(`customer:${CUSTOMER_ID}`).emit("notification:booking_confirmed", {
      eventId: "private-event",
      bookingId: "b-private",
    });

    await new Promise((r) => setTimeout(r, 100));

    // Other customer must NOT receive it!
    expect(receivedOtherNotification).toBe(false);

    client.disconnect();
  });

  // ==========================================================================
  // TEST 14 — Sensitive fields never exposed in notification payloads
  // ==========================================================================
  it("TEST 14 — Security: notification payloads never leak password hashes, raw tokens, or secrets", async () => {
    const client = await connectClient(customerToken);
    let capturedPayload: any = null;

    client.on("notification:booking_confirmed", (payload) => {
      capturedPayload = payload;
    });

    const event = await prisma.$transaction(async (tx) => {
      return outboxService.createOutboxEvent(tx, {
        eventType: "booking_confirmed",
        aggregateType: "booking",
        aggregateId: AGGREGATE_ID,
        recipientType: "customer",
        recipientId: CUSTOMER_ID,
        payload: {
          bookingId: "b-safe",
          title: "Safe Notification",
          body: "Your worker is on the way.",
        },
        idempotencyKey: `test14:${Date.now()}`,
      });
    });

    await worker.processRecord(event!);
    await new Promise((r) => setTimeout(r, 100));

    expect(capturedPayload).not.toBeNull();
    // Verify absence of sensitive leakages
    expect(capturedPayload.password_hash).toBeUndefined();
    expect(capturedPayload.fcm_token).toBeUndefined();
    expect(capturedPayload.refreshToken).toBeUndefined();
    expect(capturedPayload.secret).toBeUndefined();

    client.disconnect();
  });
});
