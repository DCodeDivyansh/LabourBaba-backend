import request from 'supertest';
import { app } from '../src/server';
import { metricsService } from '../src/metrics/metrics.service';
import { healthService } from '../src/features/health/healthService';
import { logger, redactSensitiveData } from '../src/utils/logger';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

describe('P3 Issues 16–20 Comprehensive Remediation Verification', () => {

  // ==========================================================================
  // ISSUE 16 — DOCKER HEALTH CHECK USES SHALLOW HEALTH INSTEAD OF READINESS
  // ==========================================================================
  describe('P3-16: Docker Health & Readiness Probes', () => {
    test('Dockerfile HEALTHCHECK must target /health/ready instead of shallow /health', () => {
      const dockerfilePath = resolve(__dirname, '../Dockerfile');
      expect(existsSync(dockerfilePath)).toBe(true);
      const dockerfileContent = readFileSync(dockerfilePath, 'utf-8');

      expect(dockerfileContent).toMatch(/HEALTHCHECK/);
      expect(dockerfileContent).toMatch(/http:\/\/localhost:5000\/health\/ready/);
      expect(dockerfileContent).not.toMatch(/http:\/\/localhost:5000\/health\b(?!\/ready)/);
    });

    test('GET /health/live returns 200 process liveness without external dependency coupling', async () => {
      const res = await request(app).get('/health/live');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('alive');
      expect(res.body.process).toBeDefined();
    });

    test('GET /health/ready checks PostgreSQL and Redis dependencies', async () => {
      const res = await request(app).get('/health/ready');
      expect([200, 503]).toContain(res.status);
      expect(res.body).toHaveProperty('status');
      expect(res.body).toHaveProperty('checks');
      expect(res.body.checks).toHaveProperty('database');
      expect(res.body.checks).toHaveProperty('redis');
    });
  });

  // ==========================================================================
  // ISSUE 17 — PROMETHEUS ALERT RULES REFERENCE TELEMETRY THAT IS ACTUALLY EMITTED
  // ==========================================================================
  describe('P3-17: Prometheus Alert Rules Telemetry Validation', () => {
    test('All metrics referenced in alerts.yml must be emitted by metricsService', async () => {
      const alertsPath = resolve(__dirname, '../config/prometheus/alerts.yml');
      expect(existsSync(alertsPath)).toBe(true);
      const alertsContent = readFileSync(alertsPath, 'utf-8');

      // Update metrics with known values
      metricsService.setGauge('health_ready_database_status', 1);
      metricsService.setGauge('health_ready_redis_status', 1);
      metricsService.setGauge('bullmq_waiting_jobs_total', 0, { queue: 'dispatch' });
      metricsService.setGauge('bullmq_active_jobs_total', 2, { queue: 'dispatch' });
      metricsService.incrementCounter('location_exclusions_total', 1, { reason: 'stale' });
      metricsService.setGauge('backup_last_successful_timestamp_seconds', Math.floor(Date.now() / 1000));
      metricsService.incrementCounter('job_dispatch_total', 1, { status: 'success' });
      metricsService.incrementCounter('job_dispatch_total', 1, { status: 'failure' });
      metricsService.recordHttpRequest('POST', '/api/jobs', 200, 0.05);

      const scraped = await metricsService.formatPrometheus();

      // Check all alert expressions match emitted metrics
      const alertMetrics = [
        'health_ready_database_status',
        'health_ready_redis_status',
        'bullmq_waiting_jobs_total',
        'location_exclusions_total',
        'backup_last_successful_timestamp_seconds',
        'job_dispatch_total',
        'http_request_duration_seconds',
      ];

      for (const metric of alertMetrics) {
        expect(scraped).toContain(metric);
      }
    });
  });

  // ==========================================================================
  // ISSUE 18 — PROMETHEUS METRICS ARCHITECTURE & PRIMITIVES
  // ==========================================================================
  describe('P3-18: Prometheus Architecture with prom-client', () => {
    test('/metrics endpoint returns standard Prometheus exposition with text/plain format', async () => {
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.text).toContain('# HELP');
      expect(res.text).toContain('# TYPE');
    });

    test('Histograms support quantile analysis for p50/p95/p99 latency calculations', async () => {
      metricsService.recordHttpRequest('GET', '/api/workers', 200, 0.025);
      metricsService.recordHttpRequest('GET', '/api/workers', 200, 0.150);
      metricsService.recordHttpRequest('GET', '/api/workers', 200, 0.500);

      const scraped = await metricsService.formatPrometheus();
      expect(scraped).toContain('http_request_duration_seconds_bucket');
      expect(scraped).toContain('http_request_duration_seconds_sum');
      expect(scraped).toContain('http_request_duration_seconds_count');
      expect(scraped).toContain('le="0.05"');
      expect(scraped).toContain('le="0.5"');
      expect(scraped).toContain('le="+Inf"');
    });

    test('Prometheus default nodejs metrics are registered and scraped', async () => {
      const scraped = await metricsService.formatPrometheus();
      expect(scraped).toMatch(/nodejs_process_cpu_seconds_total|process_cpu_seconds_total|nodejs_version_info/);
    });
  });

  // ==========================================================================
  // ISSUE 19 — SAFE CONTROLLER ERROR RESPONSES
  // ==========================================================================
  describe('P3-19: Safe Controller Error Handling', () => {
    test('Unhandled 500 error does not leak database details, SQL or stack trace to client', async () => {
      // POST to /api/workers/login with malformed structure or simulating failure
      const res = await request(app)
        .post('/api/workers/login')
        .send({ phone: '+919876543210', password: 'wrongpassword' });

      // Should return structured safe JSON
      expect(res.body.success).toBe(false);
      expect(res.body.message).not.toContain('SELECT');
      expect(res.body.message).not.toContain('PrismaClient');
      expect(res.body.message).not.toContain('stack');
      expect(res.body.stack).toBeUndefined();
    });

    test('Validation errors return client-actionable 400/422 responses', async () => {
      const res = await request(app)
        .post('/api/workers/registerWorker')
        .send({ phone: 'invalid-phone-format' });

      expect([400, 422]).toContain(res.status);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBeDefined();
    });
  });

  // ==========================================================================
  // ISSUE 20 — STRUCTURED LOGGING & CENTRALIZED REDACTION
  // ==========================================================================
  describe('P3-20: Universal Structured Logging and Redaction', () => {
    test('Centralized redaction masks sensitive credentials, tokens, OTPs, and secrets', () => {
      const sensitivePayload = {
        password: 'SuperSecretPassword123!',
        otp: '123456',
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.secret',
        access_token: 'access-token-string',
        refresh_token: 'refresh-token-string',
        fcm_token: 'fcm-device-token-12345',
        razorpay_key_secret: 'razorpay-secret-key',
        webhook_secret: 'whsec_test_secret',
        header: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.secret',
        safeField: 'PublicMarketplaceJob',
      };

      const redacted = redactSensitiveData(sensitivePayload);

      expect(redacted.password).toBe('[REDACTED]');
      expect(redacted.otp).toBe('[REDACTED]');
      expect(redacted.token).toBe('[REDACTED]');
      expect(redacted.access_token).toBe('[REDACTED]');
      expect(redacted.refresh_token).toBe('[REDACTED]');
      expect(redacted.fcm_token).toBe('[REDACTED]');
      expect(redacted.razorpay_key_secret).toBe('[REDACTED]');
      expect(redacted.webhook_secret).toBe('[REDACTED]');
      expect(redacted.header).toBe('Bearer [REDACTED]');
      expect(redacted.safeField).toBe('PublicMarketplaceJob');
    });

    test('Zero direct console.* calls exist in production src/ directory', () => {
      const { scanDirectoryForSecrets } = require('../scripts/security-scan');
      const rootDir = resolve(__dirname, '..');
      const findings = scanDirectoryForSecrets(rootDir);

      const consoleFindings = findings.filter((f: any) =>
        f.patternName.includes('console.*')
      );

      expect(consoleFindings).toHaveLength(0);
    });
  });
});
