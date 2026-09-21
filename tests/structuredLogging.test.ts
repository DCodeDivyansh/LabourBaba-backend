import { logger, redactSensitiveData, LogMetadata } from '../src/utils/logger';
import { requestLogger } from '../src/middlewares/requestLogger';
import { Request, Response, NextFunction } from 'express';

describe('Issue 39 - Structured Logging & Redaction', () => {
  describe('Redaction Logic', () => {
    it('redacts sensitive fields like passwords, tokens, otps, and secrets', () => {
      const payload = {
        name: 'Divyansh',
        email: 'test@example.com',
        password: 'SuperSecretPassword123!',
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy',
        otp: '123456',
        secret: 'stripe_sk_live_123',
        nested: {
          authorization: 'Bearer sensitive-token-here',
          apiKey: 'key_123456',
          safeField: 'active'
        }
      };

      const redacted = redactSensitiveData(payload);

      expect(redacted.name).toBe('Divyansh');
      expect(redacted.password).toBe('[REDACTED]');
      expect(redacted.token).toBe('[REDACTED]');
      expect(redacted.otp).toBe('[REDACTED]');
      expect(redacted.secret).toBe('[REDACTED]');
      expect(redacted.nested.authorization).toBe('[REDACTED]');
      expect(redacted.nested.apiKey).toBe('[REDACTED]');
      expect(redacted.nested.safeField).toBe('active');
    });

    it('redacts Authorization Bearer string patterns if in text', () => {
      const text = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret';
      const redacted = redactSensitiveData(text);
      expect(redacted).toBe('Bearer [REDACTED]');
    });

    it('handles null, undefined, and non-object inputs safely', () => {
      expect(redactSensitiveData(null)).toBeNull();
      expect(redactSensitiveData(undefined)).toBeUndefined();
      expect(redactSensitiveData(42)).toBe(42);
    });
  });

  describe('Structured Logger Output', () => {
    it('produces formatted JSON log entries with metadata', () => {
      const spy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

      logger.info('Structured log test message', {
        request_id: 'req-12345',
        correlation_id: 'corr-67890',
        route: '/api/v1/test',
        user_id: 'usr-1'
      });

      expect(spy).toHaveBeenCalled();
      const output = spy.mock.calls[0][0].toString();
      const parsed = JSON.parse(output);

      expect(parsed.level).toBe('INFO');
      expect(parsed.message).toBe('Structured log test message');
      expect(parsed.request_id).toBe('req-12345');
      expect(parsed.correlation_id).toBe('corr-67890');
      expect(parsed.route).toBe('/api/v1/test');
      expect(parsed.user_id).toBe('usr-1');
      expect(parsed.service).toBe('labourbaba-backend');

      spy.mockRestore();
    });

    it('creates child loggers with inherited correlation context', () => {
      const spy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const child = logger.child({ correlation_id: 'child-corr-1' });

      child.info('Child log execution', { job_id: 'job-999' });

      const output = spy.mock.calls[0][0].toString();
      const parsed = JSON.parse(output);

      expect(parsed.correlation_id).toBe('child-corr-1');
      expect(parsed.job_id).toBe('job-999');

      spy.mockRestore();
    });
  });

  describe('Request Logger Middleware', () => {
    it('assigns request_id and correlation_id to req and res headers', () => {
      const req = {
        headers: {},
        method: 'GET',
        originalUrl: '/api/v1/health/live',
        ip: '127.0.0.1'
      } as unknown as Request;

      const setHeader = jest.fn();
      const end = jest.fn();
      let finishCallback: () => void = () => {};

      const res = {
        setHeader,
        statusCode: 200,
        on: jest.fn((event, cb) => {
          if (event === 'finish') {
            finishCallback = cb;
          }
        }),
        end
      } as unknown as Response;

      const next = jest.fn() as NextFunction;

      requestLogger(req, res, next);

      expect(req.id).toBeDefined();
      expect(req.correlationId).toBeDefined();
      expect(setHeader).toHaveBeenCalledWith('X-Request-ID', req.id);
      expect(setHeader).toHaveBeenCalledWith('X-Correlation-ID', req.correlationId);
      expect(next).toHaveBeenCalled();

      // Trigger finish
      const spy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
      finishCallback();
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('propagates incoming x-correlation-id header if supplied', () => {
      const incomingCorrId = 'upstream-trace-id-abc';
      const req = {
        headers: { 'x-correlation-id': incomingCorrId },
        method: 'POST',
        originalUrl: '/api/v1/auth/login',
        ip: '127.0.0.1'
      } as unknown as Request;

      const setHeader = jest.fn();
      const res = {
        setHeader,
        statusCode: 200,
        on: jest.fn()
      } as unknown as Response;

      const next = jest.fn() as NextFunction;

      requestLogger(req, res, next);

      expect(req.correlationId).toBe(incomingCorrId);
      expect(setHeader).toHaveBeenCalledWith('X-Correlation-ID', incomingCorrId);
    });
  });
});
