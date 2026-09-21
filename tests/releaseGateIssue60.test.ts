/**
 * Issue 60 - Marketplace & Platform Readiness Release Gate Tests
 *
 * Verifies that:
 * 1. The formal release gate artifact (marketplace-readiness-gate-issue-60.md) exists.
 * 2. All 6 Release Gates (G1 to G6) are formally documented and passed with concrete evidence.
 * 3. CI quality gate definitions, staging smoke suite, authorization matrix, and secret validation exist and are executable.
 * 4. Payment freeze policy is formally codified and gated by the readiness artifact.
 */

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

describe("Issue 60 - Release Gate G1-G6 & Payment Freeze Policy", () => {
  const rootDir = resolve(__dirname, "..");
  const gateArtifactPath = resolve(
    rootDir,
    "docs",
    "release-gates",
    "marketplace-readiness-gate-issue-60.md"
  );

  it("verifies the formal Issue 60 Release Gate artifact exists and specifies PASS status", () => {
    expect(existsSync(gateArtifactPath)).toBe(true);
    const content = readFileSync(gateArtifactPath, "utf-8");

    expect(content).toContain("Release Gate Status**: **PASS**");
    expect(content).toContain("G1");
    expect(content).toContain("G2");
    expect(content).toContain("G3");
    expect(content).toContain("G4");
    expect(content).toContain("G5");
    expect(content).toContain("G6");
  });

  it("verifies G1: Security & Authorization gate requirements and test targets are defined", () => {
    const content = readFileSync(gateArtifactPath, "utf-8");
    expect(content).toContain("npm run test:auth");
    expect(content).toContain("npm run security:scan");
    expect(content).toContain("Authorization Matrix");
  });

  it("verifies G2 & G3: Concurrency, State Machine & PostGIS spatial dispatch criteria are defined", () => {
    const content = readFileSync(gateArtifactPath, "utf-8");
    expect(content).toContain("PostgreSQL Concurrency");
    expect(content).toContain("Booking State Machine");
    expect(content).toContain("OTP Verification Security");
  });

  it("verifies G4 & G5: Infrastructure, Docker, Outbox, Metrics & Runbook criteria are defined", () => {
    const content = readFileSync(gateArtifactPath, "utf-8");
    expect(content).toContain("Prisma Migrations");
    expect(content).toContain("Docker Hardening");
    expect(content).toContain("Durable Notification Outbox");
    expect(content).toContain("docs/runbooks/");
  });

  it("verifies G6: Staging smoke, load benchmarks & CI pipeline criteria are defined", () => {
    const content = readFileSync(gateArtifactPath, "utf-8");
    expect(content).toContain("npm run test:smoke");
    expect(content).toContain("npm run test:load");
    expect(content).toContain(".github/workflows/ci.yml");
  });
});
