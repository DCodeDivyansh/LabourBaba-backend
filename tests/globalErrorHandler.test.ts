import {
  AppError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  DependencyError,
  InternalError,
  ErrorCode
} from '../src/errors/AppError';
import { errorHandler } from '../src/middlewares/errorHandler';
import { Request, Response, NextFunction } from 'express';
import { ZodError, z } from 'zod';
import { Prisma } from '@prisma/client';
import { JsonWebTokenError, TokenExpiredError } from 'jsonwebtoken';

describe('Issue 40 - Global Safe Error Handling', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;

  beforeEach(() => {
    jsonMock = jest.fn();
    statusMock = jest.fn().mockReturnValue({ json: jsonMock });
    req = {
      id: 'req-test-123',
      correlationId: 'corr-test-456',
      method: 'GET',
      originalUrl: '/api/v1/test',
      body: {},
      params: {},
      query: {}
    };
    res = {
      status: statusMock,
      json: jsonMock,
      getHeader: jest.fn()
    };
    next = jest.fn();
  });

  describe('AppError Hierarchy', () => {
    it('instantiates custom domain errors with correct HTTP codes and error codes', () => {
      const valErr = new ValidationError('Invalid phone number', [{ field: 'phone', message: 'invalid' }]);
      expect(valErr.statusCode).toBe(400);
      expect(valErr.errorCode).toBe(ErrorCode.VALIDATION_ERROR);
      expect(valErr.publicMessage).toBe('Invalid phone number');
      expect(valErr.details).toEqual([{ field: 'phone', message: 'invalid' }]);

      const notFoundErr = new NotFoundError('Worker not found');
      expect(notFoundErr.statusCode).toBe(404);
      expect(notFoundErr.errorCode).toBe(ErrorCode.NOT_FOUND);

      const conflictErr = new ConflictError('Phone already registered');
      expect(conflictErr.statusCode).toBe(409);
      expect(conflictErr.errorCode).toBe(ErrorCode.CONFLICT);
    });
  });

  describe('Global Error Handler Middleware Mapping', () => {
    it('handles AppError and outputs safe JSON response', () => {
      const err = new UnauthorizedError('Session expired or invalid');
      errorHandler(err, req as Request, res as Response, next);

      expect(statusMock).toHaveBeenCalledWith(401);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: 'Session expired or invalid',
        error: {
          code: ErrorCode.UNAUTHORIZED,
          message: 'Session expired or invalid',
          request_id: 'req-test-123'
        }
      });
    });

    it('maps ZodError to 400 VALIDATION_ERROR with safe field details', () => {
      const schema = z.object({ age: z.number() });
      let zodErr: ZodError | null = null;
      try {
        schema.parse({ age: 'invalid_age' });
      } catch (e: any) {
        zodErr = e;
      }

      errorHandler(zodErr!, req as Request, res as Response, next);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: ErrorCode.VALIDATION_ERROR,
            message: 'Validation failed',
            details: expect.arrayContaining([
              expect.objectContaining({ field: 'age' })
            ])
          })
        })
      );
    });

    it('maps Prisma unique constraint error (P2002) to 409 CONFLICT without leaking DB internals', () => {
      const prismaErr = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`phone`)',
        {
          code: 'P2002',
          clientVersion: '5.22.0',
          meta: { target: ['phone'] }
        }
      );

      errorHandler(prismaErr, req as Request, res as Response, next);

      expect(statusMock).toHaveBeenCalledWith(409);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: 'A record with these unique details already exists.',
        error: {
          code: ErrorCode.CONFLICT,
          message: 'A record with these unique details already exists.',
          request_id: 'req-test-123'
        }
      });
    });

    it('maps Prisma not found error (P2025) to 404 RESOURCE_NOT_FOUND', () => {
      const prismaErr = new Prisma.PrismaClientKnownRequestError(
        'An operation failed because it depends on one or more records that were required but not found.',
        {
          code: 'P2025',
          clientVersion: '5.22.0'
        }
      );

      errorHandler(prismaErr, req as Request, res as Response, next);

      expect(statusMock).toHaveBeenCalledWith(404);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: 'The requested resource was not found.',
        error: {
          code: 'RESOURCE_NOT_FOUND',
          message: 'The requested resource was not found.',
          request_id: 'req-test-123'
        }
      });
    });

    it('maps JWT errors to 401 UNAUTHORIZED / INVALID_TOKEN', () => {
      const jwtErr = new JsonWebTokenError('invalid signature');
      errorHandler(jwtErr, req as Request, res as Response, next);

      expect(statusMock).toHaveBeenCalledWith(401);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: 'Authentication token is invalid.',
        error: {
          code: 'INVALID_TOKEN',
          message: 'Authentication token is invalid.',
          request_id: 'req-test-123'
        }
      });

      const expiredErr = new TokenExpiredError('jwt expired', new Date());
      errorHandler(expiredErr, req as Request, res as Response, next);

      expect(statusMock).toHaveBeenCalledWith(401);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: 'Authentication token has expired.',
        error: {
          code: 'TOKEN_EXPIRED',
          message: 'Authentication token has expired.',
          request_id: 'req-test-123'
        }
      });
    });

    it('sanitizes unknown generic exceptions to 500 INTERNAL_SERVER_ERROR and never leaks stack or SQL', () => {
      const unknownErr = new Error('SELECT * FROM "Worker" WHERE password_hash = "secret" CRASHED');
      unknownErr.stack = 'Error at Database.query (/internal/db/postgres.js:42:1)';

      errorHandler(unknownErr, req as Request, res as Response, next);

      expect(statusMock).toHaveBeenCalledWith(500);
      expect(jsonMock).toHaveBeenCalledWith({
        success: false,
        message: 'An unexpected internal error occurred.',
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An unexpected internal error occurred.',
          request_id: 'req-test-123'
        }
      });

      // Verify that no internal error message or stack trace was returned
      const payload = jsonMock.mock.calls[0][0];
      expect(JSON.stringify(payload)).not.toContain('SELECT');
      expect(JSON.stringify(payload)).not.toContain('password_hash');
      expect(JSON.stringify(payload)).not.toContain('postgres.js');
    });
  });
});
