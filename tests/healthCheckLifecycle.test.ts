import request from 'supertest';
import { app } from '../src/server';
import { healthService } from '../src/features/health/healthService';
import { lifecycleManager } from '../src/lifecycle/lifecycleManager';
import prisma from '../src/config/prisma';
import { getRedisClient } from '../src/config/redis';

describe('Issue #36: Separate Liveness and Readiness Probes', () => {
  let redisPingSpy: jest.SpyInstance;
  let dbQuerySpy: jest.SpyInstance;

  beforeEach(() => {
    (lifecycleManager as any).state = 'READY';
    (lifecycleManager as any).isShuttingDown = false;
    // Default happy path mocks for health check probes
    dbQuerySpy = jest.spyOn(prisma, '$queryRaw').mockResolvedValue([{ 1: 1 }] as any);
    redisPingSpy = jest.spyOn(getRedisClient(), 'ping').mockResolvedValue('PONG');
  });

  afterEach(() => {
    dbQuerySpy.mockRestore();
    redisPingSpy.mockRestore();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('GET /health/live returns 200 OK with process liveness without checking external dependencies', async () => {
    const res = await request(app).get('/health/live');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'ok');
    expect(res.body).toHaveProperty('timestamp');
    expect(res.body).toHaveProperty('uptime');
    expect(typeof res.body.uptime).toBe('number');
  });

  test('GET /health/ready returns 200 ready when application and dependencies are healthy', async () => {
    const res = await request(app).get('/health/ready');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.checks.database).toBe('healthy');
    expect(res.body.checks.redis).toBe('healthy');
    expect(res.body.checks.initialization).toBe('ready');
  });

  test('GET /health/ready returns 503 not_ready when database is unavailable', async () => {
    dbQuerySpy.mockRejectedValueOnce(new Error('Connection refused to postgres'));

    const res = await request(app).get('/health/ready');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
    expect(res.body.checks.database).toBe('unhealthy');
    expect(res.body.checks.redis).toBe('healthy');

    // Ensure no raw database error message or credentials are leaked to client
    expect(JSON.stringify(res.body)).not.toContain('Connection refused to postgres');
    expect(JSON.stringify(res.body)).not.toContain('password');
  });

  test('GET /health/ready returns 503 not_ready when Redis is unavailable', async () => {
    redisPingSpy.mockRejectedValueOnce(new Error('Redis connection timeout'));

    const res = await request(app).get('/health/ready');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
    expect(res.body.checks.database).toBe('healthy');
    expect(res.body.checks.redis).toBe('unhealthy');

    // Ensure no internal Redis error is leaked
    expect(JSON.stringify(res.body)).not.toContain('Redis connection timeout');
  });

  test('GET /health/ready returns 503 when application is still initializing or shutting down', async () => {
    (lifecycleManager as any).state = 'INITIALIZING';

    const res = await request(app).get('/health/ready');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
    expect(res.body.checks.initialization).toBe('initializing');
  });

  test('GET /health/live succeeds even during database outage', async () => {
    dbQuerySpy.mockRejectedValueOnce(new Error('Fatal DB crash'));

    const res = await request(app).get('/health/live');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
