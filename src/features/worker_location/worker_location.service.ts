import prisma from "../../config/prisma";
import { toWorkerLocationDTO } from "../../shared/prismaSelects";
import { validateCoordinatePair } from "../../utils/coordinateValidator";

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

    return await prisma.$transaction(async (tx) => {
      // Verify worker exists and is active (not soft-deleted)
      const worker = await tx.worker.findUnique({
        where: { id: workerId },
        select: { id: true, deleted_at: true },
      });

      if (!worker || worker.deleted_at !== null) {
        throw new WorkerLocationServiceError("Worker not found or account is deactivated", 404);
      }

      // 1. Atomically update canonical current location and timestamp on Worker
      await tx.$executeRaw`
        UPDATE worker
        SET location_geo = ST_SetSRID(
              ST_MakePoint(${lon}, ${lat}),
              4326
            )::geography,
            last_location_at = ${now}
        WHERE id = ${workerId}::uuid;
      `;

      // 2. Append to worker_location history as a separate audit/tracking record
      const workerLocation = await tx.worker_location.create({
        data: {
          worker_id: workerId,
          updated_at: now,
        },
      });

      // 3. Set PostGIS geography on historical record
      await tx.$executeRaw`
        UPDATE worker_location
        SET location_geo = ST_SetSRID(
          ST_MakePoint(${lon}, ${lat}),
          4326
        )::geography
        WHERE id = ${workerLocation.id}::uuid;
      `;

      return toWorkerLocationDTO({
        id: workerLocation.id,
        worker_id: workerId,
        latitude: lat,
        longitude: lon,
        updated_at: now,
      });
    });
  },
};
