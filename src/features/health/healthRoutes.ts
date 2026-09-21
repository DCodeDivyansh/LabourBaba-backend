import { Router, Request, Response, NextFunction } from 'express';
import { healthService } from './healthService';

const router = Router();

/**
 * GET /health/live
 * Liveness Probe: Fast, zero-dependency check for process liveness.
 */
router.get('/live', (req: Request, res: Response) => {
  const result = healthService.getLiveness();
  res.status(200).json(result);
});

/**
 * GET /health/ready
 * Readiness Probe: Verifies application initialization and critical dependencies.
 */
router.get('/ready', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { isReady, result } = await healthService.getReadiness();
    res.status(isReady ? 200 : 503).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /health
 * Backwards-compatible general health endpoint.
 */
router.get('/', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
  });
});

export default router;
