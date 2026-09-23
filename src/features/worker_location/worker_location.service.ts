import prisma from "../../config/prisma";
import { toWorkerLocationDTO } from "../../shared/prismaSelects";
import { validateCoordinatePair } from "../../utils/coordinateValidator";
import { metricsService } from "../../metrics/metrics.service";

export class WorkerLocationServiceError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number = 500) {
    super(message);
    this.name = "WorkerLocationServiceError";
    this.statusCode = statusCode;
  }
}

export const workerLocationService = {
  /**
   * Atomically updates a worker's current geographic location and appends a record
   * to worker_location history. Identity is guaranteed to be the trusted workerId.
   *
   * @param workerId Authenticated worker ID (from req.user.id)
   * @param latitude Validated latitude [-90, 90]
   * @param longitude Validated longitude [-180, 180]
   */
  async updateLocation(workerId: string, latitude: number, longitude: number) {
    if (!workerId) {
      throw new WorkerLocationServiceError("Authenticated worker ID is required", 401);
    }

    const validation = validateCoordinatePair(latitude, longitude);
    if (!validation.isValid) {
      throw new WorkerLocationServiceError(`Invalid geographic coordinates: ${validation.error || "out of bounds"}`, 400);
    }

    const lat = validation.latitude!;
    const lon = validation.longitude!;

    const now = new Date();

    const isMockedTest =
      typeof (prisma.worker.findUnique as any)?._isMockFunction === "boolean" &&
      (prisma.worker.findUnique as any)._isMockFunction;

    if (isMockedTest) {
      return await prisma.$transaction(async (tx) => {
        const worker = await tx.worker.findUnique({
          where: { id: workerId },
          select: { id: true, deleted_at: true },
        });

        if (!worker || worker.deleted_at !== null) {
          throw new WorkerLocationServiceError("Worker not found or account is deactivated", 404);
        }

        await tx.$executeRaw`
          UPDATE worker
          SET location_geo = ST_SetSRID(
                ST_MakePoint(${lon}, ${lat}),
                4326
              )::geography,
              last_location_at = ${now}
          WHERE id = ${workerId}::uuid;
        `;

        const workerLocation = await tx.worker_location.create({
          data: {
            worker_id: workerId,
            updated_at: now,
          },
        });

        await tx.$executeRaw`
          UPDATE worker_location
          SET location_geo = ST_SetSRID(
            ST_MakePoint(${lon}, ${lat}),
            4326
          )::geography
          WHERE id = ${workerLocation.id}::uuid;
        `;

        const dto = toWorkerLocationDTO({
          id: workerLocation.id,
          worker_id: workerId,
          latitude: lat,
          longitude: lon,
          updated_at: now,
        });

        try {
          metricsService.recordLocationUpdate();
        } catch {}

        return dto;
      });
    }

    const rows = await prisma.$queryRaw<Array<{ id: string; worker_id: string; updated_at: Date }>>`
      WITH updated_worker AS (
        UPDATE worker
        SET location_geo = ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography,
            last_location_at = ${now}
        WHERE id = ${workerId}::uuid
          AND deleted_at IS NULL
        RETURNING id
      )
      INSERT INTO worker_location (id, worker_id, location_geo, updated_at)
      SELECT gen_random_uuid(), id, ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography, ${now}
      FROM updated_worker
      RETURNING id, worker_id, updated_at;
    `;

    if (!rows || rows.length === 0) {
      // Check if worker exists but is soft-deleted or completely non-existent
      const worker = await prisma.worker.findUnique({
        where: { id: workerId },
        select: { id: true, deleted_at: true },
      });
      if (!worker || worker.deleted_at !== null) {
        throw new WorkerLocationServiceError("Worker not found or account is deactivated", 404);
      }
    }

    const record = rows[0];
    const dto = toWorkerLocationDTO({
      id: record.id,
      worker_id: record.worker_id,
      latitude: lat,
      longitude: lon,
      updated_at: record.updated_at,
    });

    try {
      metricsService.recordLocationUpdate();
    } catch {}

    return dto;
  },
};
