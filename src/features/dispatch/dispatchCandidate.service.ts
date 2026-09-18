import prisma from '../../config/prisma';

export interface DispatchWaveConfig {
  waveNumber: number;
  radiusMeters: number;
}

/**
 * Authoritative wave configuration for progressive geographic dispatch.
 * Wave 1: 3,000 meters (3 km)
 * Wave 2: 5,000 meters (5 km)
 * Wave 3: 10,000 meters (10 km)
 * Wave 4+: 15,000 meters (15 km)
 */
export const DISPATCH_WAVE_CONFIG: DispatchWaveConfig[] = [
  { waveNumber: 1, radiusMeters: 3_000 },
  { waveNumber: 2, radiusMeters: 5_000 },
  { waveNumber: 3, radiusMeters: 10_000 },
  { waveNumber: 4, radiusMeters: 15_000 },
];

/**
 * Maps a wave number to its authoritative dispatch radius in meters.
 * Defaults to 15,000m for wave 4 and beyond.
 */
export function getWaveRadiusMeters(waveNumber: number): number {
  if (waveNumber <= 1) return 3_000;
  if (waveNumber === 2) return 5_000;
  if (waveNumber === 3) return 10_000;
  return 15_000;
}

/**
 * Location freshness window in hours.
 * Defaults to 24 hours. Can be overridden via DISPATCH_LOCATION_FRESHNESS_HOURS.
 * Workers whose location has not been updated within this window are considered stale
 * and excluded from location-sensitive dispatch.
 */
export const DEFAULT_LOCATION_FRESHNESS_HOURS = 24;

export function getLocationFreshnessHours(): number {
  const envVal = process.env.DISPATCH_LOCATION_FRESHNESS_HOURS || process.env.LOCATION_FRESHNESS_HOURS;
  if (envVal) {
    const parsed = parseFloat(envVal);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_LOCATION_FRESHNESS_HOURS;
}

/**
 * Strict coordinate validator.
 * Validates that latitude is in [-90, 90] and longitude is in [-180, 180].
 * (0, 0) is strictly valid (Null Island) and must not be rejected by falsy checks.
 */
export function validateDispatchCoordinates(latitude: unknown, longitude: unknown): boolean {
  if (
    latitude === null ||
    latitude === undefined ||
    longitude === null ||
    longitude === undefined ||
    typeof latitude !== 'number' ||
    typeof longitude !== 'number' ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return false;
  }
  return true;
}

export interface EligibleWorkerCandidate {
  id: string;
  name: string | null;
  device_token: string | null;
  worker_score: number | null;
  dist_m: number;
}

export interface CandidateEligibilityParams {
  requirementId: string;
  latitude: number | null | undefined;
  longitude: number | null | undefined;
  radiusMeters: number;
  skillType?: string | null;
  limit?: number;
  offset?: number;
  requireLocationFreshness?: boolean;
  maxLocationAgeHours?: number;
  excludeDispatched?: boolean;
}

/**
 * Authoritative Candidate Eligibility Query
 *
 * Enforces all database-level mandatory invariants:
 * 1. Coordinates: Non-null, finite, valid WGS 84 range [-90..90], [-180..180].
 * 2. Radius: Positive finite number in meters.
 * 3. Worker Status: is_online = true, deleted_at IS NULL.
 * 4. Verification: verification_status = 'verified' (excludes pending, rejected, suspended).
 * 5. Spatial Filter: ST_DWithin on PostGIS geography (SRID 4326) with radius in meters.
 * 6. Location Freshness: worker_location updated within maxLocationAgeHours window.
 * 7. Skill Match: worker.skill_type or skill_category.name case-insensitive match.
 * 8. Dedup / In-flight: NOT EXISTS in job_dispatch for this requirement.
 * 9. Active Bookings: NOT EXISTS in booking with active status ('confirmed', 'in_progress').
 * 10. Candidate Ranking: ORDER BY dist_m ASC, w.worker_score DESC NULLS LAST.
 */
export async function getEligibleDispatchCandidates(
  params: CandidateEligibilityParams,
): Promise<EligibleWorkerCandidate[]> {
  const {
    requirementId,
    latitude,
    longitude,
    radiusMeters,
    skillType = null,
    limit = 20,
    offset = 0,
    requireLocationFreshness = true,
    maxLocationAgeHours = getLocationFreshnessHours(),
    excludeDispatched = true,
  } = params;

  // Fail closed if coordinates or radius are invalid
  if (!validateDispatchCoordinates(latitude, longitude)) {
    return [];
  }
  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) {
    return [];
  }

  const safeLimit = Math.max(1, Math.min(limit, 100));
  const safeOffset = Math.max(0, offset);
  const lat = latitude as number;
  const lon = longitude as number;

  try {
    const workers = await prisma.$queryRaw<EligibleWorkerCandidate[]>`
      SELECT w.id,
             w.name,
             w.device_token,
             w.worker_score::float,
             ST_Distance(
               w.location_geo,
               ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography
             ) AS dist_m
      FROM worker w
      WHERE w.is_online = true
        AND w.deleted_at IS NULL
        AND w.verification_status = 'verified'
        AND w.location_geo IS NOT NULL
        AND ST_DWithin(
              w.location_geo,
              ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography,
              ${radiusMeters}
            )
        AND (
              ${skillType ?? null}::text IS NULL
              OR LOWER(TRIM(w.skill_type)) = LOWER(TRIM(${skillType ?? ''}))
              OR EXISTS (
                   SELECT 1 FROM skill_category sc
                   WHERE sc.id = w.skill_category_id
                     AND LOWER(TRIM(sc.name)) = LOWER(TRIM(${skillType ?? ''}))
                 )
            )
        AND (
              ${excludeDispatched}::boolean = false
              OR NOT EXISTS (
                   SELECT 1 FROM job_dispatch jd
                   WHERE jd.requirement_id = ${requirementId}::uuid
                     AND jd.worker_id = w.id
                 )
            )
        AND NOT EXISTS (
              SELECT 1 FROM booking b
              WHERE b.worker_id = w.id
                AND LOWER(b.status) IN ('confirmed', 'in_progress')
            )
        AND (
              ${requireLocationFreshness}::boolean = false
              OR EXISTS (
                   SELECT 1 FROM worker_location wl
                   WHERE wl.worker_id = w.id
                     AND wl.updated_at >= NOW() - (${maxLocationAgeHours} || ' hours')::interval
                 )
            )
      ORDER BY dist_m ASC, w.worker_score DESC NULLS LAST
      LIMIT ${safeLimit}
      OFFSET ${safeOffset};
    `;

    return workers;
  } catch (err) {
    // Fail closed: Never return unverified/un-geocoded candidates on query failure
    console.error('[dispatchCandidateService] Error querying eligible dispatch candidates:', {
      requirementId,
      radiusMeters,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
