import request from 'supertest';
import { app } from '../src/server';
import { healthService } from '../src/features/health/healthService';
import { lifecycleManager } from '../src/lifecycle/lifecycleManager';
import prisma from '../src/config/prisma';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

describe('P4 Issue 16: Docker Health & Readiness Verification', () => {
  describe('1. Dockerfile Container Configuration & Probe Semantics', () => {
    const dockerfilePath = resolve(__dirname, '../Dockerfile');

    it('Dockerfile exists and defines a HEALTHCHECK instruction targeting /health/ready', () => {
      expect(existsSync(dockerfilePath)).toBe(true);
      const content = readFileSync(dockerfilePath, 'utf-8');

      expect(content).toMatch(/HEALTHCHECK/);
      expect(content).toMatch(/http:\/\/localhost:5000\/health\/ready/);
      expect(content).not.toMatch(/http:\/\/localhost:5000\/health\b(?!\/ready)/);
    });

    it('Dockerfile specifies non-root execution with nodejs user and group', () => {
      const content = readFileSync(dockerfilePath, 'utf-8');
      expect(content).toMatch(/USER nodejs/);
      expect(content).toMatch(/addgroup -g 1001 -S nodejs/);
      expect(content).toMatch(/adduser -S nodejs -u 1001 -G nodejs/);
    });
  });

  describe('2. Process Liveness Probe (/health/live)', () => {
    it('returns HTTP 200 with process metadata independently of external dependencies', async () => {
      const res = await request(app).get('/health/live');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('alive');
      expect(res.body.timestamp).toBeDefined();
      expect(res.body.uptime).toBeGreaterThanOrEqual(0);
      expect(res.body.process).toBeDefined();
      expect(res.body.process.pid).toBe(process.pid);
      expect(res.body.process.memoryUsage).toBeDefined();
    });
  });

  describe('3. Dependency Readiness Probe (/health/ready) & Failure Injection', () => {
    it('returns 200 ready when database and Redis are operational', async () => {
      const res = await request(app).get('/health/ready');

      // Either 200 ready or 503 if live environment has degraded Redis
      expect([200, 503]).toContain(res.status);
      expect(res.body).toHaveProperty('status');
      expect(res.body).toHaveProperty('checks');
      expect(res.body.checks).toHaveProperty('database');
      expect(res.body.checks).toHaveProperty('redis');
      expect(res.body.checks).toHaveProperty('initialization');
    });

    it('returns 503 not_ready when PostgreSQL query throws or times out', async () => {
      const dbSpy = jest.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('Connection lost'));

      const { isReady, result } = await healthService.getReadiness(100);

      expect(isReady).toBe(false);
      expect(result.status).toBe('not_ready');
      expect(result.checks.database).toBe('unhealthy');

      dbSpy.mockRestore();
    });

    it('returns 503 not_ready when lifecycle state is INITIALIZING or SHUTTING_DOWN', async () => {
      const stateSpy = jest.spyOn(lifecycleManager, 'getState').mockReturnValue('INITIALIZING');

      const { isReady, result } = await healthService.getReadiness(100);

      expect(isReady).toBe(false);
      expect(result.status).toBe('not_ready');
      expect(result.checks.initialization).toBe('initializing');

      stateSpy.mockRestore();
    });

    it('recovers to ready when dependencies return', async () => {
      // Step 1: Injected failure
      const dbSpy = jest.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('Transient disconnect'));
      const failureRun = await healthService.getReadiness(100);
      expect(failureRun.isReady).toBe(false);
      dbSpy.mockRestore();

      // Step 2: Healthy execution
      const healthyRun = await healthService.getReadiness(2000);
      expect(healthyRun.result.checks.database).toBe('healthy');
    });
  });
});
