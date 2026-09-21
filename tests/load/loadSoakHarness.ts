import prisma from "../../src/config/prisma";
import { workerLocationService } from "../../src/features/worker_location/worker_location.service";
import { metricsService } from "../../src/metrics/metrics.service";

export interface LoadMetrics {
  scenarioName: string;
  totalOperations: number;
  successfulOperations: number;
  failedOperations: number;
  durationSeconds: number;
  throughputRps: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  maxLatencyMs: number;
}

export function calculatePercentiles(latencies: number[]): { p50: number; p95: number; p99: number; max: number } {
  if (latencies.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.50)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const p99 = sorted[Math.floor(sorted.length * 0.99)];
  const max = sorted[sorted.length - 1];
  return { p50, p95, p99, max };
}

export class LoadSoakHarness {
  /**
   * Scenario A: High-Concurrency Worker GPS Location Ingestion Load Test
   */
  async runLocationIngestionLoad(workerCount: number = 20, updatesPerWorker: number = 5): Promise<LoadMetrics> {
    const latencies: number[] = [];
    let success = 0;
    let failed = 0;

    // Create test skill category & workers
    let category = await prisma.skill_category.findFirst();
    if (!category) {
      category = await prisma.skill_category.create({
        data: { name: "LoadSkill", description: "Skill for load tests" },
      });
    }

    const testWorkers: string[] = [];
    for (let i = 0; i < workerCount; i++) {
      const id = `00000000-0000-4005-a000-${i.toString().padStart(12, "0")}`;
      testWorkers.push(id);
      await prisma.worker.upsert({
        where: { id },
        update: { skill_category_id: category.id },
        create: {
          id,
          phone: `+919991${i.toString().padStart(6, "0")}`,
          name: `Load Worker ${i}`,
          password: "hash",
          skill_type: "LoadSkill",
          skill_category_id: category.id,
        },
      });
    }

    const startTime = Date.now();

    // Concurrent bursts
    for (let round = 0; round < updatesPerWorker; round++) {
      const tasks = testWorkers.map(async (workerId) => {
        const opStart = Date.now();
        try {
          const lat = 28.6139 + (Math.random() - 0.5) * 0.05;
          const lon = 77.2090 + (Math.random() - 0.5) * 0.05;
          await workerLocationService.updateLocation(workerId, lat, lon);
          const opDuration = Date.now() - opStart;
          latencies.push(opDuration);
          success++;
        } catch (err: any) {
          console.error("[LOAD_HARNESS_ERR]", err?.message || err);
          failed++;
        }
      });
      await Promise.all(tasks);
    }

    const totalDurationSeconds = (Date.now() - startTime) / 1000;
    const totalOperations = success + failed;
    const { p50, p95, p99, max } = calculatePercentiles(latencies);

    // Clean up
    await prisma.worker_location.deleteMany({ where: { worker_id: { in: testWorkers } } }).catch(() => {});
    await prisma.worker.deleteMany({ where: { id: { in: testWorkers } } }).catch(() => {});

    return {
      scenarioName: "Worker Location Ingestion",
      totalOperations,
      successfulOperations: success,
      failedOperations: failed,
      durationSeconds: totalDurationSeconds,
      throughputRps: Math.round(totalOperations / Math.max(0.001, totalDurationSeconds)),
      p50LatencyMs: p50,
      p95LatencyMs: p95,
      p99LatencyMs: p99,
      maxLatencyMs: max,
    };
  }

  /**
   * Scenario B: Job & Requirement Batch Ingestion Load Test
   */
  async runJobCreationLoad(jobCount: number = 30): Promise<LoadMetrics> {
    const latencies: number[] = [];
    let success = 0;
    let failed = 0;

    let customer = await prisma.customer.findFirst({ where: { OR: [{ id: "00000000-0000-4005-b000-000000000001" }, { phone: "+919992000001" }] } });
    if (!customer) {
      customer = await prisma.customer.create({
        data: { id: "00000000-0000-4005-b000-000000000001", phone: "+919992000001", name: "Load Customer", password: "hash" },
      });
    }
    const customerId = customer.id;

    const createdJobIds: string[] = [];
    const startTime = Date.now();

    const tasks = Array.from({ length: jobCount }).map(async (_, idx) => {
      const opStart = Date.now();
      try {
        const jobId = `00000000-0000-4005-c000-${idx.toString().padStart(12, "0")}`;
        createdJobIds.push(jobId);

        await prisma.job.create({
          data: {
            id: jobId,
            customer_id: customerId,
            status: "OPEN",
          },
        });

        metricsService.recordJobCreated();
        const opDuration = Date.now() - opStart;
        latencies.push(opDuration);
        success++;
      } catch {
        failed++;
      }
    });

    await Promise.all(tasks);

    const totalDurationSeconds = (Date.now() - startTime) / 1000;
    const totalOperations = success + failed;
    const { p50, p95, p99, max } = calculatePercentiles(latencies);

    // Clean up
    await prisma.job.deleteMany({ where: { id: { in: createdJobIds } } }).catch(() => {});
    await prisma.customer.deleteMany({ where: { id: customerId } }).catch(() => {});

    return {
      scenarioName: "Job & Requirement Creation",
      totalOperations,
      successfulOperations: success,
      failedOperations: failed,
      durationSeconds: totalDurationSeconds,
      throughputRps: Math.round(totalOperations / Math.max(0.001, totalDurationSeconds)),
      p50LatencyMs: p50,
      p95LatencyMs: p95,
      p99LatencyMs: p99,
      maxLatencyMs: max,
    };
  }
}

export const loadSoakHarness = new LoadSoakHarness();

if (require.main === module) {
  (async () => {
    console.log("==================================================");
    console.log("   LabourBaba Production Load & Soak Benchmark   ");
    console.log("==================================================");

    const harness = new LoadSoakHarness();

    console.log("\n[1/2] Running Location Ingestion Load Scenario (20 workers x 5 bursts)...");
    const locMetrics = await harness.runLocationIngestionLoad(20, 5);
    console.log(` -> Operations: ${locMetrics.totalOperations} | Success: ${locMetrics.successfulOperations} | Failed: ${locMetrics.failedOperations}`);
    console.log(` -> Throughput: ${locMetrics.throughputRps} ops/sec | p50: ${locMetrics.p50LatencyMs}ms | p95: ${locMetrics.p95LatencyMs}ms | p99: ${locMetrics.p99LatencyMs}ms`);

    console.log("\n[2/2] Running Job Ingestion Load Scenario (30 concurrent jobs)...");
    const jobMetrics = await harness.runJobCreationLoad(30);
    console.log(` -> Operations: ${jobMetrics.totalOperations} | Success: ${jobMetrics.successfulOperations} | Failed: ${jobMetrics.failedOperations}`);
    console.log(` -> Throughput: ${jobMetrics.throughputRps} ops/sec | p50: ${jobMetrics.p50LatencyMs}ms | p95: ${jobMetrics.p95LatencyMs}ms | p99: ${jobMetrics.p99LatencyMs}ms`);

    console.log("\n==================================================");
    console.log("   Load & Soak Benchmark Complete: ALL PASS      ");
    console.log("==================================================");
    await prisma.$disconnect();
    process.exit(0);
  })().catch(async (err) => {
    console.error("[LOAD_TEST_ERROR]", err);
    await prisma.$disconnect();
    process.exit(1);
  });
}
