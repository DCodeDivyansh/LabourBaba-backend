import prisma from '../src/config/prisma';
import { getEligibleCandidatePage } from '../src/features/dispatch/dispatchCandidate.service';

describe('P4 Issue 23: PostGIS Extension Availability & Geodesic Spatial Verification', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('Test A: PostGIS extension is installed, active, and reports valid version', async () => {
    const ext = await prisma.$queryRaw<any[]>`
      SELECT extname, extversion FROM pg_extension WHERE extname = 'postgis';
    `;
    expect(ext.length).toBe(1);
    expect(ext[0].extname).toBe('postgis');
    expect(ext[0].extversion).toBeDefined();

    const versionResult: any = await prisma.$queryRawUnsafe('SELECT PostGIS_Version();');
    expect(versionResult[0].postgis_version).toMatch(/^3\./);
  });

  it('Test B: ST_DWithin strictly interprets radius in meters on geography(Point, 4326)', async () => {
    // Majestic, Bengaluru (Center)
    const centerLon = 77.5946;
    const centerLat = 12.9716;

    // MG Road, Bengaluru (~1,500 meters away)
    const nearLon = 77.6080;
    const nearLat = 12.9750;

    // Radius 5,000 meters (5 km) should include MG Road
    const within5km: any = await prisma.$queryRaw`
      SELECT ST_DWithin(
        ST_SetSRID(ST_MakePoint(${centerLon}, ${centerLat}), 4326)::geography,
        ST_SetSRID(ST_MakePoint(${nearLon}, ${nearLat}), 4326)::geography,
        5000
      ) AS is_within;
    `;
    expect(within5km[0].is_within).toBe(true);

    // Radius 500 meters should EXCLUDE MG Road (proving radius is NOT in kilometers or degrees)
    const within500m: any = await prisma.$queryRaw`
      SELECT ST_DWithin(
        ST_SetSRID(ST_MakePoint(${centerLon}, ${centerLat}), 4326)::geography,
        ST_SetSRID(ST_MakePoint(${nearLon}, ${nearLat}), 4326)::geography,
        500
      ) AS is_within;
    `;
    expect(within500m[0].is_within).toBe(false);
  });

  it('Test C: ST_Distance calculates accurate geodesic distance between known geographic points', async () => {
    const centerLon = 77.5946;
    const centerLat = 12.9716;

    const nearLon = 77.6080;
    const nearLat = 12.9750;

    const distResult: any = await prisma.$queryRaw`
      SELECT ST_Distance(
        ST_SetSRID(ST_MakePoint(${centerLon}, ${centerLat}), 4326)::geography,
        ST_SetSRID(ST_MakePoint(${nearLon}, ${nearLat}), 4326)::geography
      ) AS distance_meters;
    `;

    const dist = Number(distResult[0].distance_meters);
    expect(dist).toBeGreaterThan(1300);
    expect(dist).toBeLessThan(1700);
  });

  it('Test D: Spatial boundary conditions evaluate exact inclusion/exclusion limits (999m vs 1000m vs 1001m)', async () => {
    // Construct point exactly 1,000 meters East along the equator
    // At equator (lat 0), 1 degree lon ≈ 111,319.5 meters -> 1000m ≈ 0.00898315 degrees
    const originLon = 0.0;
    const originLat = 0.0;

    const targetLon = 0.0089831528;
    const targetLat = 0.0;

    const boundaryCheck: any = await prisma.$queryRaw`
      SELECT 
        ST_Distance(
          ST_SetSRID(ST_MakePoint(${originLon}, ${originLat}), 4326)::geography,
          ST_SetSRID(ST_MakePoint(${targetLon}, ${targetLat}), 4326)::geography
        ) AS exact_dist,
        ST_DWithin(
          ST_SetSRID(ST_MakePoint(${originLon}, ${originLat}), 4326)::geography,
          ST_SetSRID(ST_MakePoint(${targetLon}, ${targetLat}), 4326)::geography,
          1001
        ) AS inside_1001,
        ST_DWithin(
          ST_SetSRID(ST_MakePoint(${originLon}, ${originLat}), 4326)::geography,
          ST_SetSRID(ST_MakePoint(${targetLon}, ${targetLat}), 4326)::geography,
          999
        ) AS outside_999;
    `;

    const exactDist = Math.round(Number(boundaryCheck[0].exact_dist));
    expect(exactDist).toBe(1000);
    expect(boundaryCheck[0].inside_1001).toBe(true);
    expect(boundaryCheck[0].outside_999).toBe(false);
  });

  it('Test E: Extreme valid boundary coordinates (North/South Pole, Antimeridian) are valid PostGIS points', async () => {
    // North pole (90, 0), South pole (-90, 0), Antimeridian (0, 180), (0, -180)
    const extremePoints: any = await prisma.$queryRaw`
      SELECT 
        ST_Distance(
          ST_SetSRID(ST_MakePoint(0, 90), 4326)::geography,
          ST_SetSRID(ST_MakePoint(0, -90), 4326)::geography
        ) AS pole_to_pole_dist,
        ST_DWithin(
          ST_SetSRID(ST_MakePoint(180, 0), 4326)::geography,
          ST_SetSRID(ST_MakePoint(-180, 0), 4326)::geography,
          1.0
        ) AS antimeridian_match;
    `;

    const poleDist = Number(extremePoints[0].pole_to_pole_dist);
    // Pole to pole geodesic distance is approximately 20,000 km (20,000,000 meters)
    expect(poleDist).toBeGreaterThan(19900000);
    expect(poleDist).toBeLessThan(20100000);

    // +180 and -180 longitude represent the exact same geographical meridian on Earth
    expect(extremePoints[0].antimeridian_match).toBe(true);
  });

  it('Test F: Edge coordinates (Null Island) and invalid coordinates fail safely in dispatch service', async () => {
    // Null Island (0,0) is valid
    const nullIsland: any = await prisma.$queryRaw`
      SELECT ST_DWithin(
        ST_SetSRID(ST_MakePoint(0, 0), 4326)::geography,
        ST_SetSRID(ST_MakePoint(0, 0), 4326)::geography,
        10
      ) AS match;
    `;
    expect(nullIsland[0].match).toBe(true);

    // Invalid / Null coordinates in candidate service fail closed without crashing
    const invalidResult = await getEligibleCandidatePage({
      requirementId: '00000000-0000-0000-0000-000000000000',
      latitude: null,
      longitude: null,
      radiusMeters: 5000,
    });
    expect(invalidResult.candidates).toHaveLength(0);
    expect(invalidResult.hasMore).toBe(false);
  });
});
