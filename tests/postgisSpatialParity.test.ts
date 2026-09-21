import prisma from '../src/config/prisma';
import { getEligibleCandidatePage } from '../src/features/dispatch/dispatchCandidate.service';

describe('Issue #34: PostGIS Parity & Spatial Query Verification', () => {
  let skillCategoryId: string;
  let customerId: string;
  let jobId: string;
  let requirementId: string;
  let insideWorkerId: string;
  let outsideWorkerId: string;

  // Reference coordinates: Bengaluru City Center (Majestic)
  const centerLat = 12.9716;
  const centerLon = 77.5946;

  // Inside worker: ~1.5 km away (Indiranagar / MG Road)
  const insideLat = 12.9750;
  const insideLon = 77.6050;

  // Outside worker: ~25 km away (Whitefield / Electronic City)
  const outsideLat = 12.8399;
  const outsideLon = 77.6770;

  beforeAll(async () => {
    // 1. Create skill category
    const skill = await prisma.skill_category.create({
      data: {
        name: `Skill_Spatial_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      },
    });
    skillCategoryId = skill.id;

    // 2. Create customer
    const customer = await prisma.customer.create({
      data: {
        name: 'Spatial Test Customer',
        phone: `+9195${Math.floor(10000000 + Math.random() * 90000000)}`,
        password: 'hashedpassword123',
      },
    });
    customerId = customer.id;

    // 3. Create job at center coordinates
    const job = await prisma.job.create({
      data: {
        customer_id: customerId,
        latitude: centerLat,
        longitude: centerLon,
        status: 'OPEN',
        dispatch_status: 'IDLE',
      },
    });
    jobId = job.id;

    // Set spatial point on job
    await prisma.$executeRaw`
      UPDATE job
      SET location_geo = ST_SetSRID(ST_MakePoint(${centerLon}, ${centerLat}), 4326)::geography
      WHERE id = ${jobId}::uuid
    `;

    // 4. Create requirement
    const req = await prisma.job_requirement.create({
      data: {
        job_id: jobId,
        skill_id: skillCategoryId,
        worker_count_needed: 1,
        worker_count_filled: 0,
        status: 'OPEN',
      },
    });
    requirementId = req.id;

    // 5. Create worker inside radius (~1.5 km)
    const workerInside = await prisma.worker.create({
      data: {
        name: 'Inside Radius Worker',
        phone: `+9194${Math.floor(10000000 + Math.random() * 90000000)}`,
        password: 'hashedpassword123',
        skill_category_id: skillCategoryId,
        skill_type: skill.name,
        verification_status: 'verified',
        is_online: true,
        worker_score: 4.8,
        last_location_at: new Date(),
      },
    });
    insideWorkerId = workerInside.id;

    await prisma.$executeRaw`
      UPDATE worker
      SET location_geo = ST_SetSRID(ST_MakePoint(${insideLon}, ${insideLat}), 4326)::geography,
          last_location_at = NOW()
      WHERE id = ${insideWorkerId}::uuid
    `;

    // 6. Create worker outside radius (~25 km)
    const workerOutside = await prisma.worker.create({
      data: {
        name: 'Outside Radius Worker',
        phone: `+9193${Math.floor(10000000 + Math.random() * 90000000)}`,
        password: 'hashedpassword123',
        skill_category_id: skillCategoryId,
        skill_type: skill.name,
        verification_status: 'verified',
        is_online: true,
        worker_score: 4.9,
        last_location_at: new Date(),
      },
    });
    outsideWorkerId = workerOutside.id;

    await prisma.$executeRaw`
      UPDATE worker
      SET location_geo = ST_SetSRID(ST_MakePoint(${outsideLon}, ${outsideLat}), 4326)::geography,
          last_location_at = NOW()
      WHERE id = ${outsideWorkerId}::uuid
    `;
  });

  afterAll(async () => {
    try {
      if (requirementId) {
        await prisma.job_dispatch.deleteMany({ where: { requirement_id: requirementId } });
        await prisma.job_requirement.deleteMany({ where: { id: requirementId } });
      }
      if (jobId) {
        await prisma.job.deleteMany({ where: { id: jobId } });
      }
      if (insideWorkerId) {
        await prisma.worker.deleteMany({ where: { id: insideWorkerId } });
      }
      if (outsideWorkerId) {
        await prisma.worker.deleteMany({ where: { id: outsideWorkerId } });
      }
      if (customerId) {
        await prisma.customer.deleteMany({ where: { id: customerId } });
      }
      if (skillCategoryId) {
        await prisma.skill_category.deleteMany({ where: { id: skillCategoryId } });
      }
    } catch (e) {
      // Ignore cleanup error
    } finally {
      await prisma.$disconnect();
    }
  });

  test('PostGIS extension is installed and active in PostgreSQL', async () => {
    const ext = await prisma.$queryRaw<any[]>`
      SELECT extname, extversion FROM pg_extension WHERE extname = 'postgis'
    `;
    expect(ext.length).toBe(1);
    expect(ext[0].extname).toBe('postgis');
    expect(ext[0].extversion).toBeDefined();
  });

  test('ST_Distance calculates accurate geodesic distance between coordinates', async () => {
    const res = await prisma.$queryRaw<any[]>`
      SELECT ST_Distance(
        ST_SetSRID(ST_MakePoint(${centerLon}, ${centerLat}), 4326)::geography,
        ST_SetSRID(ST_MakePoint(${insideLon}, ${insideLat}), 4326)::geography
      ) AS dist_inside,
      ST_Distance(
        ST_SetSRID(ST_MakePoint(${centerLon}, ${centerLat}), 4326)::geography,
        ST_SetSRID(ST_MakePoint(${outsideLon}, ${outsideLat}), 4326)::geography
      ) AS dist_outside
    `;

    expect(res.length).toBe(1);
    const distInside = Number(res[0].dist_inside);
    const distOutside = Number(res[0].dist_outside);

    // Inside worker is ~1.1 - 1.6 km (1100 - 1600 m)
    expect(distInside).toBeGreaterThan(1000);
    expect(distInside).toBeLessThan(2000);

    // Outside worker is ~18 - 25 km (18000 - 25000 m)
    expect(distOutside).toBeGreaterThan(15000);
  });

  test('ST_DWithin correctly evaluates inclusion inside 5km radius and exclusion outside 5km', async () => {
    const radiusMeters = 5000;

    const res = await prisma.$queryRaw<any[]>`
      SELECT 
        ST_DWithin(
          ST_SetSRID(ST_MakePoint(${centerLon}, ${centerLat}), 4326)::geography,
          ST_SetSRID(ST_MakePoint(${insideLon}, ${insideLat}), 4326)::geography,
          ${radiusMeters}
        ) AS inside_match,
        ST_DWithin(
          ST_SetSRID(ST_MakePoint(${centerLon}, ${centerLat}), 4326)::geography,
          ST_SetSRID(ST_MakePoint(${outsideLon}, ${outsideLat}), 4326)::geography,
          ${radiusMeters}
        ) AS outside_match
    `;

    expect(res.length).toBe(1);
    expect(res[0].inside_match).toBe(true);
    expect(res[0].outside_match).toBe(false);
  });

  test('dispatch candidate query selects worker inside radius and excludes worker outside radius', async () => {
    const pageResult = await getEligibleCandidatePage({
      requirementId,
      latitude: centerLat,
      longitude: centerLon,
      radiusMeters: 5000,
      limit: 10,
      skillId: skillCategoryId,
      excludeDispatched: true,
      requireLocationFreshness: false,
    });

    const candidateIds = pageResult.candidates.map((c: any) => c.id);
    expect(candidateIds).toContain(insideWorkerId);
    expect(candidateIds).not.toContain(outsideWorkerId);
  });
});
