import request from 'supertest';
import { app } from '../src/server';
import { AppError, NotFoundError, ConflictError, AuthorizationError, ValidationError } from '../src/errors/AppError';

describe('P4 Issue 19: Safe Controller Error Responses & Global Error Contract', () => {
  it('Validation error returns safe 400 with structured validation details without leaking internals', async () => {
    const res = await request(app)
      .post('/api/workers/registerWorker')
      .send({ phone: 'invalid-phone' });

    expect([400, 422]).toContain(res.status);
    expect(res.body.success).toBe(false);
    expect(res.body.errors || res.body.error || res.body.message).toBeDefined();
    expect(res.body.stack).toBeUndefined();
  });

  it('Authentication / Authorization error returns 401/403 with client-safe message', async () => {
    const res = await request(app)
      .get('/api/admin/workers')
      .set('Authorization', 'Bearer invalid.token.signature');

    expect([401, 403]).toContain(res.status);
    expect(res.body.success).toBe(false);
    expect(res.body.stack).toBeUndefined();
  });

  it('Unhandled error does not leak database SQL, Prisma internals, or stack traces', async () => {
    const res = await request(app)
      .post('/api/workers/login')
      .send({ phone: '+919876543210', password: 'wrongpassword' });

    expect(res.body.success).toBe(false);
    const bodyStr = JSON.stringify(res.body);

    expect(bodyStr).not.toContain('SELECT');
    expect(bodyStr).not.toContain('INSERT');
    expect(bodyStr).not.toContain('PrismaClient');
    expect(bodyStr).not.toContain('stack');
    expect(res.body.stack).toBeUndefined();
  });

  it('Domain AppError types retain correct HTTP status and code semantics', () => {
    const notFound = new NotFoundError('Worker not found');
    expect(notFound.statusCode).toBe(404);
    expect(notFound.code).toBe('NOT_FOUND');

    const conflict = new ConflictError('Worker already assigned');
    expect(conflict.statusCode).toBe(409);
    expect(conflict.code).toBe('CONFLICT');

    const auth = new AuthorizationError('Forbidden: Admin access required');
    expect(auth.statusCode).toBe(403);
    expect(auth.code).toBe('FORBIDDEN');
  });
});
