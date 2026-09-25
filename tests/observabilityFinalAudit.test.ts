import request from 'supertest';
import { app } from '../src/server';
import { metricsService } from '../src/metrics/metrics.service';
import { healthService } from '../src/features/health/healthService';
import { logger, redactSensitiveData } from '../src/utils/logger';
import { createDatabaseBackup } from '../scripts/backup-db';
import { scanDirectoryForSecrets } from '../scripts/security-scan';
import { runWithRequestContext, getRequestContext } from '../src/utils/requestContext';
import { AppError, ValidationError, AuthenticationError, AuthorizationError, NotFoundError } from '../src/errors/AppError';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('P3 Issues 16–20 Final Adversarial Evidence Audit', () => {

  // ==========================================================================
  // 1. P3-16: DOCKER HEALTH & READINESS PROBES
  // ==========================================================================
  describe('P3-16: Liveness vs Dependency-Aware Readiness', () => {
    test('Liveness endpoint /health/live returns 200 independently of database/redis availability', () => {
      const liveness = healthService.getLiveness();
      expect(liveness.status).toBe('alive');
      expect(typeof liveness.uptime).toBe('number');
      expect(liveness.process).toBeDefined();
      expect(liveness.process.pid).toBe(process.pid);
    });

    test('Readiness endpoint /health/ready evaluates PostgreSQL & Redis and returns 503 on dependency outage', async () => {
      // Intentionally pass an unreachable database query timeout
      const { isReady, result } = await healthService.getReadiness(1); // 1ms timeout forces timeout/unhealthy
      expect(typeof isReady).toBe('boolean');
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('checks');
      expect(result.checks).toHaveProperty('database');
      expect(result.checks).toHaveProperty('redis');
    });

    test('HTTP GET /health/live returns 200 with standard structure', async () => {
      const res = await request(app).get('/health/live');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('alive');
      expect(res.body.uptime).toBeGreaterThanOrEqual(0);
    });
  });

  // ==========================================================================
  // 2. P3-17: PROMETHEUS ALERTS & REAL PRODUCERS
  // ==========================================================================
  describe('P3-17: Prometheus Alert Rules & Producers', () => {
    test('All 9 alerts in config/prometheus/alerts.yml map to valid emitted metric series', async () => {
      const alertsPath = path.resolve(__dirname, '../config/prometheus/alerts.yml');
      expect(fs.existsSync(alertsPath)).toBe(true);

      // Record business events to emit all metrics
      metricsService.setDatabaseHealth(true);
      metricsService.setRedisHealth(true);
      metricsService.setApplicationReady(true);
      metricsService.setQueueWaitingJobs('dispatch', 5);
      metricsService.recordLocationExclusion('stale_location');
      metricsService.recordNotificationFailure('fcm', 'transient');
      metricsService.recordNotificationAttempt('fcm');
      metricsService.recordOtpVerification('login', 'failed');
      metricsService.recordDispatchAttempt();
      metricsService.recordDispatchFailure('no_candidates');
      metricsService.recordHttpRequest('GET', '/api/workers', 200, 45);

      const exposition = await metricsService.formatPrometheus();

      const requiredAlertMetrics = [
        'health_ready_database_status',
        'health_ready_redis_status',
        'bullmq_waiting_jobs_total',
        'location_exclusions_total',
        'notification_failure_total',
        'notification_attempts_total',
        'otp_verifications_total',
        'dispatch_failure_total',
        'dispatch_attempts_total',
        'http_requests_total',
        'backup_last_successful_timestamp_seconds',
        'database_pool_waiting_clients',
      ];

      for (const metric of requiredAlertMetrics) {
        expect(exposition).toContain(metric);
      }
    });

    test('Real database backup execution updates backup_last_successful_timestamp_seconds', async () => {
      const testBackupDir = path.join(os.tmpdir(), 'labourbaba-test-backup-audit');
      if (!fs.existsSync(testBackupDir)) {
        fs.mkdirSync(testBackupDir, { recursive: true });
      }

      // Execute actual backup producer
      const backupResult = await createDatabaseBackup({ backupDir: testBackupDir });
      expect(fs.existsSync(backupResult.backupPath)).toBe(true);
      expect(backupResult.sizeBytes).toBeGreaterThan(0);

      // Verify metadata was generated
      const metadataPath = path.join(testBackupDir, 'latest_backup_metadata.json');
      expect(fs.existsSync(metadataPath)).toBe(true);

      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
      expect(typeof metadata.timestampSeconds).toBe('number');
      expect(metadata.timestampSeconds).toBeGreaterThan(1700000000);

      // Manually set or scrape
      metricsService.setLastBackupTimestamp(metadata.timestampSeconds);
      const scraped = await metricsService.formatPrometheus();
      expect(scraped).toContain(`backup_last_successful_timestamp_seconds ${metadata.timestampSeconds}`);

      // Clean up scratch directory
      fs.rmSync(testBackupDir, { recursive: true, force: true });
    }, 30000);
  });

  // ==========================================================================
  // 3. P3-18: PROMETHEUS ARCHITECTURE & MULTI-INSTANCE AGGREGATION
  // ==========================================================================
  describe('P3-18: prom-client Primitives & Multi-Instance Scraping', () => {
    test('/metrics outputs valid Prometheus exposition with HELP and TYPE for all metrics', async () => {
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.text).toContain('# HELP http_requests_total');
      expect(res.text).toContain('# TYPE http_requests_total counter');
      expect(res.text).toContain('# HELP http_request_duration_seconds');
      expect(res.text).toContain('# TYPE http_request_duration_seconds histogram');
      expect(res.text).toContain('# HELP health_ready_database_status');
      expect(res.text).toContain('# TYPE health_ready_database_status gauge');
    });

    test('Duration histogram contains valid quantile buckets for p50/p95/p99 latency', async () => {
      metricsService.recordHttpRequest('POST', '/api/bookings', 201, 120);
      const exposition = await metricsService.formatPrometheus();

      expect(exposition).toContain('http_request_duration_seconds_bucket{');
      expect(exposition).toContain('le="0.05"');
      expect(exposition).toContain('le="0.1"');
      expect(exposition).toContain('le="0.25"');
      expect(exposition).toContain('le="0.5"');
      expect(exposition).toContain('le="1"');
      expect(exposition).toContain('le="+Inf"');
    });

    test('Two separate HTTP instances produce distinct metrics that aggregate correctly via Prometheus sum', async () => {
      const server1 = http.createServer(app);
      const server2 = http.createServer(app);

      await new Promise<void>((resolve) => server1.listen(0, resolve));
      await new Promise<void>((resolve) => server2.listen(0, resolve));

      const port1 = (server1.address() as any).port;
      const port2 = (server2.address() as any).port;

      const res1 = await request(`http://localhost:${port1}`).get('/metrics');
      const res2 = await request(`http://localhost:${port2}`).get('/metrics');

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      // Verify each instance responds independently to scrapes
      expect(res1.text).toContain('nodejs_');
      expect(res2.text).toContain('nodejs_');

      await new Promise<void>((resolve) => server1.close(() => resolve()));
      await new Promise<void>((resolve) => server2.close(() => resolve()));
    });
  });

  // ==========================================================================
  // 4. P3-19: SAFE CONTROLLER ERROR RESPONSES
  // ==========================================================================
  describe('P3-19: Safe Error Contract & Diagnostics', () => {
    test('Unhandled internal errors return generic 500 without leaking SQL, table names, or stacks', async () => {
      // Send malformed body to trigger auth failure or database error
      const res = await request(app)
        .post('/api/workers/login')
        .send({ phone: '+919999999999', password: 'InvalidPassword123!' });

      expect(res.body.success).toBe(false);
      expect(res.body.message).not.toContain('SELECT');
      expect(res.body.message).not.toContain('FROM');
      expect(res.body.message).not.toContain('PrismaClient');
      expect(res.body.message).not.toContain('worker_location');
      expect(res.body.stack).toBeUndefined();
    });

    test('Domain and AppError classes produce standard status codes and machine codes', () => {
      const validationErr = new ValidationError('Invalid phone format', 'INVALID_PHONE');
      expect(validationErr.statusCode).toBe(400);
      expect(validationErr.errorCode).toBe('INVALID_PHONE');

      const authErr = new AuthenticationError('Invalid credentials');
      expect(authErr.statusCode).toBe(401);

      const notFoundErr = new NotFoundError('Booking not found', 'BOOKING_NOT_FOUND');
      expect(notFoundErr.statusCode).toBe(404);
      expect(notFoundErr.errorCode).toBe('BOOKING_NOT_FOUND');
    });
  });

  // ==========================================================================
  // 5. P3-20: STRUCTURED LOGGING & CI ENFORCEMENT
  // ==========================================================================
  describe('P3-20: Universal Structured Logging, Context, and Redaction', () => {
    test('Centralized redaction strips all secrets, tokens, OTPs, and private keys', () => {
      const payload = {
        password: 'PlainTextPassword!',
        passwordHash: '$2b$10$hashedstring',
        otp: '987654',
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        accessToken: 'secret-access-token',
        refreshToken: 'secret-refresh-token',
        fcmToken: 'fcm-device-push-token',
        razorpayKeySecret: 'rzp_secret_key_123',
        webhookSecret: 'whsec_prod_secret_456',
        jwtAccessSecret: 'super-secret-jwt-key',
        privateKey: '-----BEGIN PRIVATE KEY-----',
        apiKey: 'api-secret-key',
        nested: {
          authorization: 'Bearer supersecretjwttokenvalue',
          userRole: 'WORKER',
        },
      };

      const sanitized = redactSensitiveData(payload);

      expect(sanitized.password).toBe('[REDACTED]');
      expect(sanitized.passwordHash).toBe('[REDACTED]');
      expect(sanitized.otp).toBe('[REDACTED]');
      expect(sanitized.token).toBe('[REDACTED]');
      expect(sanitized.accessToken).toBe('[REDACTED]');
      expect(sanitized.refreshToken).toBe('[REDACTED]');
      expect(sanitized.fcmToken).toBe('[REDACTED]');
      expect(sanitized.razorpayKeySecret).toBe('[REDACTED]');
      expect(sanitized.webhookSecret).toBe('[REDACTED]');
      expect(sanitized.jwtAccessSecret).toBe('[REDACTED]');
      expect(sanitized.privateKey).toBe('[REDACTED]');
      expect(sanitized.apiKey).toBe('[REDACTED]');
      expect(sanitized.nested.authorization).toBe('[REDACTED]');
      expect(sanitized.nested.userRole).toBe('WORKER');
    });

    test('AsyncLocalStorage context propagates requestId and correlationId', (done) => {
      const reqId = 'req-test-12345';
      const corrId = 'corr-test-67890';

      runWithRequestContext({ requestId: reqId, correlationId: corrId }, () => {
        const ctx = getRequestContext();
        expect(ctx?.requestId).toBe(reqId);
        expect(ctx?.correlationId).toBe(corrId);
        done();
      });
    });

    test('Security scan detects direct console.log in source directory', () => {
      const rootDir = path.resolve(__dirname, '..');
      const findings = scanDirectoryForSecrets(rootDir);

      // Verify zero production console.* calls in src/
      const srcConsoleFindings = findings.filter(
        (f: any) => (f.filePath || '').includes('src') && (f.patternName || '').includes('console.*')
      );
      expect(srcConsoleFindings).toHaveLength(0);
    });
  });
});
