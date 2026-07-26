import { Request, Response } from "express";
import prisma from "../../config/prisma";

export const addLocation = async (req: Request, res: Response): Promise<void> => {
  try {
    const worker_id = (req as any).user?.id || req.body.worker_id;
    const { latitude, longitude } = req.body;

    if (!worker_id) {
      res.status(400).json({
        success: false,
        message: "Worker ID is required",
      });
      return;
    }

    // Create worker location record (history)
    const workerLocation = await prisma.worker_location.create({
      data: {
        worker_id,
      },
    });

    // Update worker_location geography
    await prisma.$executeRaw`
      UPDATE worker_location
      SET location_geo = ST_SetSRID(
        ST_MakePoint(${longitude}, ${latitude}),
        4326
      )::geography
      WHERE id = ${workerLocation.id}::uuid;
    `;

    // Update worker's current geography location
    await prisma.$executeRaw`
      UPDATE worker
      SET location_geo = ST_SetSRID(
        ST_MakePoint(${longitude}, ${latitude}),
        4326
      )::geography
      WHERE id = ${worker_id}::uuid;
    `;

    res.status(200).json({
      success: true,
      data: workerLocation,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};
