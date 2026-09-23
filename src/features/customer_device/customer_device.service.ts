import prisma from "../../config/prisma";
import {
  ActiveCustomerDevice,
  CustomerDeviceDTO,
  RegisterCustomerDeviceReq,
  toCustomerDeviceDTO,
} from "./customer_device.types";
import { logger } from "../../utils/logger";

export class CustomerDeviceService {
  /**
   * Registers or updates a customer device.
   * Upserts on (customer_id, device_id) to ensure token rotation updates the existing
   * device record rather than creating duplicate rows.
   * Clears revoked_at on explicit re-registration.
   */
  public async registerDevice(
    customerId: string,
    payload: RegisterCustomerDeviceReq,
  ): Promise<CustomerDeviceDTO> {
    const rawDeviceId = payload.device_id && payload.device_id.trim();
    // Stable device identity: FCM token rotation must NEVER create a new logical device.
    // If client omitted device_id (legacy client), use deterministic per-customer fallback.
    const deviceId = rawDeviceId || `legacy_${customerId}_default`;

    const platform = payload.platform || "android";
    const now = new Date();

    const device = await prisma.customer_device.upsert({
      where: {
        customer_id_device_id: {
          customer_id: customerId,
          device_id: deviceId,
        },
      },
      update: {
        fcm_token: payload.device_token,
        platform,
        last_seen_at: now,
        revoked_at: null, // Clear revocation on active registration
        updated_at: now,
      },
      create: {
        customer_id: customerId,
        device_id: deviceId,
        fcm_token: payload.device_token,
        platform,
        last_seen_at: now,
        revoked_at: null,
        created_at: now,
        updated_at: now,
      },
    });

    return toCustomerDeviceDTO(device)!;
  }

  /**
   * Queries all active (non-revoked) devices for a customer.
   */
  public async getActiveDevices(customerId: string): Promise<ActiveCustomerDevice[]> {
    return prisma.customer_device.findMany({
      where: {
        customer_id: customerId,
        revoked_at: null,
      },
      select: {
        id: true,
        customer_id: true,
        device_id: true,
        fcm_token: true,
        platform: true,
      },
    });
  }

  /**
   * Queries all active devices for multiple customers in a single batch query.
   */
  public async getActiveDevicesForCustomers(
    customerIds: string[],
  ): Promise<Map<string, ActiveCustomerDevice[]>> {
    if (!customerIds.length) return new Map();

    const devices = await prisma.customer_device.findMany({
      where: {
        customer_id: { in: customerIds },
        revoked_at: null,
      },
      select: {
        id: true,
        customer_id: true,
        device_id: true,
        fcm_token: true,
        platform: true,
      },
    });

    const map = new Map<string, ActiveCustomerDevice[]>();
    for (const d of devices) {
      const list = map.get(d.customer_id) || [];
      list.push(d);
      map.set(d.customer_id, list);
    }
    return map;
  }

  /**
   * Soft-revokes a specific device for a customer.
   * Scoped strictly to the authenticated customerId.
   */
  public async revokeDevice(
    customerId: string,
    deviceId: string,
  ): Promise<{ success: boolean; revokedCount: number }> {
    const result = await prisma.customer_device.updateMany({
      where: {
        customer_id: customerId,
        device_id: deviceId,
        revoked_at: null,
      },
      data: {
        revoked_at: new Date(),
        updated_at: new Date(),
      },
    });

    return {
      success: true,
      revokedCount: result.count,
    };
  }

  /**
   * Soft-revokes a device when FCM reports an invalid or unregistered token.
   */
  public async revokeByToken(fcmToken: string): Promise<number> {
    if (!fcmToken) return 0;

    const result = await prisma.customer_device.updateMany({
      where: {
        fcm_token: fcmToken,
        revoked_at: null,
      },
      data: {
        revoked_at: new Date(),
        updated_at: new Date(),
      },
    });

    if (result.count > 0) {
      logger.info(`[CustomerDevice] Auto-revoked ${result.count} device(s) for invalid FCM token.`, { count: result.count });
    }

    return result.count;
  }

  /**
   * Lists all devices (active and revoked) for a customer with safe metadata.
   */
  public async listDevices(customerId: string): Promise<CustomerDeviceDTO[]> {
    const devices = await prisma.customer_device.findMany({
      where: { customer_id: customerId },
      orderBy: { last_seen_at: "desc" },
    });

    return devices.map(toCustomerDeviceDTO).filter(Boolean) as CustomerDeviceDTO[];
  }
}

export const customerDeviceService = new CustomerDeviceService();
