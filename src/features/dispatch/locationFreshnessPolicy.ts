import { locationFreshnessConfig } from '../../config/locationFreshnessConfig';

export type LocationFreshnessReason =
  | 'FRESH'
  | 'STALE'
  | 'MISSING'
  | 'INVALID'
  | 'FUTURE_SKEW_EXCEEDED';

export interface LocationFreshnessResult {
  isFresh: boolean;
  reason: LocationFreshnessReason;
  ageSeconds?: number;
  cutoffDate: Date;
  timestamp?: Date;
}

/**
 * Calculates the operational freshness cutoff date given a reference point and maximum age.
 * Any timestamp at or after (>=) this cutoff date (and within clock skew) is considered fresh.
 */
export function getFreshnessCutoffDate(
  now: Date = new Date(),
  maxAgeSeconds: number = locationFreshnessConfig.maxAgeSeconds,
): Date {
  return new Date(now.getTime() - maxAgeSeconds * 1000);
}

/**
 * Evaluates whether a worker's authoritative location timestamp satisfies the
 * product-defined operational freshness threshold.
 *
 * Rules:
 * 1. Missing: null or undefined -> isFresh: false, reason: 'MISSING'
 * 2. Invalid: not a valid finite timestamp -> isFresh: false, reason: 'INVALID'
 * 3. Future Clock Skew Exceeded: timestamp > now + maxClockSkewMs -> isFresh: false, reason: 'FUTURE_SKEW_EXCEEDED'
 * 4. Stale: timestamp < now - maxAgeSeconds -> isFresh: false, reason: 'STALE'
 * 5. Fresh: cutoffDate <= timestamp <= now + maxClockSkewMs -> isFresh: true, reason: 'FRESH'
 */
export function isLocationFresh(
  lastLocationAt: Date | string | number | null | undefined,
  now: Date = new Date(),
  maxAgeSeconds: number = locationFreshnessConfig.maxAgeSeconds,
  maxClockSkewMs: number = locationFreshnessConfig.maxClockSkewMs,
): LocationFreshnessResult {
  const cutoffDate = getFreshnessCutoffDate(now, maxAgeSeconds);

  if (lastLocationAt === null || lastLocationAt === undefined) {
    return {
      isFresh: false,
      reason: 'MISSING',
      cutoffDate,
    };
  }

  let dateObj: Date;
  if (lastLocationAt instanceof Date) {
    dateObj = lastLocationAt;
  } else if (typeof lastLocationAt === 'string' || typeof lastLocationAt === 'number') {
    dateObj = new Date(lastLocationAt);
  } else {
    return {
      isFresh: false,
      reason: 'INVALID',
      cutoffDate,
    };
  }

  const ts = dateObj.getTime();
  if (Number.isNaN(ts) || !Number.isFinite(ts)) {
    return {
      isFresh: false,
      reason: 'INVALID',
      cutoffDate,
    };
  }

  const nowMs = now.getTime();
  const ageMs = nowMs - ts;
  const ageSeconds = ageMs / 1000;

  // Check future timestamp exceeding clock skew threshold
  if (ts > nowMs + maxClockSkewMs) {
    return {
      isFresh: false,
      reason: 'FUTURE_SKEW_EXCEEDED',
      ageSeconds,
      cutoffDate,
      timestamp: dateObj,
    };
  }

  // Exact boundary: timestamp >= cutoffDate (ageMs <= maxAgeSeconds * 1000)
  if (ts >= cutoffDate.getTime()) {
    return {
      isFresh: true,
      reason: 'FRESH',
      ageSeconds: Math.max(0, ageSeconds),
      cutoffDate,
      timestamp: dateObj,
    };
  }

  return {
    isFresh: false,
    reason: 'STALE',
    ageSeconds,
    cutoffDate,
    timestamp: dateObj,
  };
}

/**
 * Helper to check freshness for a worker object directly.
 */
export function isWorkerLocationFresh(
  worker: { last_location_at?: Date | string | number | null },
  now: Date = new Date(),
  maxAgeSeconds: number = locationFreshnessConfig.maxAgeSeconds,
): LocationFreshnessResult {
  return isLocationFresh(worker.last_location_at, now, maxAgeSeconds);
}
