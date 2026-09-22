import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { logger, Logger } from '../utils/logger';
import { runWithRequestContext } from '../utils/requestContext';

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

/**
 * Sanitizes an incoming correlation/request ID to prevent header injection or unbounded size.
 */
function sanitizeId(rawId?: string): string | null {
  if (!rawId || typeof rawId !== 'string') return null;
  const trimmed = rawId.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return null;
  // Allow alphanumeric characters, hyphens, underscores, dots, and colons
  if (!/^[a-zA-Z0-9\-_.@:]+$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Sanitizes request URLs by redacting signed object-storage tokens, secrets, signatures, and credentials.
 */
export function sanitizeUrlForLogging(rawUrl: string): string {
  try {
    const url = new URL(rawUrl, 'http://localhost');
    const sensitiveQueryParams = [
      'signature',
      'sig',
      'x-amz-signature',
      'x-amz-credential',
      'x-amz-security-token',
      'token',
      'access_token',
      'refreshtoken',
      'refresh_token',
      'secret',
      'key',
      'auth',
      'password',
      'otp',
    ];

    let hasRedacted = false;
    for (const [key] of Array.from(url.searchParams.entries())) {
      const lowerKey = key.toLowerCase();
      if (
        sensitiveQueryParams.includes(lowerKey) ||
        lowerKey.includes('signature') ||
        lowerKey.includes('secret') ||
        lowerKey.includes('token') ||
        lowerKey.includes('password') ||
        lowerKey.includes('credential')
      ) {
        url.searchParams.set(key, '[REDACTED]');
        hasRedacted = true;
      }
    }

    return url.pathname + (url.search ? url.search : '');
  } catch {
    return rawUrl.split('?')[0];
  }
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();
  req.startTime = startTime;

  // Extract and sanitize or generate Request ID & Correlation ID
  const incomingReqId = sanitizeId(req.headers['x-request-id'] as string | undefined);
  const incomingCorrId = sanitizeId(req.headers['x-correlation-id'] as string | undefined);

  const requestId = incomingReqId || crypto.randomUUID();
  const correlationId = incomingCorrId || requestId;

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
      workerId: (req as any).worker?.id,
    };

    // Record HTTP metrics
    try {
      const { metricsService } = require('../metrics/metrics.service');
      metricsService.recordHttpRequest(req.method, req.baseUrl ? `${req.baseUrl}${req.path}` : req.path, statusCode, durationMs);
    } catch {}

    const sanitizedUrl = sanitizeUrlForLogging(req.originalUrl || req.path);

    if (statusCode >= 500) {
      reqLogger.error(`HTTP ${req.method} ${sanitizedUrl} ${statusCode} (${durationMs}ms)`, logMeta);
    } else if (statusCode >= 400) {
      reqLogger.warn(`HTTP ${req.method} ${sanitizedUrl} ${statusCode} (${durationMs}ms)`, logMeta);
    } else {
      reqLogger.info(`HTTP ${req.method} ${sanitizedUrl} ${statusCode} (${durationMs}ms)`, logMeta);
    }
  });

  // Run downstream handlers inside the asynchronous request context
  runWithRequestContext(
    {
      requestId,
      correlationId,
      route: req.path,
      method: req.method,
      userId: (req as any).user?.id,
      workerId: (req as any).worker?.id,
    },
    () => {
      next();
    }
  );
}
