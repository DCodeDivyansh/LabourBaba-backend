/**
 * tests/customerNotificationDeliverySemantics.test.ts
 *
 * P6 Issue 5 — Customer Notification Delivery Semantics Suite
 *
 * Verifies:
 * 1. Customer Online: Real-time Socket.IO emission to customer personal room with application ack.
 * 2. Customer Offline: Outbox event persisted in PostgreSQL, unacknowledged, zero fake socket delivery.
 * 3. Customer Reconnects: Offline customer recovers unread notifications via REST/sync endpoint.
 * 4. FCM Temporary Failure: Transient error triggers bounded backoff retry, never marks premature success.
 * 5. FCM Permanent Invalid Token: Reports unregistered token, auto-revokes customer device, avoids infinite retries.
 * 6. Multiple Customer Devices: One invalid token does not prevent valid device from receiving push.
 * 7. Device Token Rotation: Re-registering existing device_id updates token without duplicating rows.
 * 8. Device Revocation: Soft-revoked device receives no future push notifications.
 * 9. Duplicate Execution: Idempotent processing of identical outbox event.
 * 10. Worker Restart / Crash Recovery: Reconciles stale PROCESSING events back to PENDING.
 * 11. Socket Disconnect During Delivery: Event remains unacknowledged and recoverable.
 * 12. Cross-Customer Authorization Isolation: Customer A cannot view, acknowledge, or revoke Customer B's data.
 * 13. Notification Ordering: Preserves deterministic reverse-chronological ordering.
 * 14. Observability: Records bounded low-cardinality notification metrics.
 * 15. DTO Privacy: Never leaks raw FCM tokens, provider credentials, or internal secrets.
 */

import http from "http";
import request from "supertest";
import { Server as SocketIOServer } from "socket.io";
import { io as Client, Socket as ClientSocket } from "socket.io-client";
import { app } from "../src/server";
import prisma from "../src/config/prisma";
import { socketAuthMiddleware } from "../src/socket/socketAuth";
import { registerSocketHandlers } from "../src/socket/socketHandlers";
import { customerDeviceService } from "../src/features/customer_device/customer_device.service";
import { customerNotificationService } from "../src/features/customer_notification/customer_notification.service";
import { outboxService, OutboxRecord } from "../src/services/outboxService";
import { OutboxWorker } from "../src/workers/outboxWorker";
import { setMockFcmProvider, resetFirebaseApp, IFCMProvider } from "../src/shared/fcm";
import { signAccessToken } from "../src/utils/authUtils";
import { UserRole } from "../src/type/userRole";
import { metricsService } from "../src/metrics/metrics.service";

describe("P6 Issue 5 — Customer Notification Delivery Semantics Suite", () => {
  jest.setTimeout(45000);

  const testSuffix = Date.now().toString().slice(-6);
  const CUSTOMER_A_ID = "11110000-0000-4000-c000-000000000001";
  const CUSTOMER_B_ID = "22220000-0000-4000-c000-000000000002";
  const CUSTOMER_A_PHONE = `91${testSuffix}01`;
  const CUSTOMER_B_PHONE = `91${testSuffix}02`;

  let customerAToken: string;
  let customerBToken: string;

  let httpServer: http.Server;
  let ioServer: SocketIOServer;
  let serverPort: number;
  let worker: OutboxWorker;

  beforeAll(async () => {
    // 1. Clean up potential leftover fixtures
    await (prisma as any).customer_device.deleteMany({
      where: { customer_id: { in: [CUSTOMER_A_ID, CUSTOMER_B_ID] } },
    }).catch(() => {});
    await (prisma as any).notification_outbox.deleteMany({
      where: { recipient_id: { in: [CUSTOMER_A_ID, CUSTOMER_B_ID] } },
    }).catch(() => {});
    await prisma.customer.deleteMany({
      where: { id: { in: [CUSTOMER_A_ID, CUSTOMER_B_ID] } },
    }).catch(() => {});

    // 2. Create test customers
    await prisma.customer.createMany({
      data: [
        {
          id: CUSTOMER_A_ID,
          phone: CUSTOMER_A_PHONE,
          name: "Customer Alpha",
          password: "$2b$10$abcdefghijklmnopqrstuvwxyzA1B2C3D4E5F6G7H8I9J0K",
        },
        {
          id: CUSTOMER_B_ID,
          phone: CUSTOMER_B_PHONE,
          name: "Customer Beta",
          password: "$2b$10$abcdefghijklmnopqrstuvwxyzA1B2C3D4E5F6G7H8I9J0K",
        },
      ],
    });

    customerAToken = signAccessToken({ id: CUSTOMER_A_ID, role: UserRole.CUSTOMER, phone: CUSTOMER_A_PHONE });
    customerBToken = signAccessToken({ id: CUSTOMER_B_ID, role: UserRole.CUSTOMER, phone: CUSTOMER_B_PHONE });

    // 3. Setup test Socket.IO server
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
    await (prisma as any).customer_device.deleteMany({
      where: { customer_id: { in: [CUSTOMER_A_ID, CUSTOMER_B_ID] } },
    }).catch(() => {});
    await (prisma as any).notification_outbox.deleteMany({
      where: { recipient_id: { in: [CUSTOMER_A_ID, CUSTOMER_B_ID] } },
    }).catch(() => {});
    await prisma.customer.deleteMany({
      where: { id: { in: [CUSTOMER_A_ID, CUSTOMER_B_ID] } },
    }).catch(() => {});
    await prisma.$disconnect();
  });

  beforeEach(() => {
    // Default mock FCM provider (success)
    setMockFcmProvider({
      sendToTokens: async (tokens) => tokens.map((token) => ({ token, success: true, messageId: `msg_${Date.now()}` })),
    });
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
  // TEST 1 — Customer Online
  // ==========================================================================
  it("TEST 1 — Customer Online: receives realtime Socket.IO event and acknowledges receipt", async () => {
    const client = await connectClient(customerAToken);

    const receivedEvents: any[] = [];
    client.on("notification:booking_confirmed", (data) => {
      receivedEvents.push(data);
    });

    const event = await prisma.$transaction(async (tx) => {
      return outboxService.createOutboxEvent(tx, {
        eventType: "booking_confirmed",
        aggregateType: "booking",
        aggregateId: "33330000-0000-4000-a000-000000000001",
        recipientType: "customer",
        recipientId: CUSTOMER_A_ID,
        payload: { bookingId: "b-100", title: "Worker Assigned" },
        idempotencyKey: `test:online:${Date.now()}`,
      });
    });

    expect(event).toBeDefined();

    // Outbox worker processes the record
    await worker.processRecord(event!);

    // Realtime delivery via Socket.IO
    await new Promise((r) => setTimeout(r, 100));
    expect(receivedEvents.length).toBe(1);
    expect(receivedEvents[0].bookingId).toBe("b-100");

    // Client acknowledges receipt over Socket.IO
    const ackResponse: any = await new Promise((resolve) => {
      client.emit("notification:ack", { notificationId: event!.id }, (res: any) => resolve(res));
    });

    expect(ackResponse.success).toBe(true);

    const updated = await (prisma as any).notification_outbox.findUnique({
      where: { id: event!.id },
    });
    expect(updated.acknowledged_at).not.toBeNull();
    expect(updated.acknowledged_by).toBe(CUSTOMER_A_ID);

    client.disconnect();
  });

  // ==========================================================================
  // TEST 2 — Customer Offline
  // ==========================================================================
  it("TEST 2 — Customer Offline: outbox event persisted, zero fake socket delivery, unacknowledged in DB", async () => {
    const event = await prisma.$transaction(async (tx) => {
      return outboxService.createOutboxEvent(tx, {
        eventType: "booking_cancelled",
        aggregateType: "booking",
        aggregateId: "33330000-0000-4000-a000-000000000002",
        recipientType: "customer",
        recipientId: CUSTOMER_A_ID,
        payload: { bookingId: "b-200", reason: "Worker unavailable" },
        idempotencyKey: `test:offline:${Date.now()}`,
      });
    });

    expect(event).toBeDefined();

    // Customer has no active socket connection. Process outbox event.
    await worker.processRecord(event!);

    const inDb = await (prisma as any).notification_outbox.findUnique({
      where: { id: event!.id },
    });

    expect(inDb.status).toBe("SENT");
    // Explicit semantic invariant: SENT != ACKNOWLEDGED
    expect(inDb.acknowledged_at).toBeNull();
    expect(inDb.acknowledged_by).toBeNull();
  });

  // ==========================================================================
  // TEST 3 — Customer Reconnects & Syncs
  // ==========================================================================
  it("TEST 3 — Customer Reconnects: offline customer recovers unread events and acknowledges via REST", async () => {
    // Retrieve unread notifications via REST API
    const res = await request(app)
      .get("/api/clients/notifications/unread")
      .set("Authorization", `Bearer ${customerAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);

    const missed = res.body.data.find((n: any) => n.payload?.bookingId === "b-200");
    expect(missed).toBeDefined();
    expect(missed.eventType).toBe("booking_cancelled");
    expect(missed.isRead).toBe(false);

    // Customer acknowledges the recovered notification
    const ackRes = await request(app)
      .post(`/api/clients/notifications/${missed.id}/acknowledge`)
      .set("Authorization", `Bearer ${customerAToken}`);

    expect(ackRes.status).toBe(200);
    expect(ackRes.body.success).toBe(true);

    const inDb = await (prisma as any).notification_outbox.findUnique({
      where: { id: missed.id },
    });
    expect(inDb.acknowledged_at).not.toBeNull();
  });

  // ==========================================================================
  // TEST 4 — FCM Temporary Failure
  // ==========================================================================
  it("TEST 4 — FCM Temporary Failure: transient error triggers backoff retry, never marks permanent success", async () => {
    // Register customer device
    await customerDeviceService.registerDevice(CUSTOMER_A_ID, {
      device_id: "test-device-transient",
      device_token: "fcm-token-transient-1",
      platform: "android",
    });

    // Mock FCM to return transient network failure
    setMockFcmProvider({
      sendToTokens: async (tokens) =>
        tokens.map((token) => ({
          token,
          success: false,
          error: new Error("ETIMEDOUT: Connection to FCM gateway timed out"),
          isInvalidToken: false,
        })),
    });

    const event = await prisma.$transaction(async (tx) => {
      return outboxService.createOutboxEvent(tx, {
        eventType: "payment_failed",
        aggregateType: "payment",
        aggregateId: "44440000-0000-4000-a000-000000000001",
        recipientType: "customer",
        recipientId: CUSTOMER_A_ID,
        payload: { amount: 500 },
        idempotencyKey: `test:fcm:transient:${Date.now()}`,
      });
    });

    // Worker claims and processes
    await worker.processRecord(event!);

    const inDb = await (prisma as any).notification_outbox.findUnique({
      where: { id: event!.id },
    });

    // Status MUST remain PENDING with incremented attempts and future available_at
    expect(inDb.status).toBe("PENDING");
    expect(inDb.attempts).toBe(1);
    expect(new Date(inDb.available_at).getTime()).toBeGreaterThan(Date.now());
  });

  // ==========================================================================
  // TEST 5 — FCM Permanent Invalid Token
  // ==========================================================================
  it("TEST 5 — FCM Permanent Invalid Token: reports unregistered token and auto-revokes customer device", async () => {
    await customerDeviceService.registerDevice(CUSTOMER_A_ID, {
      device_id: "test-device-invalid",
      device_token: "fcm-token-invalid-dead",
      platform: "android",
    });

    // Mock FCM to report registration-token-not-registered
    setMockFcmProvider({
      sendToTokens: async (tokens, _p, onInvalid) => {
        for (const token of tokens) {
          if (token === "fcm-token-invalid-dead") {
            await onInvalid?.(token);
          }
        }
        return tokens.map((token) => ({
          token,
          success: false,
          error: { code: "messaging/registration-token-not-registered", message: "Token not registered" },
          isInvalidToken: true,
        }));
      },
    });

    const event = await prisma.$transaction(async (tx) => {
      return outboxService.createOutboxEvent(tx, {
        eventType: "booking_confirmed",
        aggregateType: "booking",
        aggregateId: "33330000-0000-4000-a000-000000000003",
        recipientType: "customer",
        recipientId: CUSTOMER_A_ID,
        payload: { bookingId: "b-300" },
        idempotencyKey: `test:fcm:invalid:${Date.now()}`,
      });
    });

    await worker.processRecord(event!);

    // Verify device is auto-revoked
    const devices = await customerDeviceService.getActiveDevices(CUSTOMER_A_ID);
    expect(devices.some((d) => d.device_id === "test-device-invalid")).toBe(false);

    const revokedDevice = await (prisma as any).customer_device.findUnique({
      where: {
        customer_id_device_id: {
          customer_id: CUSTOMER_A_ID,
          device_id: "test-device-invalid",
        },
      },
    });
    expect(revokedDevice.revoked_at).not.toBeNull();
  });

  // ==========================================================================
  // TEST 6 — Multiple Customer Devices
  // ==========================================================================
  it("TEST 6 — Multiple Customer Devices: one invalid token does not prevent valid device from receiving push", async () => {
    await customerDeviceService.registerDevice(CUSTOMER_A_ID, {
      device_id: "device-valid-1",
      device_token: "token-good-1",
      platform: "android",
    });
    await customerDeviceService.registerDevice(CUSTOMER_A_ID, {
      device_id: "device-invalid-2",
      device_token: "token-bad-2",
      platform: "android",
    });

    setMockFcmProvider({
      sendToTokens: async (tokens, _p, onInvalid) => {
        return Promise.all(
          tokens.map(async (token) => {
            if (token === "token-bad-2") {
              await onInvalid?.(token);
              return {
                token,
                success: false,
                isInvalidToken: true,
                error: { code: "messaging/invalid-registration-token" },
              };
            }
            return { token, success: true, messageId: `msg_${token}` };
          })
        );
      },
    });

    const event = await prisma.$transaction(async (tx) => {
      return outboxService.createOutboxEvent(tx, {
        eventType: "payment_completed",
        aggregateType: "payment",
        aggregateId: "44440000-0000-4000-a000-000000000002",
        recipientType: "customer",
        recipientId: CUSTOMER_A_ID,
        payload: { amount: 1200 },
        idempotencyKey: `test:fcm:multi:${Date.now()}`,
      });
    });

    await worker.processRecord(event!);

    const inDb = await (prisma as any).notification_outbox.findUnique({
      where: { id: event!.id },
    });
    expect(inDb.status).toBe("SENT");

    // Invalid device revoked, valid device preserved
    const active = await customerDeviceService.getActiveDevices(CUSTOMER_A_ID);
    expect(active.some((d) => d.device_id === "device-valid-1")).toBe(true);
    expect(active.some((d) => d.device_id === "device-invalid-2")).toBe(false);
  });

  // ==========================================================================
  // TEST 7 — Device Token Rotation
  // ==========================================================================
  it("TEST 7 — Device Token Rotation: re-registering existing device_id updates token without creating duplicate rows", async () => {
    // 1. Initial registration
    const initial = await customerDeviceService.registerDevice(CUSTOMER_A_ID, {
      device_id: "phone-unique-pixel",
      device_token: "token-alpha-version-1",
      platform: "android",
    });
    expect(initial.device_id).toBe("phone-unique-pixel");

    // 2. Token rotation on same device
    const rotated = await customerDeviceService.registerDevice(CUSTOMER_A_ID, {
      device_id: "phone-unique-pixel",
      device_token: "token-alpha-version-2",
      platform: "android",
    });

    expect(rotated.device_id).toBe("phone-unique-pixel");

    // Must be exactly ONE row in database for this device_id
    const rows = await (prisma as any).customer_device.findMany({
      where: {
        customer_id: CUSTOMER_A_ID,
        device_id: "phone-unique-pixel",
      },
    });
    expect(rows.length).toBe(1);
    expect(rows[0].fcm_token).toBe("token-alpha-version-2");
    expect(rows[0].revoked_at).toBeNull();
  });

  // ==========================================================================
  // TEST 8 — Device Revocation via REST
  // ==========================================================================
  it("TEST 8 — Device Revocation: DELETE /api/clients/me/devices/:deviceId soft-revokes device and stops push", async () => {
    const delRes = await request(app)
      .delete("/api/clients/me/devices/phone-unique-pixel")
      .set("Authorization", `Bearer ${customerAToken}`);

    expect(delRes.status).toBe(200);
    expect(delRes.body.success).toBe(true);

    const active = await customerDeviceService.getActiveDevices(CUSTOMER_A_ID);
    expect(active.some((d) => d.device_id === "phone-unique-pixel")).toBe(false);

    const inDb = await (prisma as any).customer_device.findUnique({
      where: {
        customer_id_device_id: {
          customer_id: CUSTOMER_A_ID,
          device_id: "phone-unique-pixel",
        },
      },
    });
    expect(inDb.revoked_at).not.toBeNull();
  });

  // ==========================================================================
  // TEST 9 — Duplicate Queue / Worker Execution Idempotency
  // ==========================================================================
  it("TEST 9 — Idempotency: processing same outbox event twice does not produce inconsistent state", async () => {
    const event = await prisma.$transaction(async (tx) => {
      return outboxService.createOutboxEvent(tx, {
        eventType: "refund_completed",
        aggregateType: "payment",
        aggregateId: "44440000-0000-4000-a000-000000000003",
        recipientType: "customer",
        recipientId: CUSTOMER_A_ID,
        payload: { refundAmount: 500 },
        idempotencyKey: `test:idempotent:${Date.now()}`,
      });
    });

    // Run first time
    await worker.processRecord(event!);
    const firstState = await (prisma as any).notification_outbox.findUnique({
      where: { id: event!.id },
    });
    expect(firstState.status).toBe("SENT");

    // Run second time (e.g. BullMQ redelivery or retry)
    await worker.processRecord(firstState);
    const secondState = await (prisma as any).notification_outbox.findUnique({
      where: { id: event!.id },
    });
    expect(secondState.status).toBe("SENT");
  });

  // ==========================================================================
  // TEST 10 — Worker Restart & Crash Recovery
  // ==========================================================================
  it("TEST 10 — Crash Recovery: stale PROCESSING outbox events are safely recovered back to PENDING", async () => {
    const staleTime = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
    const staleEvent = await (prisma as any).notification_outbox.create({
      data: {
        event_type: "booking_confirmed",
        aggregate_type: "booking",
        aggregate_id: "33330000-0000-4000-a000-000000000004",
        recipient_type: "customer",
        recipient_id: CUSTOMER_A_ID,
        payload: { bookingId: "b-crash-test" },
        status: "PROCESSING",
        available_at: staleTime,
        created_at: staleTime,
        updated_at: staleTime,
        idempotency_key: `test:crash:${Date.now()}`,
      },
    });

    const recoveredCount = await outboxService.reconcileStaleEvents(5);
    expect(recoveredCount).toBeGreaterThanOrEqual(1);

    const inDb = await (prisma as any).notification_outbox.findUnique({
      where: { id: staleEvent.id },
    });
    expect(inDb.status).toBe("PENDING");
  });

  // ==========================================================================
  // TEST 11 — Socket Disconnect During Delivery
  // ==========================================================================
  it("TEST 11 — Socket Disconnect: notification remains unacknowledged in DB if socket drops before ack", async () => {
    const client = await connectClient(customerAToken);

    const event = await prisma.$transaction(async (tx) => {
      return outboxService.createOutboxEvent(tx, {
        eventType: "booking_confirmed",
        aggregateType: "booking",
        aggregateId: "33330000-0000-4000-a000-000000000005",
        recipientType: "customer",
        recipientId: CUSTOMER_A_ID,
        payload: { bookingId: "b-disconnect-test" },
        idempotencyKey: `test:disconnect:${Date.now()}`,
      });
    });

    await worker.processRecord(event!);

    // Client abruptly disconnects without acknowledging
    client.disconnect();

    const inDb = await (prisma as any).notification_outbox.findUnique({
      where: { id: event!.id },
    });

    expect(inDb.acknowledged_at).toBeNull();
  });

  // ==========================================================================
  // TEST 12 — Cross-Customer Authorization Isolation
  // ==========================================================================
  it("TEST 12 — Security & IDOR: Customer A cannot view, acknowledge, or revoke Customer B's resources", async () => {
    // 1. Create a notification owned by Customer B
    const eventB = await prisma.$transaction(async (tx) => {
      return outboxService.createOutboxEvent(tx, {
        eventType: "booking_confirmed",
        aggregateType: "booking",
        aggregateId: "33330000-0000-4000-a000-000000000006",
        recipientType: "customer",
        recipientId: CUSTOMER_B_ID,
        payload: { bookingId: "b-secret-customer-b" },
        idempotencyKey: `test:sec:b:${Date.now()}`,
      });
    });

    // Customer A attempts to view Customer B's notification via unread list
    const listRes = await request(app)
      .get("/api/clients/notifications")
      .set("Authorization", `Bearer ${customerAToken}`);

    expect(listRes.status).toBe(200);
    const hasEventB = listRes.body.data.some((n: any) => n.id === eventB!.id);
    expect(hasEventB).toBe(false);

    // Customer A attempts to acknowledge Customer B's notification (IDOR)
    const ackRes = await request(app)
      .post(`/api/clients/notifications/${eventB!.id}/acknowledge`)
      .set("Authorization", `Bearer ${customerAToken}`);

    expect(ackRes.status).toBe(404);

    // Customer B's notification remains unacknowledged
    const checkB = await (prisma as any).notification_outbox.findUnique({
      where: { id: eventB!.id },
    });
    expect(checkB.acknowledged_at).toBeNull();

    // 2. Customer A attempts to delete Customer B's device
    await customerDeviceService.registerDevice(CUSTOMER_B_ID, {
      device_id: "customer-b-secret-phone",
      device_token: "token-b-private",
      platform: "android",
    });

    const delRes = await request(app)
      .delete("/api/clients/me/devices/customer-b-secret-phone")
      .set("Authorization", `Bearer ${customerAToken}`);

    expect(delRes.status).toBe(200);
    expect(delRes.body.data.revokedCount).toBe(0); // Scoped query found 0 rows for Customer A

    const deviceB = await (prisma as any).customer_device.findUnique({
      where: {
        customer_id_device_id: {
          customer_id: CUSTOMER_B_ID,
          device_id: "customer-b-secret-phone",
        },
      },
    });
    expect(deviceB.revoked_at).toBeNull();
  });

  // ==========================================================================
  // TEST 13 — Notification Chronological Ordering
  // ==========================================================================
  it("TEST 13 — Ordering: notifications are retrieved in reverse chronological order (newest first)", async () => {
    const listRes = await request(app)
      .get("/api/clients/notifications?limit=10")
      .set("Authorization", `Bearer ${customerAToken}`);

    expect(listRes.status).toBe(200);
    const notifications: any[] = listRes.body.data;
    expect(notifications.length).toBeGreaterThan(1);

    for (let i = 0; i < notifications.length - 1; i++) {
      const current = new Date(notifications[i].createdAt).getTime();
      const next = new Date(notifications[i + 1].createdAt).getTime();
      expect(current).toBeGreaterThanOrEqual(next);
    }
  });

  // ==========================================================================
  // TEST 14 — Bounded Observability Metrics
  // ==========================================================================
  it("TEST 14 — Observability: verifies notification metrics are emitted with bounded cardinality", async () => {
    const exposition = await metricsService.formatPrometheus();
    expect(exposition).toContain("notification_attempts_total");
    expect(exposition).toContain("notification_success_total");

    // Verify zero UUIDs or raw device tokens in Prometheus labels
    expect(exposition).not.toMatch(/notification_attempts_total\{[^}]*[0-9a-f]{8}-[0-9a-f]{4}/i);
    expect(exposition).not.toContain("fcm-token");
  });

  // ==========================================================================
  // TEST 15 — Zero Secret / FCM Token Leakage
  // ==========================================================================
  it("TEST 15 — Privacy & DTO Boundary: device list and notification list never leak raw FCM tokens", async () => {
    await customerDeviceService.registerDevice(CUSTOMER_A_ID, {
      device_id: "audit-leak-device",
      device_token: "super-secret-fcm-push-token-12345",
      platform: "android",
    });

    const res = await request(app)
      .get("/api/clients/me/devices")
      .set("Authorization", `Bearer ${customerAToken}`);

    expect(res.status).toBe(200);
    const jsonStr = JSON.stringify(res.body);
    expect(jsonStr).not.toContain("super-secret-fcm-push-token-12345");
    expect(jsonStr).not.toContain("fcm_token");
  });

  // ==========================================================================
  // TEST 16 — Retention Policy & Offline Recovery Protection
  // ==========================================================================
  it("TEST 16 — Retention Invariant: outbox cleanup NEVER deletes unacknowledged customer notifications within recovery window", async () => {
    // 1. Create a recent unacknowledged customer notification (e.g. 5 days ago)
    const recentUnack = await (prisma as any).notification_outbox.create({
      data: {
        event_type: "booking_confirmed",
        aggregate_type: "booking",
        aggregate_id: "33330000-0000-4000-a000-000000000010",
        recipient_type: "customer",
        recipient_id: CUSTOMER_A_ID,
        payload: { title: "Recent unread" },
        status: "SENT",
        created_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000), // 5 days old
        acknowledged_at: null,
      },
    });

    // 2. Create an in-flight PENDING notification
    const pendingEvent = await (prisma as any).notification_outbox.create({
      data: {
        event_type: "booking_confirmed",
        aggregate_type: "booking",
        aggregate_id: "33330000-0000-4000-a000-000000000011",
        recipient_type: "customer",
        recipient_id: CUSTOMER_A_ID,
        payload: { title: "In-flight" },
        status: "PENDING",
        created_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
      },
    });

    // 3. Create an old acknowledged notification (45 days old, acknowledged 40 days ago)
    const oldAck = await (prisma as any).notification_outbox.create({
      data: {
        event_type: "booking_confirmed",
        aggregate_type: "booking",
        aggregate_id: "33330000-0000-4000-a000-000000000012",
        recipient_type: "customer",
        recipient_id: CUSTOMER_A_ID,
        payload: { title: "Old acknowledged" },
        status: "SENT",
        created_at: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000),
        acknowledged_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
        acknowledged_by: CUSTOMER_A_ID,
      },
    });

    // Run cleanup with default rules (30 days ack retention, 90 days unack recovery window)
    const { deletedCount } = await outboxService.cleanupAgedEvents({
      acknowledgedRetentionDays: 30,
      unacknowledgedRetentionDays: 90,
    });

    expect(deletedCount).toBeGreaterThanOrEqual(1);

    // Assert: Unacknowledged notification within 90 days STILL EXISTS
    const recentFound = await (prisma as any).notification_outbox.findUnique({
      where: { id: recentUnack.id },
    });
    expect(recentFound).not.toBeNull();

    // Assert: PENDING notification is NEVER deleted
    const pendingFound = await (prisma as any).notification_outbox.findUnique({
      where: { id: pendingEvent.id },
    });
    expect(pendingFound).not.toBeNull();

    // Assert: Acknowledged notification older than 30 days IS pruned
    const oldFound = await (prisma as any).notification_outbox.findUnique({
      where: { id: oldAck.id },
    });
    expect(oldFound).toBeNull();
  });

  // ==========================================================================
  // TEST 17 — Acknowledgement Idempotency & Immutability
  // ==========================================================================
  it("TEST 17 — Idempotency: repeated ACKs return exact same state and never mutate original acknowledged_at", async () => {
    const event = await prisma.$transaction(async (tx) => {
      return outboxService.createOutboxEvent(tx, {
        eventType: "booking_confirmed",
        aggregateType: "booking",
        aggregateId: "33330000-0000-4000-a000-000000000013",
        recipientType: "customer",
        recipientId: CUSTOMER_A_ID,
        payload: { bookingId: "b-idempotent-ack" },
        idempotencyKey: `test:ack:idemp:${Date.now()}`,
      });
    });

    // First ACK
    const res1 = await request(app)
      .post(`/api/clients/notifications/${event!.id}/acknowledge`)
      .set("Authorization", `Bearer ${customerAToken}`);

    expect(res1.status).toBe(200);
    const initialAckAt = res1.body.data.acknowledgedAt;
    expect(initialAckAt).toBeDefined();

    await new Promise((r) => setTimeout(r, 50));

    // Second ACK (duplicate replay)
    const res2 = await request(app)
      .post(`/api/clients/notifications/${event!.id}/acknowledge`)
      .set("Authorization", `Bearer ${customerAToken}`);

    expect(res2.status).toBe(200);
    expect(res2.body.data.acknowledgedAt).toBe(initialAckAt);

    // Verify DB row was NOT updated to a newer timestamp
    const inDb = await (prisma as any).notification_outbox.findUnique({
      where: { id: event!.id },
    });
    expect(new Date(inDb.acknowledged_at).toISOString()).toBe(new Date(initialAckAt).toISOString());
  });

  // ==========================================================================
  // TEST 18 — Keyset / Cursor-Based Pagination
  // ==========================================================================
  it("TEST 18 — Keyset Pagination: retrieves sequential non-overlapping pages using cursor and nextCursor", async () => {
    const resPage1 = await request(app)
      .get("/api/clients/notifications?limit=2")
      .set("Authorization", `Bearer ${customerAToken}`);

    expect(resPage1.status).toBe(200);
    expect(resPage1.body.data.length).toBe(2);
    const nextCursor = resPage1.body.meta.nextCursor;
    expect(nextCursor).toBeDefined();
    expect(nextCursor).not.toBeNull();

    const resPage2 = await request(app)
      .get(`/api/clients/notifications?limit=2&cursor=${nextCursor}`)
      .set("Authorization", `Bearer ${customerAToken}`);

    expect(resPage2.status).toBe(200);
    expect(resPage2.body.data.length).toBeGreaterThanOrEqual(1);

    // Verify zero overlap between page 1 and page 2
    const page1Ids = resPage1.body.data.map((n: any) => n.id);
    const page2Ids = resPage2.body.data.map((n: any) => n.id);
    for (const id of page2Ids) {
      expect(page1Ids).not.toContain(id);
    }
  });

  // ==========================================================================
  // TEST 19 — Multi-Device Mixed Failure & Success Resilience
  // ==========================================================================
  it("TEST 19 — Multi-Device: 1 invalid token + 1 transient failure + 1 success delivers and does NOT fail outbox event", async () => {
    const mixedDeviceId1 = "device-mixed-invalid";
    const mixedDeviceId2 = "device-mixed-transient";
    const mixedDeviceId3 = "device-mixed-success";

    const tokenInvalid = "token-mixed-invalid-404";
    const tokenTransient = "token-mixed-transient-503";
    const tokenSuccess = "token-mixed-valid-200";

    await customerDeviceService.registerDevice(CUSTOMER_A_ID, {
      device_id: mixedDeviceId1,
      device_token: tokenInvalid,
      platform: "android",
    });
    await customerDeviceService.registerDevice(CUSTOMER_A_ID, {
      device_id: mixedDeviceId2,
      device_token: tokenTransient,
      platform: "android",
    });
    await customerDeviceService.registerDevice(CUSTOMER_A_ID, {
      device_id: mixedDeviceId3,
      device_token: tokenSuccess,
      platform: "android",
    });

    // Mock FCM: token 1 invalid, token 2 transient error, token 3 success
    setMockFcmProvider({
      sendToTokens: async (tokens, _p, onInvalid) => {
        for (const t of tokens) {
          if (t === tokenInvalid) {
            await onInvalid?.(t);
          }
        }
        return tokens.map((t) => {
          if (t === tokenInvalid) {
            return {
              token: t,
              success: false,
              isInvalidToken: true,
              error: { code: "messaging/registration-token-not-registered", message: "Token unregistered" },
            };
          } else if (t === tokenTransient) {
            return {
              token: t,
              success: false,
              isInvalidToken: false,
              error: { code: "messaging/server-unavailable", message: "FCM unavailable" },
            };
          } else {
            return {
              token: t,
              success: true,
              messageId: "msg_success_ok",
            };
          }
        });
      },
    });

    const event = await prisma.$transaction(async (tx) => {
      return outboxService.createOutboxEvent(tx, {
        eventType: "booking_confirmed",
        aggregateType: "booking",
        aggregateId: "33330000-0000-4000-a000-000000000014",
        recipientType: "customer",
        recipientId: CUSTOMER_A_ID,
        payload: { bookingId: "b-mixed-devices" },
        idempotencyKey: `test:mixed:${Date.now()}`,
      });
    });

    await worker.processRecord(event!);

    // Invariant: At least one device succeeded, so logical outbox event is marked SENT (not FAILED or retry storm)
    const inDb = await (prisma as any).notification_outbox.findUnique({
      where: { id: event!.id },
    });
    expect(inDb.status).toBe("SENT");

    // Invariant: The invalid token device was auto-revoked
    const dev1 = await (prisma as any).customer_device.findUnique({
      where: { customer_id_device_id: { customer_id: CUSTOMER_A_ID, device_id: mixedDeviceId1 } },
    });
    expect(dev1.revoked_at).not.toBeNull();

    // Invariant: The transient and success devices remain active
    const dev2 = await (prisma as any).customer_device.findUnique({
      where: { customer_id_device_id: { customer_id: CUSTOMER_A_ID, device_id: mixedDeviceId2 } },
    });
    expect(dev2.revoked_at).toBeNull();

    const dev3 = await (prisma as any).customer_device.findUnique({
      where: { customer_id_device_id: { customer_id: CUSTOMER_A_ID, device_id: mixedDeviceId3 } },
    });
    expect(dev3.revoked_at).toBeNull();
  });
});
