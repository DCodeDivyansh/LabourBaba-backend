import { Request, Response } from "express";
import { AuthenticatedRequest } from "../../middlewares/authMiddleware";
import { workerLocationService } from "./worker_location.service";

export const addLocation = async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    const workerId = authReq.user?.id;

    if (!workerId) {
      res.status(401).json({
        success: false,
        message: "Authentication required",
      });
      return;
    }

    // Defense-in-depth: explicitly reject client-supplied identity if present in body, query, or params
    if (
      (req.body as any)?.worker_id ||
      (req.body as any)?.workerId ||
      (req.query as any)?.worker_id ||
      (req.query as any)?.workerId ||
      (req.params as any)?.worker_id ||
      (req.params as any)?.workerId
    ) {
      res.status(400).json({
        success: false,
        message: "Client-controlled worker identity is not permitted",
      });
      return;
    }

    const { latitude, longitude } = req.body;

    const workerLocation = await workerLocationService.updateLocation(
      workerId,
      latitude,
      longitude
    );

    res.status(200).json({
      success: true,
      data: workerLocation,
    });
  } catch (error: any) {
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
      success: false,
      message: error.message || "Internal server error",
    });
  }
};
