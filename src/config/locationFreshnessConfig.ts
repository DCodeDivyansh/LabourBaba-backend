/**
 * Authoritative Operational Location Freshness Configuration
 *
 * Enforces a short operational window (measured in seconds) for real-time dispatch eligibility.
 * Stale worker locations cannot enter candidate pools.
 */

export interface LocationFreshnessConfiguration {
  /** Maximum acceptable age of worker's current location in seconds. */
  maxAgeSeconds: number;
  /** Maximum allowed future timestamp clock skew in milliseconds (e.g. 60,000ms = 60s). */
  maxClockSkewMs: number;
}

export const DEFAULT_FRESHNESS_SECONDS = 300; // 5 minutes (standard operational dispatch window)
export const DEFAULT_CLOCK_SKEW_MS = 60_000; // 60 seconds

function parsePositiveInteger(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${name} must be a positive integer in seconds (received: "${value}")`);
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer > 0 (received: "${value}")`);
  }
  if (parsed < 10) {
    throw new Error(`${name} cannot be less than 10 seconds (received: ${parsed})`);
  }
  if (parsed > 86_400) {
    throw new Error(`${name} cannot exceed 86400 seconds (24 hours) for operational freshness (received: ${parsed})`);
  }
  return parsed;
}

export function getLocationFreshnessConfiguration(env: NodeJS.ProcessEnv = process.env): LocationFreshnessConfiguration {
  // Check LOCATION_FRESHNESS_MAX_AGE_SECONDS, then fallback alias DISPATCH_LOCATION_FRESHNESS_SECONDS
  const rawSeconds = env.LOCATION_FRESHNESS_MAX_AGE_SECONDS || env.DISPATCH_LOCATION_FRESHNESS_SECONDS;

  // Support legacy DISPATCH_LOCATION_FRESHNESS_HOURS if explicitly set and seconds not set
  let fallbackSeconds = DEFAULT_FRESHNESS_SECONDS;
  if (!rawSeconds && env.DISPATCH_LOCATION_FRESHNESS_HOURS) {
    const hours = parseFloat(env.DISPATCH_LOCATION_FRESHNESS_HOURS);
    if (Number.isFinite(hours) && hours > 0) {
      fallbackSeconds = Math.round(hours * 3600);
    }
  }

  const maxAgeSeconds = parsePositiveInteger(
    'LOCATION_FRESHNESS_MAX_AGE_SECONDS',
    rawSeconds,
    fallbackSeconds,
  );

  return Object.freeze({
    maxAgeSeconds,
    maxClockSkewMs: DEFAULT_CLOCK_SKEW_MS,
  });
}

export const locationFreshnessConfig = getLocationFreshnessConfiguration();
