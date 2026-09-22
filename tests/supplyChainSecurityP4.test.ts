import {
  runSecurityAudit,
  scanDependencyLockfile,
  scanDockerfileHardening,
  parseAuditOutput,
  DOCUMENTED_SECURITY_EXCEPTIONS,
  DependencyAuditSummary,
} from '../scripts/security-scan';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

describe('P4 Issue 21: Supply-Chain & Container Security Gate', () => {
  it('Lockfile dependency audit scans package-lock.json and reports vulnerability counts', () => {
    const summary = scanDependencyLockfile();
    expect(summary.scanned).toBe(true);
    expect(typeof summary.critical).toBe('number');
    expect(typeof summary.high).toBe('number');
    expect(typeof summary.unapprovedBlockingVulnerabilities).toBe('number');
    expect(summary.unapprovedBlockingVulnerabilities).toBe(0);
  });

  it('Dockerfile hardening validation enforces non-root user and dependency-aware healthcheck', () => {
    const dockerfileAudit = scanDockerfileHardening();
    expect(dockerfileAudit.hasNonRootUser).toBe(true);
    expect(dockerfileAudit.hasReadinessHealthcheck).toBe(true);
    expect(dockerfileAudit.isHardened).toBe(true);
  });

  it('Documented security exceptions have valid advisory IDs, justification, reviewer and expiration', () => {
    expect(DOCUMENTED_SECURITY_EXCEPTIONS.length).toBeGreaterThan(0);

    for (const exp of DOCUMENTED_SECURITY_EXCEPTIONS) {
      expect(exp.advisoryId).toMatch(/GHSA-[a-z0-9-]+/i);
      expect(exp.package.length).toBeGreaterThan(0);
      expect(exp.justification.length).toBeGreaterThan(10);
      expect(exp.approvedBy).toBeDefined();
      expect(new Date(exp.expiresAt).getTime()).toBeGreaterThan(Date.now());
    }
  });

  it('Negative Security Test: Expired exception causes vulnerability to become unapproved and blocking', () => {
    const mockSummary: DependencyAuditSummary = {
      scanned: true,
      totalVulnerabilities: 1,
      critical: 0,
      high: 1,
      moderate: 0,
      low: 0,
      info: 0,
      unapprovedBlockingVulnerabilities: 0,
      approvedExceptionsCount: 0,
    };

    const mockAuditPayload = JSON.stringify({
      metadata: { vulnerabilities: { high: 1, total: 1 } },
      vulnerabilities: {
        'mock-vulnerable-pkg': {
          name: 'mock-vulnerable-pkg',
          severity: 'high',
          via: [{ url: 'https://github.com/advisories/GHSA-expired-test-1234' }],
        },
      },
    });

    const expiredExceptions = [
      {
        advisoryId: 'GHSA-expired-test-1234',
        package: 'mock-vulnerable-pkg',
        severity: 'high' as const,
        justification: 'Expired test justification',
        approvedBy: 'Lead',
        expiresAt: '2020-01-01', // Already expired
      },
    ];

    parseAuditOutput(mockAuditPayload, mockSummary, expiredExceptions);
    expect(mockSummary.unapprovedBlockingVulnerabilities).toBe(1);
    expect(mockSummary.approvedExceptionsCount).toBe(0);
  });

  it('Negative Security Test: Unapproved critical vulnerability is correctly flagged as blocking', () => {
    const mockSummary: DependencyAuditSummary = {
      scanned: true,
      totalVulnerabilities: 1,
      critical: 1,
      high: 0,
      moderate: 0,
      low: 0,
      info: 0,
      unapprovedBlockingVulnerabilities: 0,
      approvedExceptionsCount: 0,
    };

    const mockAuditPayload = JSON.stringify({
      metadata: { vulnerabilities: { critical: 1, total: 1 } },
      vulnerabilities: {
        'rogue-malicious-pkg': {
          name: 'rogue-malicious-pkg',
          severity: 'critical',
          via: [{ url: 'https://github.com/advisories/GHSA-rogue-critical-9999' }],
        },
      },
    });

    parseAuditOutput(mockAuditPayload, mockSummary, DOCUMENTED_SECURITY_EXCEPTIONS);
    expect(mockSummary.unapprovedBlockingVulnerabilities).toBe(1);
  });

  it('Full security audit generates reports/security-audit-report.json with PASS status', () => {
    const result = runSecurityAudit();
    expect(result.pass).toBe(true);
    expect(result.report.status).toBe('PASS');
    expect(result.report.errors).toHaveLength(0);

    const reportFile = resolve(__dirname, '../reports/security-audit-report.json');
    expect(existsSync(reportFile)).toBe(true);

    const content = JSON.parse(readFileSync(reportFile, 'utf-8'));
    expect(content.status).toBe('PASS');
    expect(content.timestamp).toBeDefined();
  });
});
