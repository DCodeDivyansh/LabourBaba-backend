/**
 * Canonical Structured Logger (Issue #39)
 *
 * Provides:
 * - Deterministic, machine-searchable JSON output in production.
 * - Automatic redaction of sensitive credentials, tokens, OTPs, and secrets.
 * - Request and correlation ID context propagation via child loggers.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const SENSITIVE_KEYS = new Set([
  'password',
  'password_hash',
  'passwordhash',
  'otp',
  'otp_hash',
  'otphash',
  'token',
  'access_token',
  'accesstoken',
  'refresh_token',
  'refreshtoken',
  'authorization',
  'cookie',
  'cookies',
  'fcm_token',
  'fcmtoken',
  'device_token',
  'devicetoken',
  'secret',
  'razorpay_key_secret',
  'razorpay_key_id',
  'webhook_secret',
  'jwt_access_secret',
  'jwt_refresh_secret',
  'private_key',
  'apikey',
  'api_key',
]);

const REDACTED_MASK = '[REDACTED]';

/**
 * Deeply sanitizes any object or array by redacting sensitive keys and masking bearer tokens.
 */
export function redactSensitiveData(data: unknown, depth = 0): any {
  if (depth > 6 || data === null || data === undefined) {
    return data;
  }

  if (typeof data === 'string') {
    // Redact bearer tokens in strings
    if (/Bearer\s+[A-Za-z0-9\-._~+/]+=*/i.test(data)) {
      return data.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]');
    }
    return data;
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
    if (SENSITIVE_KEYS.has(normalizedKey)) {
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
    const mergedMeta = {
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
}

export const logger = new Logger();
