/**
 * Authoritative Coordinate Validator for Geographic Invariants
 *
 * Domain Rules:
 * 1. Latitude: -90 <= latitude <= 90 (finite number)
 * 2. Longitude: -180 <= longitude <= 180 (finite number)
 * 3. Non-finite values (NaN, Infinity, -Infinity) are strictly rejected.
 * 4. Zero coordinates (0, 0), (0, lon), (lat, 0) including -0 are completely valid (Null Island).
 * 5. Pair Semantics: Latitude and Longitude MUST be supplied together as a pair.
 */

export interface CoordinateValidationResult {
  isValid: boolean;
  error?: string;
  latitude?: number;
  longitude?: number;
}

/**
 * Validates a single latitude value.
 */
export function isValidLatitude(lat: unknown): lat is number {
  return (
    typeof lat === 'number' &&
    Number.isFinite(lat) &&
    lat >= -90 &&
    lat <= 90
  );
}

/**
 * Validates a single longitude value.
 */
export function isValidLongitude(lon: unknown): lon is number {
  return (
    typeof lon === 'number' &&
    Number.isFinite(lon) &&
    lon >= -180 &&
    lon <= 180
  );
}

/**
 * Validates that latitude and longitude form a valid, finite, in-bounds coordinate pair.
 * Both latitude and longitude are strictly required.
 */
export function validateCoordinatePair(
  latitude: unknown,
  longitude: unknown,
): CoordinateValidationResult {
  // Explicit presence checks (never use truthiness because 0 is a valid coordinate)
  const isLatPresent = latitude !== null && latitude !== undefined;
  const isLonPresent = longitude !== null && longitude !== undefined;

  if (!isLatPresent && !isLonPresent) {
    return {
      isValid: false,
      error: 'Coordinates are required: both latitude and longitude must be provided',
    };
  }

  if (!isLatPresent || !isLonPresent) {
    return {
      isValid: false,
      error: 'Partial coordinate pair rejected: both latitude and longitude must be provided together',
    };
  }

  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    return {
      isValid: false,
      error: 'Coordinates must be numeric values',
    };
  }

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return {
      isValid: false,
      error: 'Coordinates must be finite numbers (NaN and Infinities are rejected)',
    };
  }

  if (latitude < -90 || latitude > 90) {
    return {
      isValid: false,
      error: `Latitude must be between -90 and 90 degrees (received: ${latitude})`,
    };
  }

  if (longitude < -180 || longitude > 180) {
    return {
      isValid: false,
      error: `Longitude must be between -180 and 180 degrees (received: ${longitude})`,
    };
  }

  // Normalize -0 to 0
  const normalizedLat = Object.is(latitude, -0) ? 0 : latitude;
  const normalizedLon = Object.is(longitude, -0) ? 0 : longitude;

  return {
    isValid: true,
    latitude: normalizedLat,
    longitude: normalizedLon,
  };
}

/**
 * Validates an optional coordinate pair.
 * Valid states:
 * - Both latitude and longitude are valid numbers.
 * - Both latitude and longitude are omitted/undefined (or both null).
 * Invalid state:
 * - One coordinate present and the other missing/null.
 * - Non-finite or out-of-bounds coordinates.
 */
export function validateOptionalCoordinatePair(
  latitude: unknown,
  longitude: unknown,
): CoordinateValidationResult {
  const isLatPresent = latitude !== null && latitude !== undefined;
  const isLonPresent = longitude !== null && longitude !== undefined;

  // Both omitted/null -> valid absent location
  if (!isLatPresent && !isLonPresent) {
    return {
      isValid: true,
      latitude: undefined,
      longitude: undefined,
    };
  }

  // If one is present, both must be present and valid
  return validateCoordinatePair(latitude, longitude);
}
