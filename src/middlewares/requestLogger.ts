import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { logger, Logger } from '../utils/logger';

declare global {
  namespace Express {
    interface Request {
      id?: string;
      correlationId?: string;
      logger?: Logger;
      startTime?: number;
    }
  }
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();
  req.startTime = startTime;

  // Extract or generate Request ID & Correlation ID
  const incomingReqId = req.headers['x-request-id'] as string | undefined;
  const incomingCorrId = req.headers['x-correlation-id'] as string | undefined;

  const requestId = incomingReqId?.trim() || crypto.randomUUID();
  const correlationId = incomingCorrId?.trim() || requestId;

  req.id = requestId;
  req.correlationId = correlationId;

  // Attach headers to response for client tracing
  res.setHeader('X-Request-ID', requestId);
  res.setHeader('X-Correlation-ID', correlationId);

  // Attach child logger to request
  const reqLogger = logger.child({
    requestId,
    correlationId,
    route: req.path,
    method: req.method,
  });
  req.logger = reqLogger;

  // Log on response completion
  res.on('finish', () => {
    const durationMs = Date.now() - startTime;
    const statusCode = res.statusCode;

    const logMeta = {
      statusCode,
      durationMs,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      userId: (req as any).user?.id,
    };

    if (statusCode >= 500) {
      reqLogger.error(`HTTP ${req.method} ${req.originalUrl || req.path} ${statusCode} (${durationMs}ms)`, logMeta);
    } else if (statusCode >= 400) {
      reqLogger.warn(`HTTP ${req.method} ${req.originalUrl || req.path} ${statusCode} (${durationMs}ms)`, logMeta);
    } else {
      reqLogger.info(`HTTP ${req.method} ${req.originalUrl || req.path} ${statusCode} (${durationMs}ms)`, logMeta);
    }
  });

  next();
}
