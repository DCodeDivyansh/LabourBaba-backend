import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { AppError } from '../errors/AppError';
import { logger } from '../utils/logger';

export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction,
): void {
  const reqLogger = req.logger || logger;
  const requestId = req.id || (res.getHeader('X-Request-ID') as string) || undefined;

  let statusCode = 500;
  let errorCode = 'INTERNAL_SERVER_ERROR';
  let clientMessage = 'An unexpected internal error occurred.';
  let validationDetails: any[] | undefined = undefined;

  // 1. CORS Origin Error
  if (err.message?.startsWith('Origin ') && err.message?.endsWith('not allowed by CORS')) {
    statusCode = 403;
    errorCode = 'FORBIDDEN_CORS_ORIGIN';
    clientMessage = 'Origin not allowed';
  }
  // 2. Custom AppError / Domain Errors
  else if (err instanceof AppError) {
    statusCode = err.statusCode;
    errorCode = err.code;
    clientMessage = err.message;
    if ((err as any).errors) {
      validationDetails = (err as any).errors;
    }
  }
  // 3. Custom Error with status / statusCode / code (e.g. legacy DispatchAcceptanceError, AuthorizationError, ReviewError)
  else if (typeof err.statusCode === 'number' || typeof err.status === 'number') {
    statusCode = err.statusCode || err.status;
    errorCode = err.code || (statusCode === 404 ? 'NOT_FOUND' : statusCode === 403 ? 'FORBIDDEN' : statusCode === 401 ? 'UNAUTHORIZED' : statusCode === 409 ? 'CONFLICT' : 'APPLICATION_ERROR');
    clientMessage = err.message || 'Request failed';
  }
  // 4. Zod Validation Error
  else if (err instanceof ZodError) {
    statusCode = 400;
    errorCode = 'VALIDATION_ERROR';
    clientMessage = 'Validation failed';
    validationDetails = err.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
      code: issue.code,
    }));
  }
  // 5. Prisma Database Errors
  else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case 'P2002':
        statusCode = 409;
        errorCode = 'CONFLICT';
        clientMessage = 'A record with these unique details already exists.';
        break;
      case 'P2025':
        statusCode = 404;
        errorCode = 'RESOURCE_NOT_FOUND';
        clientMessage = 'The requested resource was not found.';
        break;
      case 'P2003':
        statusCode = 400;
        errorCode = 'INVALID_RELATION';
        clientMessage = 'Referenced entity does not exist.';
        break;
      default:
        statusCode = 500;
        errorCode = 'DATABASE_ERROR';
        clientMessage = 'A database operation could not be completed.';
        break;
    }
  } else if (
    err instanceof Prisma.PrismaClientInitializationError ||
    err instanceof Prisma.PrismaClientRustPanicError
  ) {
    statusCode = 503;
    errorCode = 'DATABASE_UNAVAILABLE';
    clientMessage = 'Database service is temporarily unavailable.';
  }
  // 6. JWT Authentication Errors
  else if (err.name === 'JsonWebTokenError') {
    statusCode = 401;
    errorCode = 'INVALID_TOKEN';
    clientMessage = 'Authentication token is invalid.';
  } else if (err.name === 'TokenExpiredError') {
    statusCode = 401;
    errorCode = 'TOKEN_EXPIRED';
    clientMessage = 'Authentication token has expired.';
  }

  // Server-side structured error logging (retains internal context without leaking)
  reqLogger.error(`[ERROR_HANDLED] ${errorCode} (${statusCode}): ${err.message}`, {
    statusCode,
    errorCode,
    requestId,
    stack: err.stack,
    internalDetails: err.internalContext || (err instanceof Prisma.PrismaClientKnownRequestError ? { meta: err.meta } : undefined),
  });

  // Client-safe response (NEVER includes internal stack traces, DB credentials, or SQL)
  res.status(statusCode).json({
    success: false,
    message: clientMessage,
    error: {
      code: errorCode,
      message: clientMessage,
      ...(requestId ? { request_id: requestId } : {}),
      ...(validationDetails ? { details: validationDetails } : {}),
    },
  });
}
