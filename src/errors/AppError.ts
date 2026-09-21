/**
 * Canonical Application & Domain Error Hierarchy (Issue #40)
 *
 * Guarantees:
 * - Stable, machine-readable error codes.
 * - Safe client-facing messages that never leak internal database details or stack traces.
 * - Structured internal logging context.
 */

export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_INPUT: 'INVALID_INPUT',
  UNAUTHORIZED: 'UNAUTHORIZED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  INVALID_TOKEN: 'INVALID_TOKEN',
  FORBIDDEN: 'FORBIDDEN',
  FORBIDDEN_ACCESS: 'FORBIDDEN_ACCESS',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  DUPLICATE_RESOURCE: 'DUPLICATE_RESOURCE',
  SLOTS_FULL: 'SLOTS_FULL',
  BOOKING_ALREADY_EXISTS: 'BOOKING_ALREADY_EXISTS',
  REVIEW_ALREADY_EXISTS: 'REVIEW_ALREADY_EXISTS',
  RATE_LIMITED: 'RATE_LIMITED',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
  DATABASE_UNAVAILABLE: 'DATABASE_UNAVAILABLE',
  REDIS_UNAVAILABLE: 'REDIS_UNAVAILABLE',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type StandardErrorCode = typeof ErrorCode[keyof typeof ErrorCode];

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly publicMessage: string;
  public readonly isOperational: boolean;
  public readonly internalContext?: unknown;

  constructor(
    message: string,
    statusCode: number = 500,
    code: string = ErrorCode.INTERNAL_ERROR,
    internalContext?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.publicMessage = message;
    this.isOperational = true;
    this.internalContext = internalContext;
    Error.captureStackTrace(this, this.constructor);
  }

  public get errorCode(): string {
    return this.code;
  }
}

export class ValidationError extends AppError {
  public readonly errors?: any;
  public readonly details?: any;

  constructor(message: string = 'Validation failed', errors?: any) {
    super(message, 400, ErrorCode.VALIDATION_ERROR);
    this.errors = errors;
    this.details = errors;
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = 'Authentication required', code: string = ErrorCode.UNAUTHORIZED) {
    super(message, 401, code);
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = 'Access denied', code: string = ErrorCode.FORBIDDEN) {
    super(message, 403, code);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = 'Resource not found', code: string = ErrorCode.NOT_FOUND) {
    super(message, 404, code);
  }
}

export class ConflictError extends AppError {
  constructor(message: string = 'Resource conflict', code: string = ErrorCode.CONFLICT) {
    super(message, 409, code);
  }
}

export class RateLimitError extends AppError {
  constructor(message: string = 'Too many requests, please try again later', code: string = ErrorCode.RATE_LIMITED) {
    super(message, 429, code);
  }
}

export class DependencyUnavailableError extends AppError {
  constructor(message: string = 'A required service is temporarily unavailable', code: string = ErrorCode.DEPENDENCY_UNAVAILABLE) {
    super(message, 503, code);
  }
}

export const DependencyError = DependencyUnavailableError;

export class InternalServerError extends AppError {
  constructor(message: string = 'An unexpected internal error occurred', code: string = ErrorCode.INTERNAL_ERROR) {
    super(message, 500, code);
  }
}

export const InternalError = InternalServerError;
