import { loadSoakHarness } from "./load/loadSoakHarness";

describe("Issue 55 - Production Load & Soak Testing", () => {
  jest.setTimeout(60000);

  describe("Scenario A: Worker Location Ingestion Under Concurrency", () => {
    it("handles concurrent worker GPS updates with high throughput and bounded latency", async () => {
      const metrics = await loadSoakHarness.runLocationIngestionLoad(15, 4);

      expect(metrics.totalOperations).toBe(60);
      expect(metrics.failedOperations).toBe(0);
      expect(metrics.successfulOperations).toBe(60);
      expect(metrics.throughputRps).toBeGreaterThan(0);
      // Ensure p95 latency is bounded
      expect(metrics.p95LatencyMs).toBeLessThan(5000);
    });
  });

  describe("Scenario B: Job Creation Under Concurrency", () => {
    it("creates jobs concurrently with zero error rate", async () => {
      const metrics = await loadSoakHarness.runJobCreationLoad(20);

      expect(metrics.totalOperations).toBe(20);
      expect(metrics.failedOperations).toBe(0);
      expect(metrics.successfulOperations).toBe(20);
      expect(metrics.throughputRps).toBeGreaterThan(0);
      expect(metrics.p95LatencyMs).toBeLessThan(5000);
    });
  });
});
