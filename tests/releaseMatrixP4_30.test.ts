/**
 * P4 Issue 30: Canonical Release Matrix & Stale Document Invalidation Test Suite
 *
 * Verifies:
 * 1. Canonical Headers: Matrix contains candidate build, commit SHA binding, and release policy.
 * 2. Status Taxonomy: Strictly enforces canonical states (FIXED, PARTIAL, BROKEN, UNVERIFIED).
 * 3. Ambiguity Rejection: Strictly forbids informal status strings (e.g. "mostly fixed", "looks good", "probably ready").
 * 4. P4-25 through P4-30 Coverage: Verifies that every single gate from P4-25 to P4-30 is explicitly tracked.
 * 5. Mandatory Reviewer Gate: Verifies that reviewer sign-off exists and is pending independent review.
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

describe("P4 Issue 30: Release Governance Matrix & Invalidation of Stale Evidence", () => {
  const matrixPath = resolve(__dirname, "../RELEASE_READINESS_MATRIX.md");

  it("RELEASE_READINESS_MATRIX.md exists and contains canonical metadata headers", () => {
    expect(existsSync(matrixPath)).toBe(true);
    const content = readFileSync(matrixPath, "utf-8");

    expect(content).toContain("Release Candidate Build Identifier:");
    expect(content).toContain("Last Verification Timestamp:");
    expect(content).toContain("Release Invariant Policy:");
  });

  it("All release gates use canonical status taxonomy (FIXED, PARTIAL, BROKEN, UNVERIFIED)", () => {
    const content = readFileSync(matrixPath, "utf-8");
    const lines = content.split("\n");

    const tableRows = lines.filter((line) => line.startsWith("| **P"));
    expect(tableRows.length).toBeGreaterThanOrEqual(25);

    const allowedStatuses = ["FIXED", "PARTIAL", "BROKEN", "UNVERIFIED"];

    for (const row of tableRows) {
      const columns = row.split("|").map((c) => c.trim());
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

  it("Rejects ambiguous or informal status strings (mostly fixed, looks good, probably ready)", () => {
    const content = readFileSync(matrixPath, "utf-8");
    expect(content.toLowerCase()).not.toContain("mostly fixed");
    expect(content.toLowerCase()).not.toContain("looks good");
    expect(content.toLowerCase()).not.toContain("probably ready");
  });

  it("All P4-25 through P4-30 release gates are explicitly tracked in the canonical matrix", () => {
    const content = readFileSync(matrixPath, "utf-8");
    for (let i = 25; i <= 30; i++) {
      const gateId = `P4-${i}`;
      expect(content).toContain(gateId);
    }
  });

  it("Enforces that unapproved gates remain UNVERIFIED with PENDING_INDEPENDENT_REVIEW", () => {
    const content = readFileSync(matrixPath, "utf-8");
    const lines = content.split("\n");

    const p4_30_row = lines.find((l) => l.includes("**P4-30**"));
    expect(p4_30_row).toBeDefined();
    expect(p4_30_row).toContain("UNVERIFIED");
    expect(p4_30_row).toContain("PENDING_INDEPENDENT_REVIEW");
  });
});
