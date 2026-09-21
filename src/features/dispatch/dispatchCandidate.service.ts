import prisma from '../../config/prisma';
import { dispatchWaveConfig } from '../../config/dispatchWaveConfig';
import { locationFreshnessConfig } from '../../config/locationFreshnessConfig';
import { isLocationFresh, getFreshnessCutoffDate } from './locationFreshnessPolicy';
import { locationFreshnessTelemetry } from './locationFreshnessTelemetry';

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
export const DISPATCH_WAVE_CONFIG: DispatchWaveConfig[] = dispatchWaveConfig.radiusMetersByWave.map(
  (radiusMeters, index) => ({ waveNumber: index + 1, radiusMeters }),
);

/**
 * Maps a wave number to its authoritative dispatch radius in meters.
 * Defaults to 15,000m for wave 4 and beyond.
 */
export function getWaveRadiusMeters(waveNumber: number): number {
  const index = Math.max(1, Math.min(waveNumber, dispatchWaveConfig.maxWaves)) - 1;
  return dispatchWaveConfig.radiusMetersByWave[index];
}

/**
 * Operational location freshness window in seconds.
 * Defaults to 300 seconds (5 minutes). Configured via LOCATION_FRESHNESS_MAX_AGE_SECONDS.
 * Workers whose location has not been updated within this window are considered stale
 * and excluded from location-sensitive dispatch.
 */
export const DEFAULT_LOCATION_FRESHNESS_SECONDS = locationFreshnessConfig.maxAgeSeconds;

export function getLocationFreshnessSeconds(): number {
  return locationFreshnessConfig.maxAgeSeconds;
}

/** @deprecated Use DEFAULT_LOCATION_FRESHNESS_SECONDS or locationFreshnessConfig.maxAgeSeconds */
export const DEFAULT_LOCATION_FRESHNESS_HOURS = DEFAULT_LOCATION_FRESHNESS_SECONDS / 3600;

/** @deprecated Use getLocationFreshnessSeconds */
export function getLocationFreshnessHours(): number {
  return getLocationFreshnessSeconds() / 3600;
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

export interface CandidatePageResult<T = EligibleWorkerCandidate> {
  candidates: T[];
  hasMore: boolean;
  pageSize: number;
  nextCursor: string | null;
}

export interface CandidateCursorPayload {
  dist_m: number;
  worker_score: number | null;
  id: string;
}

/**
 * Encodes a worker candidate into a secure base64url keyset cursor.
 */
export function encodeCandidateCursor(candidate: EligibleWorkerCandidate): string {
  const payload: CandidateCursorPayload = {
    dist_m: candidate.dist_m,
    worker_score: candidate.worker_score !== null ? Number(candidate.worker_score) : null,
    id: candidate.id,
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

/**
 * Decodes and validates a base64url keyset cursor.
 * Returns null if the cursor is malformed, invalid, or tampered with.
 */
export function decodeCandidateCursor(cursor: string): CandidateCursorPayload | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.dist_m === 'number' &&
      Number.isFinite(parsed.dist_m) &&
      typeof parsed.id === 'string' &&
      parsed.id.length > 0 &&
      (parsed.worker_score === null || (typeof parsed.worker_score === 'number' && Number.isFinite(parsed.worker_score)))
    ) {
      return {
        dist_m: parsed.dist_m,
        worker_score: parsed.worker_score !== null ? Number(parsed.worker_score) : null,
        id: parsed.id,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export interface CandidateEligibilityParams {
  requirementId: string;
  latitude: number | null | undefined;
  longitude: number | null | undefined;
  radiusMeters: number;
  skillType?: string | null;
  limit?: number;
  offset?: number;
  cursor?: string | null;
  requireLocationFreshness?: boolean;
  maxLocationAgeSeconds?: number;
  /** @deprecated Use maxLocationAgeSeconds instead */
  maxLocationAgeHours?: number;
  excludeDispatched?: boolean;
}

/**
 * Authoritative Candidate Eligibility Page Query
 *
 * Enforces all database-level mandatory invariants:
 * 1. Coordinates: Non-null, finite, valid WGS 84 range [-90..90], [-180..180].
 * 2. Radius: Positive finite number in meters.
 * 3. Worker Status: is_online = true, deleted_at IS NULL.
 * 4. Verification: verification_status = 'verified' (excludes pending, rejected, suspended).
 * 5. Spatial Filter: ST_DWithin on PostGIS geography (SRID 4326) with radius in meters.
 * 6. Location Freshness: worker.last_location_at >= NOW() - maxLocationAgeSeconds (and <= NOW() + 60s).
 * 7. Skill Match: worker.skill_type or skill_category.name case-insensitive match.
 * 8. Dedup / In-flight: NOT EXISTS in job_dispatch for this requirement (database-level exclusion).
 * 9. Active Bookings: NOT EXISTS in booking with active status ('confirmed', 'in_progress').
 * 10. Candidate Ranking: Deterministic ORDER BY dist_m ASC, w.worker_score DESC NULLS LAST, w.id ASC.
 * 11. Pagination & Exhaustion: Uses lookahead (fetch pageSize + 1) to determine hasMore deterministically
 *     without confusing a short page with complete candidate exhaustion.
 */
export async function getEligibleCandidatePage(
  params: CandidateEligibilityParams,
): Promise<CandidatePageResult<EligibleWorkerCandidate>> {
  const {
    requirementId,
    latitude,
    longitude,
    radiusMeters,
    skillType = null,
    limit = 20,
    offset = 0,
    cursor = null,
    requireLocationFreshness = true,
    maxLocationAgeSeconds: rawSeconds,
    maxLocationAgeHours,
    excludeDispatched = true,
  } = params;

  // Resolve maxLocationAgeSeconds with fallback to hours or canonical config
  const maxLocationAgeSeconds =
    rawSeconds !== undefined && Number.isFinite(rawSeconds) && rawSeconds > 0
      ? rawSeconds
      : maxLocationAgeHours !== undefined && Number.isFinite(maxLocationAgeHours) && maxLocationAgeHours > 0
        ? Math.round(maxLocationAgeHours * 3600)
        : locationFreshnessConfig.maxAgeSeconds;

  const safeLimit = Math.max(1, Math.min(limit, 100));

  // Fail closed if coordinates or radius are invalid
  if (!validateDispatchCoordinates(latitude, longitude) || !Number.isFinite(radiusMeters) || radiusMeters <= 0) {
    return {
      candidates: [],
      hasMore: false,
      pageSize: safeLimit,
      nextCursor: null,
    };
  }

  const safeOffset = Math.max(0, offset);
  const lat = latitude as number;
  const lon = longitude as number;
  const decodedCursor = cursor ? decodeCandidateCursor(cursor) : null;
  const fetchLimit = safeLimit + 1; // Lookahead +1 to know if more candidates exist

  try {
    const cursorDist = decodedCursor?.dist_m ?? null;
    const cursorScore = decodedCursor?.worker_score ?? null;
    const cursorId = decodedCursor?.id ?? null;
    const hasCursor = decodedCursor !== null;

    const rows = await prisma.$queryRaw<EligibleWorkerCandidate[]>`
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
              OR (
                w.last_location_at IS NOT NULL
                AND w.last_location_at >= NOW() - (${maxLocationAgeSeconds} || ' seconds')::interval
                AND w.last_location_at <= NOW() + interval '60 seconds'
              )
            )
        AND (
              ${hasCursor}::boolean = false
              OR (
                ST_Distance(
                  w.location_geo,
                  ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography
                ) > ${cursorDist}::float
                OR (
                  ST_Distance(
                    w.location_geo,
                    ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography
                  ) = ${cursorDist}::float
                  AND (
                    COALESCE(w.worker_score, -1.0) < COALESCE(${cursorScore}::float, -1.0)
                    OR (
                      COALESCE(w.worker_score, -1.0) = COALESCE(${cursorScore}::float, -1.0)
                      AND w.id > ${cursorId}::uuid
                    )
                  )
                )
              )
            )
      ORDER BY dist_m ASC, w.worker_score DESC NULLS LAST, w.id ASC
      LIMIT ${fetchLimit}
      OFFSET ${hasCursor ? 0 : safeOffset};
    `;

    const hasMore = rows.length > safeLimit;
    const candidates = hasMore ? rows.slice(0, safeLimit) : rows;
    const nextCursor = hasMore && candidates.length > 0
      ? encodeCandidateCursor(candidates[candidates.length - 1])
      : null;

    return {
      candidates,
      hasMore,
      pageSize: safeLimit,
      nextCursor,
    };
  } catch (err) {
    console.error('[dispatchCandidateService] Error querying eligible candidate page:', {
      requirementId,
      radiusMeters,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      candidates: [],
      hasMore: false,
      pageSize: safeLimit,
      nextCursor: null,
    };
  }
}

/**
 * Returns eligible candidates matching the criteria, deterministically ordered.
 * Delegates to getEligibleCandidatePage for unified query and pagination correctness.
 */
export async function getEligibleDispatchCandidates(
  params: CandidateEligibilityParams,
): Promise<EligibleWorkerCandidate[]> {
  const pageResult = await getEligibleCandidatePage(params);
  return pageResult.candidates;
}
