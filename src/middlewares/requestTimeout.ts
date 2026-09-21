import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

export interface RequestTimeoutOptions {
  timeoutMs?: number;
}

/**
 * Request Timeout Middleware
 * Enforces a strict execution deadline for incoming HTTP requests.
 * If the handler does not finish within timeoutMs (default: 30000ms),
 * returns HTTP 504 (or 408) safely to prevent socket leaks and hanging requests.
 */
export function requestTimeout(options: RequestTimeoutOptions = {}) {
  const timeoutMs = options.timeoutMs ?? (process.env.NODE_ENV === 'test' ? 10000 : 30000);

  return (req: Request, res: Response, next: NextFunction): void => {
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (!res.headersSent) {
        logger.error(`[REQUEST_TIMEOUT] Request ${req.method} ${req.path} timed out after ${timeoutMs}ms`, {
          requestId: req.id,
          correlationId: req.correlationId,
          route: req.path,
          method: req.method,
        });

        res.status(504).json({
          success: false,
          error: {
            code: 'REQUEST_TIMEOUT',
            message: 'The request timed out before the server could process it.',
            request_id: req.id,
          },
        });
      }
    }, timeoutMs);

    // Clear timer when response finishes or closes
    const clear = () => clearTimeout(timer);
    res.on('finish', clear);
    res.on('close', clear);

    next();
  };
}
