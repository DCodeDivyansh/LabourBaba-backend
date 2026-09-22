import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

describe('P4 Issue 25: Release Governance Matrix & Live Evidence Binding', () => {
  const matrixPath = resolve(__dirname, '../RELEASE_READINESS_MATRIX.md');

  it('RELEASE_READINESS_MATRIX.md exists and contains canonical metadata headers', () => {
    expect(existsSync(matrixPath)).toBe(true);
    const content = readFileSync(matrixPath, 'utf-8');

    expect(content).toContain('Release Candidate Build Identifier:');
    expect(content).toContain('Last Verification Timestamp:');
    expect(content).toContain('Release Invariant Policy:');
  });

  it('All gates use canonical status taxonomy (FIXED, PARTIAL, BROKEN, UNVERIFIED)', () => {
    const content = readFileSync(matrixPath, 'utf-8');
    const lines = content.split('\n');

    const tableRows = lines.filter((line) => line.startsWith('| **P'));
    expect(tableRows.length).toBeGreaterThanOrEqual(25);

    const allowedStatuses = ['FIXED', 'PARTIAL', 'BROKEN', 'UNVERIFIED'];

    for (const row of tableRows) {
      const columns = row.split('|').map((c) => c.trim());
      // Column 3 is Status
      const statusCol = columns[3];
      const hasValidStatus = allowedStatuses.some((status) => statusCol.includes(status));
      expect(hasValidStatus).toBe(true);

      // Verify reviewer sign-off column exists and is explicit
      const reviewerCol = columns[columns.length - 2];
      expect(reviewerCol).toBeDefined();
      expect(reviewerCol.length).toBeGreaterThan(0);
    }
  });

  it('Rejects ambiguous status strings (e.g., mostly fixed, looks good, probably ready)', () => {
    const content = readFileSync(matrixPath, 'utf-8');
    expect(content.toLowerCase()).not.toContain('mostly fixed');
    expect(content.toLowerCase()).not.toContain('looks good');
    expect(content.toLowerCase()).not.toContain('probably ready');
  });

  it('All P4 release gates (P4-01 through P4-25) are explicitly defined in matrix', () => {
    const content = readFileSync(matrixPath, 'utf-8');
    for (let i = 1; i <= 25; i++) {
      const gateId = `P4-${String(i).padStart(2, '0')}`;
      expect(content).toContain(gateId);
    }
  });
});
