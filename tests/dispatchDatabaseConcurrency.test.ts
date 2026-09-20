import prisma from '../src/config/prisma';

describe('Issue #21: Real PostgreSQL Dispatch Database Concurrency & Constraints', () => {
  let testCustomerId: string;
  let testJobId: string;
  let testRequirementId: string;
  let testWorkerId: string;

  beforeAll(async () => {
    // Create minimal test fixtures in live PostgreSQL
    const customer = await prisma.customer.create({
      data: {
        phone: '+919999900021',
        name: 'Dispatch Invariant Customer',
        password: 'hashedpassword',
      },
    });
    testCustomerId = customer.id;

    const job = await prisma.job.create({
      data: {
        customer_id: testCustomerId,
        status: 'OPEN',
        location: 'Delhi NCR',
        latitude: 28.6139,
        longitude: 77.209,
      },
    });
    testJobId = job.id;

    const req = await prisma.job_requirement.create({
      data: {
        job_id: testJobId,
        skill_type: 'Electrician',
        worker_count_needed: 1,
        status: 'DISPATCHING',
      },
    });
    testRequirementId = req.id;

    // Find or create a skill category
    let skillCategory = await prisma.skill_category.findFirst();
    if (!skillCategory) {
      skillCategory = await prisma.skill_category.create({
        data: { name: 'Dispatch Test Category' },
      });
    }

    const worker = await prisma.worker.create({
      data: {
        phone: '+918888800021',
        name: 'Dispatch Invariant Worker',
        password: 'hashedpassword',
        skill_type: 'Electrician',
        skill_category_id: skillCategory.id,
        is_online: true,
      },
    });
    testWorkerId = worker.id;
  });

  afterAll(async () => {
    // Teardown test fixtures
    try {
      if (testRequirementId) {
        await prisma.job_dispatch.deleteMany({ where: { requirement_id: testRequirementId } });
        await prisma.dispatch_wave.deleteMany({ where: { requirement_id: testRequirementId } });
        await prisma.job_requirement.deleteMany({ where: { id: testRequirementId } });
      }
      if (testJobId) {
        await prisma.job.deleteMany({ where: { id: testJobId } });
      }
      if (testCustomerId) {
        await prisma.customer.deleteMany({ where: { id: testCustomerId } });
      }
      if (testWorkerId) {
        await prisma.worker.deleteMany({ where: { id: testWorkerId } });
      }
    } catch (err) {
      console.warn('Cleanup error in dispatchDatabaseConcurrency:', err);
    } finally {
      await prisma.$disconnect();
    }
  });

  it('MUST enforce UNIQUE(requirement_id, wave_number) on dispatch_wave under concurrent INSERTs', async () => {
    const waveNumber = 1;

    // Attempt 10 simultaneous wave insertions for the same requirement and wave number
    const attempts = Array.from({ length: 10 }, (_, i) =>
      prisma.dispatch_wave
        .create({
          data: {
            requirement_id: testRequirementId,
            wave_number: waveNumber,
            workers_notified: 2,
            status: 'active',
          },
        })
        .then(() => ({ success: true, index: i }))
        .catch((err) => ({
          success: false,
          index: i,
          code: err.code,
          isConstraintViolation:
            err.code === 'P2002' ||
            String(err.message).includes('uniq_dispatch_wave_req_wave') ||
            String(err.message).includes('23505'),
        }))
    );

    const results = await Promise.all(attempts);

    const successes = results.filter((r) => r.success);
    const failures = results.filter(
      (r): r is { success: false; index: number; code: any; isConstraintViolation: boolean } => !r.success
    );

    // Exactly one concurrent insert must succeed
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(9);

    // All 9 failures must be due to the unique constraint backstop
    failures.forEach((f) => {
      expect(f.isConstraintViolation).toBe(true);
    });

    // Database must hold exactly 1 record for this wave
    const count = await prisma.dispatch_wave.count({
      where: { requirement_id: testRequirementId, wave_number: waveNumber },
    });
    expect(count).toBe(1);
  });

  it('MUST enforce UNIQUE(requirement_id, worker_id) on job_dispatch under concurrent INSERTs', async () => {
    // Attempt 10 simultaneous job_dispatch insertions for the same worker and requirement
    const attempts = Array.from({ length: 10 }, (_, i) =>
      prisma.job_dispatch
        .create({
          data: {
            requirement_id: testRequirementId,
            worker_id: testWorkerId,
            wave_number: 1,
            wave_position: i + 1,
            status: 'pending',
          },
        })
        .then(() => ({ success: true, index: i }))
        .catch((err) => ({
          success: false,
          index: i,
          code: err.code,
          isConstraintViolation:
            err.code === 'P2002' ||
            String(err.message).includes('uniq_job_dispatch_req_worker') ||
            String(err.message).includes('23505'),
        }))
    );

    const results = await Promise.all(attempts);

    const successes = results.filter((r) => r.success);
    const failures = results.filter(
      (r): r is { success: false; index: number; code: any; isConstraintViolation: boolean } => !r.success
    );

    // Exactly one concurrent insert must succeed
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(9);

    failures.forEach((f) => {
      expect(f.isConstraintViolation).toBe(true);
    });

    const count = await prisma.job_dispatch.count({
      where: { requirement_id: testRequirementId, worker_id: testWorkerId },
    });
    expect(count).toBe(1);
  });
});
