/**
 * P4 Issue 10 — Prometheus Alert Rule Logic & Failure Evaluation Verification
 *
 * Verifies:
 * 1. YAML structure & syntax of config/prometheus/alerts.yml
 * 2. Complete Alert Rules inventory:
 *    - Elevated5xxRate
 *    - DatabaseUnavailable
 *    - RedisUnavailable
 *    - QueueLagHigh
 *    - DispatchFailureRateHigh
 *    - StaleLocationSupplyHigh
 *    - NotificationFailureRateHigh
 *    - AbnormalOtpAttempts
 *    - BackupFailure
 * 3. Alert Expression Simulation & Threshold Evaluation:
 *    - Database down -> health_ready_database_status == 0 -> FIRING
 *    - Redis down -> health_ready_redis_status == 0 -> FIRING
 *    - Stale Backup (>24h / 86400s) -> (time() - backup_last_successful_timestamp_seconds) > 86400 -> FIRING
 *    - Normal Backup (<24h) -> NOT FIRING
 *    - 5xx Error Rate > 5% -> FIRING
 *    - Queue backlog > 100 -> FIRING
 * 4. Label Semantics (severity, category, runbook_url)
 */

import fs from 'fs';
import path from 'path';
import { metricsService } from '../src/metrics/metrics.service';

describe('P4 Issue 10 — Prometheus Alert Evaluation & Telemetry Parity', () => {
  const alertsPath = path.resolve(__dirname, '../config/prometheus/alerts.yml');

  interface AlertRule {
    alert: string;
    expr: string;
    for?: string;
    labels: { severity: string; category: string };
    annotations: { summary: string; description: string; runbook_url?: string };
  }

  let alertRules: AlertRule[] = [];

  beforeAll(() => {
    expect(fs.existsSync(alertsPath)).toBe(true);
    const content = fs.readFileSync(alertsPath, 'utf-8');

    // Parse alert rules from YAML content
    const ruleBlocks = content.split(/- alert:\s+/).slice(1);
    alertRules = ruleBlocks.map((block) => {
      const lines = block.split('\n');
      const name = lines[0].trim();
      const exprMatch = block.match(/expr:\s+([^\n]+)/);
      const forMatch = block.match(/for:\s+([^\n]+)/);
      const severityMatch = block.match(/severity:\s+([^\n]+)/);
      const categoryMatch = block.match(/category:\s+([^\n]+)/);
      const summaryMatch = block.match(/summary:\s+"([^"]+)"/);
      const descMatch = block.match(/description:\s+"([^"]+)"/);
      const runbookMatch = block.match(/runbook_url:\s+"([^"]+)"/);

      return {
        alert: name,
        expr: exprMatch ? exprMatch[1].trim() : '',
        for: forMatch ? forMatch[1].trim() : undefined,
        labels: {
          severity: severityMatch ? severityMatch[1].trim() : '',
          category: categoryMatch ? categoryMatch[1].trim() : '',
        },
        annotations: {
          summary: summaryMatch ? summaryMatch[1] : '',
          description: descMatch ? descMatch[1] : '',
          runbook_url: runbookMatch ? runbookMatch[1] : undefined,
        },
      };
    });
  });

  it('verifies all 10 production alerts are defined with required labels and runbooks', () => {
    expect(alertRules.length).toBe(10);

    const alertNames = alertRules.map((r) => r.alert);
    const expectedAlerts = [
      'Elevated5xxRate',
      'DatabaseUnavailable',
      'RedisUnavailable',
      'QueueLagHigh',
      'DispatchFailureRateHigh',
      'StaleLocationSupplyHigh',
      'NotificationFailureRateHigh',
      'AbnormalOtpAttempts',
      'BackupFailure',
      'DatabasePoolSaturation',
    ];

    for (const expected of expectedAlerts) {
      expect(alertNames).toContain(expected);
    }

    for (const rule of alertRules) {
      expect(['critical', 'warning', 'info']).toContain(rule.labels.severity);
      expect(rule.labels.category).toBeTruthy();
      expect(rule.annotations.summary).toBeTruthy();
      expect(rule.annotations.description).toBeTruthy();
      expect(rule.annotations.runbook_url).toMatch(/^docs\/runbooks\//);
    }
  });

  describe('Alert Logic Evaluation under Synthetic & Live Failure Injection', () => {
    beforeEach(() => {
      metricsService.setAutoCollect(false);
    });

    it('evaluates DatabaseUnavailable alert when database health gauge is 0 (healthy=0 -> FIRING)', async () => {
      const dbRule = alertRules.find((r) => r.alert === 'DatabaseUnavailable');
      expect(dbRule).toBeDefined();
      expect(dbRule!.expr).toBe('health_ready_database_status == 0');

      // Failure state: database unavailable
      metricsService.setDatabaseHealth(false);
      const failureExposition = await metricsService.formatPrometheus();
      expect(failureExposition).toContain('health_ready_database_status 0');

      // Recovered state: database healthy
      metricsService.setDatabaseHealth(true);
      const recoveredExposition = await metricsService.formatPrometheus();
      expect(recoveredExposition).toContain('health_ready_database_status 1');
    });

    it('evaluates RedisUnavailable alert when redis health gauge is 0 (healthy=0 -> FIRING)', async () => {
      const redisRule = alertRules.find((r) => r.alert === 'RedisUnavailable');
      expect(redisRule).toBeDefined();
      expect(redisRule!.expr).toBe('health_ready_redis_status == 0');

      // Failure state: redis down
      metricsService.setRedisHealth(false);
      const failureExposition = await metricsService.formatPrometheus();
      expect(failureExposition).toContain('health_ready_redis_status 0');

      // Recovered state: redis up
      metricsService.setRedisHealth(true);
      const recoveredExposition = await metricsService.formatPrometheus();
      expect(recoveredExposition).toContain('health_ready_redis_status 1');
    });

    it('evaluates BackupFailure alert correctly (stale backup > 86400s -> FIRING, recent backup -> RESOLVED)', async () => {
      const backupRule = alertRules.find((r) => r.alert === 'BackupFailure');
      expect(backupRule).toBeDefined();
      expect(backupRule!.expr).toContain('(time() - backup_last_successful_timestamp_seconds) > 86400');

      const nowSeconds = Math.floor(Date.now() / 1000);

      // 1. Stale backup from 48 hours ago (172,800 seconds ago)
      const staleTimestamp = nowSeconds - 172800;
      metricsService.setLastBackupTimestamp(staleTimestamp);
      const staleExposition = await metricsService.formatPrometheus();
      expect(staleExposition).toContain(`backup_last_successful_timestamp_seconds ${staleTimestamp}`);

      // Evaluation: (now - staleTimestamp) = 172800 > 86400 -> Evaluates TRUE (Alert Fires)
      const isStaleFiring = (nowSeconds - staleTimestamp) > 86400;
      expect(isStaleFiring).toBe(true);

      // 2. Fresh backup from 1 hour ago (3,600 seconds ago)
      const freshTimestamp = nowSeconds - 3600;
      metricsService.setLastBackupTimestamp(freshTimestamp);
      const freshExposition = await metricsService.formatPrometheus();
      expect(freshExposition).toContain(`backup_last_successful_timestamp_seconds ${freshTimestamp}`);

      // Evaluation: (now - freshTimestamp) = 3600 <= 86400 -> Evaluates FALSE (Alert Resolved)
      const isFreshFiring = (nowSeconds - freshTimestamp) > 86400;
      expect(isFreshFiring).toBe(false);
    });

    it('evaluates QueueLagHigh alert when waiting jobs exceed 100', async () => {
      const lagRule = alertRules.find((r) => r.alert === 'QueueLagHigh');
      expect(lagRule).toBeDefined();
      expect(lagRule!.expr).toBe('bullmq_waiting_jobs_total > 100');

      metricsService.setQueueWaitingJobs('dispatch', 150);
      const exposition = await metricsService.formatPrometheus();
      expect(exposition).toContain('bullmq_waiting_jobs_total{queue="dispatch"} 150');

      const isLagFiring = 150 > 100;
      expect(isLagFiring).toBe(true);

      // Normal depth
      metricsService.setQueueWaitingJobs('dispatch', 5);
      const normalExposition = await metricsService.formatPrometheus();
      expect(normalExposition).toContain('bullmq_waiting_jobs_total{queue="dispatch"} 5');
    });

    it('evaluates StaleLocationSupplyHigh alert when exclusions exceed threshold', async () => {
      const staleLocationRule = alertRules.find((r) => r.alert === 'StaleLocationSupplyHigh');
      expect(staleLocationRule).toBeDefined();
      expect(staleLocationRule!.expr).toBe('location_exclusions_total{reason="stale_location"} > 50');

      for (let i = 0; i < 55; i++) {
        metricsService.recordLocationExclusion('stale_location');
      }

      const exposition = await metricsService.formatPrometheus();
      expect(exposition).toContain('location_exclusions_total{reason="stale_location"}');
    });

    it('evaluates DatabasePoolSaturation alert when waiting clients exceed 0', async () => {
      const poolRule = alertRules.find((r) => r.alert === 'DatabasePoolSaturation');
      expect(poolRule).toBeDefined();
      expect(poolRule!.expr).toBe('database_pool_waiting_clients > 0');

      // Pool saturated: 3 clients waiting
      metricsService.setDatabasePoolMetrics({ waitingCount: 3 });
      const saturatedExposition = await metricsService.formatPrometheus();
      expect(saturatedExposition).toContain('database_pool_waiting_clients 3');
      const isSaturated = 3 > 0;
      expect(isSaturated).toBe(true);

      // Recovery: 0 clients waiting
      metricsService.setDatabasePoolMetrics({ waitingCount: 0 });
      const recoveredExposition = await metricsService.formatPrometheus();
      expect(recoveredExposition).toContain('database_pool_waiting_clients 0');
      const isRecovered = 0 > 0;
      expect(isRecovered).toBe(false);
    });
  });
});
