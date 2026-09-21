import prisma from "../../config/prisma";
import { toWorkerLocationDTO } from "../../shared/prismaSelects";

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

    if (
      typeof latitude !== "number" ||
      typeof longitude !== "number" ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      throw new WorkerLocationServiceError("Invalid geographic coordinates", 400);
    }

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
              ST_MakePoint(${longitude}, ${latitude}),
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
          ST_MakePoint(${longitude}, ${latitude}),
          4326
        )::geography
        WHERE id = ${workerLocation.id}::uuid;
      `;

      return toWorkerLocationDTO({
        id: workerLocation.id,
        worker_id: workerId,
        latitude,
        longitude,
        updated_at: now,
      });
    });
  },
};
