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

    return await prisma.$transaction(async (tx) => {
      // Verify worker exists and is active (not soft-deleted)
      const worker = await tx.worker.findUnique({
        where: { id: workerId },
        select: { id: true, deleted_at: true },
      });

      if (!worker || worker.deleted_at !== null) {
        throw new WorkerLocationServiceError("Worker not found or account is deactivated", 404);
      }

      // 1. Create worker_location historical record
      const workerLocation = await tx.worker_location.create({
        data: {
          worker_id: workerId,
        },
      });

      // 2. Set PostGIS geography on historical record (SRID 4326, Point(lon, lat))
      await tx.$executeRaw`
        UPDATE worker_location
        SET location_geo = ST_SetSRID(
          ST_MakePoint(${longitude}, ${latitude}),
          4326
        )::geography
        WHERE id = ${workerLocation.id}::uuid;
      `;

      // 3. Set PostGIS geography on current worker record
      await tx.$executeRaw`
        UPDATE worker
        SET location_geo = ST_SetSRID(
          ST_MakePoint(${longitude}, ${latitude}),
          4326
        )::geography
        WHERE id = ${workerId}::uuid;
      `;

      return toWorkerLocationDTO({
        worker_id: workerLocation.worker_id,
        latitude,
        longitude,
        updated_at: workerLocation.updated_at,
      });
    });
  },
};
