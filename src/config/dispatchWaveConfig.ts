/** Canonical dispatch-wave business configuration. Units are explicit. */
export interface DispatchWaveConfiguration {
  /** Dimensionless candidate oversubscription factor; must be >= 1. */
  workerMultiplier: number;
  /** Search radii in metres, indexed by 1-based wave number; final value is the cap. */
  radiusMetersByWave: readonly number[];
  /** Worker acceptance deadline for each persisted wave, in milliseconds. */
  timeoutMs: number;
  /** Inclusive maximum number of dispatch waves; must be >= 1. */
  maxWaves: number;
}

function positiveInteger(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function radiusList(value: string | undefined): readonly number[] {
  if (value === undefined || value.trim() === '') return [3_000, 5_000, 10_000, 15_000];
  const radii = value.split(',').map((item) => Number(item.trim()));
  if (radii.length === 0 || radii.some((radius) => !Number.isSafeInteger(radius) || radius <= 0)) {
    throw new Error('DISPATCH_WAVE_RADII_METERS must be comma-separated positive integer metres');
  }
  return radii;
}

export function getDispatchWaveConfiguration(env: NodeJS.ProcessEnv = process.env): DispatchWaveConfiguration {
  const radiusMetersByWave = radiusList(env.DISPATCH_WAVE_RADII_METERS);
  const maxWaves = positiveInteger('DISPATCH_MAX_WAVES', env.DISPATCH_MAX_WAVES, radiusMetersByWave.length);
  if (maxWaves > radiusMetersByWave.length) {
    throw new Error('DISPATCH_MAX_WAVES cannot exceed configured DISPATCH_WAVE_RADII_METERS entries');
  }
  return Object.freeze({
    workerMultiplier: positiveInteger('DISPATCH_WAVE_WORKER_MULTIPLIER', env.DISPATCH_WAVE_WORKER_MULTIPLIER, 2),
    radiusMetersByWave: Object.freeze(radiusMetersByWave.slice(0, maxWaves)),
    timeoutMs: positiveInteger('DISPATCH_WAVE_TIMEOUT_MS', env.DISPATCH_WAVE_TIMEOUT_MS, 30_000),
    maxWaves,
  });
}

export const dispatchWaveConfig = getDispatchWaveConfiguration();
