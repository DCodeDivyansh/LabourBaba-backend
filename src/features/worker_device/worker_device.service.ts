import crypto from "crypto";
import prisma from "../../config/prisma";
import { RegisterWorkerDeviceReq } from "../../type/api_req.type";
import {
  ActiveWorkerDevice,
  WorkerDeviceDTO,
  toWorkerDeviceDTO,
} from "./worker_device.types";

export class WorkerDeviceService {
  /**
   * Registers or updates a worker device.
   * Upserts on (worker_id, device_id) to ensure token rotation updates the existing
   * device record rather than creating duplicate rows.
   * Clears revoked_at on explicit re-registration.
   */
  public async registerDevice(
    workerId: string,
    payload: RegisterWorkerDeviceReq,
  ): Promise<WorkerDeviceDTO> {
    const rawDeviceId = payload.device_id && payload.device_id.trim();
    // Stable device identity fallback if client omitted device_id (legacy mobile clients)
    const deviceId =
      rawDeviceId ||
      crypto.createHash("sha256").update(payload.device_token).digest("hex").slice(0, 32);

    const platform = payload.platform || "android";
    const now = new Date();

    const device = await prisma.worker_device.upsert({
      where: {
        worker_id_device_id: {
          worker_id: workerId,
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
        worker_id: workerId,
        device_id: deviceId,
        fcm_token: payload.device_token,
        platform,
        last_seen_at: now,
        revoked_at: null,
        created_at: now,
        updated_at: now,
      },
    });

    // Best-effort legacy field sync for DB backward compatibility
    await prisma.worker
      .update({
        where: { id: workerId },
        data: { device_token: payload.device_token },
        select: { id: true },
      })
      .catch(() => {});

    return toWorkerDeviceDTO(device)!;
  }

  /**
   * Queries all active (non-revoked) devices for a worker.
   */
  public async getActiveDevices(workerId: string): Promise<ActiveWorkerDevice[]> {
    return prisma.worker_device.findMany({
      where: {
        worker_id: workerId,
        revoked_at: null,
      },
      select: {
        id: true,
        worker_id: true,
        device_id: true,
        fcm_token: true,
        platform: true,
      },
    });
  }

  /**
   * Queries all active devices for multiple workers in a single batch query.
   */
  public async getActiveDevicesForWorkers(
    workerIds: string[],
  ): Promise<Map<string, ActiveWorkerDevice[]>> {
    if (!workerIds.length) return new Map();

    const devices = await prisma.worker_device.findMany({
      where: {
        worker_id: { in: workerIds },
        revoked_at: null,
      },
      select: {
        id: true,
        worker_id: true,
        device_id: true,
        fcm_token: true,
        platform: true,
      },
    });

    const map = new Map<string, ActiveWorkerDevice[]>();
    for (const d of devices) {
      const list = map.get(d.worker_id) || [];
      list.push(d);
      map.set(d.worker_id, list);
    }
    return map;
  }

  /**
   * Soft-revokes a specific device for a worker.
   */
  public async revokeDevice(
    workerId: string,
    deviceId: string,
  ): Promise<{ success: boolean; revokedCount: number }> {
    const result = await prisma.worker_device.updateMany({
      where: {
        worker_id: workerId,
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

    const result = await prisma.worker_device.updateMany({
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
      console.log(`[WorkerDevice] Auto-revoked ${result.count} device(s) for invalid FCM token.`);
    }

    return result.count;
  }

  /**
   * Lists all devices (active and revoked) for a worker with safe metadata.
   */
  public async listDevices(workerId: string): Promise<WorkerDeviceDTO[]> {
    const devices = await prisma.worker_device.findMany({
      where: { worker_id: workerId },
      orderBy: { last_seen_at: "desc" },
    });

    return devices.map(toWorkerDeviceDTO).filter(Boolean) as WorkerDeviceDTO[];
  }
}

export const workerDeviceService = new WorkerDeviceService();
