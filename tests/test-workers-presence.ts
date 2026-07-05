import prisma from '../src/config/prisma';

async function main() {
  console.log('--- STARTING WORKER PRESENCE TEST ---');
  
  // 1. Get total worker count
  const totalWorkers = await prisma.worker.count();
  console.log(`Total workers in DB: ${totalWorkers}`);

  // 2. Get online workers count
  const onlineWorkersCount = await prisma.worker.count({
    where: { is_online: true },
  });
  console.log(`Online workers count: ${onlineWorkersCount}`);

  // 3. Get list of skills present in the worker table
  const skillsGrouped = await prisma.worker.groupBy({
    by: ['skill_type'],
    _count: {
      _all: true,
    },
  });
  console.log('Worker count by skill_type in database:', JSON.stringify(skillsGrouped, null, 2));

  // 4. Print details of some workers (up to 10)
  const sampleWorkers = await prisma.worker.findMany({
    take: 10,
    select: {
      id: true,
      name: true,
      phone: true,
      is_online: true,
      skill_type: true,
      verification_status: true,
      deleted_at: true,
    },
  });
  console.log('Sample Workers in DB:', JSON.stringify(sampleWorkers, null, 2));

  // 5. Check if any worker has location_geo defined (raw query since geography is Unsupported)
  const workersWithGeo: any[] = await prisma.$queryRaw`
    SELECT id, name, is_online, skill_type, 
           location_geo IS NOT NULL as has_geo,
           CASE WHEN location_geo IS NOT NULL THEN ST_AsText(location_geo) ELSE NULL END as wkt
    FROM worker
    LIMIT 10;
  `;
  console.log('Sample Workers with location_geo status:', JSON.stringify(workersWithGeo, null, 2));

  // 6. Check active bookings for these workers
  const activeBookings = await prisma.booking.findMany({
    where: {
      status: { in: ['confirmed', 'in_progress'] },
    },
    select: {
      id: true,
      worker_id: true,
      status: true,
    },
  });
  console.log(`Active bookings count: ${activeBookings.length}`);
  if (activeBookings.length > 0) {
    console.log('Active bookings:', JSON.stringify(activeBookings, null, 2));
  }

  // 7. Check last 5 job requirements
  const recentRequirements = await prisma.job_requirement.findMany({
    take: 5,
    orderBy: { created_at: 'desc' },
    select: {
      id: true,
      job_id: true,
      skill_type: true,
      status: true,
      worker_count_needed: true,
      worker_count_filled: true,
    },
  });
  console.log('Recent job requirements:', JSON.stringify(recentRequirements, null, 2));

  // 8. Check skill categories in the system
  const categories = await prisma.skill_category.findMany();
  console.log('Skill categories:', JSON.stringify(categories, null, 2));

  // 9. Test ILIKE queries
  console.log('\n--- TESTING ILIKE MATCHING ---');
  const directMatch = await prisma.$queryRaw`
    SELECT id, name, skill_type FROM worker
    WHERE skill_type ILIKE 'Mason';
  `;
  console.log('Workers matching "Mason" directly via skill_type:', JSON.stringify(directMatch, null, 2));

  const categoryMatch = await prisma.$queryRaw`
    SELECT w.id, w.name, w.skill_type, c.name as category_name
    FROM worker w
    JOIN skill_category c ON w.skill_category_id = c.id
    WHERE c.name ILIKE 'Mason';
  `;
  console.log('Workers matching "Mason" via skill_category name:', JSON.stringify(categoryMatch, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
