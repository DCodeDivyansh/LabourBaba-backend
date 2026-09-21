import { validateCoordinatePair } from './coordinateValidator';

/**
 * Convert longitude and latitude to PostGIS geography format.
 * PostGIS POINT order is POINT(longitude latitude).
 *
 * @param longitude - The longitude value [-180, 180]
 * @param latitude - The latitude value [-90, 90]
 * @returns PostGIS POINT format string
 */
export const convertToGeography = (
  longitude: number,
  latitude: number,
): string => {
  const result = validateCoordinatePair(latitude, longitude);
  if (!result.isValid) {
    throw new Error(result.error || 'Invalid geographic coordinates');
  }
  return `POINT(${result.longitude} ${result.latitude})`;
};

/**
 * Convert PostGIS geography to GeoJSON format.
 * GeoJSON coordinate order is [longitude, latitude].
 *
 * @param longitude - The longitude value [-180, 180]
 * @param latitude - The latitude value [-90, 90]
 * @returns GeoJSON Point object
 */
export const convertToGeoJSON = (longitude: number, latitude: number) => {
  const result = validateCoordinatePair(latitude, longitude);
  if (!result.isValid) {
    throw new Error(result.error || 'Invalid geographic coordinates');
  }
  return {
    type: 'Point' as const,
    coordinates: [result.longitude!, result.latitude!],
  };
};

/**
 * Parse geography string to coordinates.
 * Expects "POINT(longitude latitude)" format.
 *
 * @param geography - PostGIS geography string (e.g., "POINT(72.8777 19.0760)")
 * @returns Object with longitude and latitude
 */
export const parseGeography = (
  geography: string,
): { longitude: number; latitude: number } => {
  if (typeof geography !== 'string') {
    throw new Error('Invalid geography format: string expected');
  }
  const match = geography.match(/POINT\(([^ ]+)\s+([^ ]+)\)/i);
  if (!match) {
    throw new Error('Invalid geography format: expected POINT(lon lat)');
  }
  const lon = parseFloat(match[1]);
  const lat = parseFloat(match[2]);

  const result = validateCoordinatePair(lat, lon);
  if (!result.isValid) {
    throw new Error(`Invalid geography coordinates in point: ${result.error}`);
  }

  return {
    longitude: result.longitude!,
    latitude: result.latitude!,
  };
};
