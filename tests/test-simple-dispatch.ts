import prisma from '../src/config/prisma';

interface NearbyWorker {
  id: string;
  name: string | null;
  device_token: string | null;
  worker_score: number;
  dist_m: number;
}

async function findAvailableWorkers(
  job: { longitude: number; latitude: number },
  req: { skill_type: string },
  radiusMeters: number,
): Promise<NearbyWorker[]> {
  return prisma.$queryRaw<NearbyWorker[]>`
    SELECT w.id, w.name, w.device_token, w.worker_score::float,
           ST_Distance(
             w.location_geo,
             ST_MakePoint(${job.longitude}, ${job.latitude})::geography
           ) AS dist_m
    FROM worker w
    WHERE w.is_online   = true
      AND w.deleted_at  IS NULL
      AND (
        w.skill_type ILIKE ${req.skill_type ?? ''}
        OR w.skill_category_id IN (
          SELECT id FROM skill_category WHERE name ILIKE ${req.skill_type ?? ''}
        )
      )
      AND ST_DWithin(
            w.location_geo,
            ST_MakePoint(${job.longitude}, ${job.latitude})::geography,
            ${radiusMeters}
          )
      -- Problem 6: exclude workers who already have an active booking
      AND NOT EXISTS (
            SELECT 1 FROM booking b
            WHERE b.worker_id = w.id
              AND b.status IN ('confirmed', 'in_progress')
          )
    ORDER BY w.worker_score DESC
    LIMIT 20
  `;
}

async function main() {
  console.log('--- TESTING FIND AVAILABLE WORKERS ---');
  
  // Test for Plumbing workers near Bengaluru coordinates (77.5946, 12.9716)
  const job = { longitude: 77.5946, latitude: 12.9716 };
  const req = { skill_type: 'Plumbing' };

  console.log(`Searching for '${req.skill_type}' within 10km of (${job.longitude}, ${job.latitude})...`);
  let workers = await findAvailableWorkers(job, req, 10000);
  console.log(`Found ${workers.length} workers in 10km:`, JSON.stringify(workers, null, 2));

  console.log(`Searching for '${req.skill_type}' within 20km of (${job.longitude}, ${job.latitude})...`);
  workers = await findAvailableWorkers(job, req, 20000);
  console.log(`Found ${workers.length} workers in 20km:`, JSON.stringify(workers, null, 2));

  // Test for Mason/Masson workers
  const masonReq = { skill_type: 'Mason' };
  console.log(`Searching for '${masonReq.skill_type}' within 10km of (${job.longitude}, ${job.latitude})...`);
  workers = await findAvailableWorkers(job, masonReq, 10000);
  console.log(`Found ${workers.length} workers in 10km:`, JSON.stringify(workers, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
