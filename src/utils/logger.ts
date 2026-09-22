/**
 * Canonical Structured Logger (Issue #39)
 *
 * Provides:
 * - Deterministic, machine-searchable JSON output in production.
 * - Automatic redaction of sensitive credentials, tokens, OTPs, and secrets.
 * - Request and correlation ID context propagation via child loggers.
 */

import { getRequestContext } from './requestContext';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const SENSITIVE_KEYS = new Set([
  'password',
  'passwordhash',
  'otp',
  'otphash',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'cookie',
  'cookies',
  'fcmtoken',
  'devicetoken',
  'secret',
  'razorpaykeysecret',
  'razorpaykeyid',
  'paymentsecret',
  'clientsecret',
  'webhooksecret',
  'jwtaccesssecret',
  'jwtrefreshsecret',
  'privatekey',
  'apikey',
  'apikeysecret',
  'signature',
  'x-amz-signature',
  'x-amz-credential',
  'x-amz-security-token',
  'sig',
  'cvv',
  'cardnumber',
]);

const REDACTED_MASK = '[REDACTED]';

/**
 * Deeply sanitizes any object or array by redacting sensitive keys, signed URLs, and masking bearer tokens.
 */
export function redactSensitiveData(data: unknown, depth = 0): any {
  if (depth > 6 || data === null || data === undefined) {
    return data;
  }

  if (typeof data === 'string') {
    let result = data;
    // Redact bearer tokens in strings
    if (/Bearer\s+[A-Za-z0-9\-._~+/]+=*/i.test(result)) {
      result = result.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]');
    }
    // Redact sensitive query parameters in URL strings (e.g. signed object-storage URLs)
    if (result.includes('?') && /[?&](?:x-amz-signature|signature|sig|access_token|token|secret|key)=/i.test(result)) {
      result = result.replace(
        /([?&](?:x-amz-signature|signature|sig|access_token|token|secret|key)=)[^&]*/gi,
        '$1[REDACTED]'
      );
    }
    return result;
  }

  if (typeof data !== 'object') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => redactSensitiveData(item, depth + 1));
  }

  if (data instanceof Error) {
    return {
      name: data.name,
      message: data.message,
      stack: data.stack,
      ...(data as any),
    };
  }

  const sanitized: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    const isSensitive =
      SENSITIVE_KEYS.has(normalizedKey) ||
      normalizedKey.includes('password') ||
      normalizedKey.includes('otphash') ||
      normalizedKey.includes('refreshtoken') ||
      normalizedKey.includes('accesstoken') ||
      normalizedKey.includes('privatekey') ||
      normalizedKey.includes('webhooksecret') ||
      normalizedKey.includes('keysecret') ||
      normalizedKey.includes('clientsecret') ||
      normalizedKey.includes('jwtsecret');

    if (isSensitive) {
      sanitized[key] = REDACTED_MASK;
    } else {
      sanitized[key] = redactSensitiveData(value, depth + 1);
    }
  }
  return sanitized;
}

export interface LogContext {
  requestId?: string;
  correlationId?: string;
  userId?: string;
  workerId?: string;
  jobId?: string;
  bookingId?: string;
  requirementId?: string;
  route?: string;
  method?: string;
  statusCode?: number;
  durationMs?: number;
  errorCode?: string;
  [key: string]: unknown;
}

export type LogMetadata = LogContext;


export class Logger {
  private readonly defaultContext: LogContext;
  private readonly isProduction: boolean;

  constructor(defaultContext: LogContext = {}) {
    this.defaultContext = defaultContext;
    this.isProduction = process.env.NODE_ENV === 'production';
  }

  public child(context: LogContext): Logger {
    return new Logger({
      ...this.defaultContext,
      ...context,
    });
  }

  private write(level: LogLevel, message: string, meta?: LogContext | Record<string, unknown>): void {
    const asyncCtx = getRequestContext();
    const mergedMeta = {
      ...(asyncCtx?.requestId ? { requestId: asyncCtx.requestId, request_id: asyncCtx.requestId } : {}),
      ...(asyncCtx?.correlationId ? { correlationId: asyncCtx.correlationId, correlation_id: asyncCtx.correlationId } : {}),
      ...this.defaultContext,
      ...(meta || {}),
    };

    const sanitizedMeta = redactSensitiveData(mergedMeta);

    const logEntry = {
      timestamp: new Date().toISOString(),
      level: level.toUpperCase(),
      service: 'labourbaba-backend',
      environment: process.env.NODE_ENV || 'development',
      message,
      ...sanitizedMeta,
    };

    const formatted = JSON.stringify(logEntry);

    switch (level) {
      case 'error':
        process.stderr.write(formatted + '\n');
        break;
      case 'warn':
      case 'info':
      case 'debug':
      default:
        process.stdout.write(formatted + '\n');
        break;
    }
  }

  public debug(message: string, meta?: LogContext | Record<string, unknown>): void {
    if (process.env.NODE_ENV !== 'production' || process.env.LOG_LEVEL === 'debug') {
      this.write('debug', message, meta);
    }
  }

  public info(message: string, meta?: LogContext | Record<string, unknown>): void {
    this.write('info', message, meta);
  }

  public warn(message: string, meta?: LogContext | Record<string, unknown>): void {
    this.write('warn', message, meta);
  }

  public error(message: string, meta?: LogContext | Record<string, unknown>): void {
    this.write('error', message, meta);
  }

  public fatal(message: string, meta?: LogContext | Record<string, unknown>): void {
    this.write('fatal', message, meta);
  }
}

export const logger = new Logger();
