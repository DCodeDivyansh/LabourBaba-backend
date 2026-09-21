import { DispatchWaveConfiguration, dispatchWaveConfig } from '../../config/dispatchWaveConfig';

export interface DispatchWavePlanInput {
  workerCountNeeded: number;
  workersAlreadyAssigned: number;
  waveNumber: number;
  /** Candidate query result for this radius, if known. Undefined means pagination owns exhaustion. */
  availableCandidates?: number;
  candidatesExhausted?: boolean;
  configuration?: DispatchWaveConfiguration;
}

export interface DispatchWavePlan {
  waveNumber: number;
  remainingCapacity: number;
  targetCandidateCount: number;
  radiusMeters: number;
  timeoutMs: number;
  isFinalAllowedWave: boolean;
  canDispatch: boolean;
  shouldTryNextWave: boolean;
}

function nonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
}

/**
 * Pure canonical wave planner. Candidate eligibility/pagination is deliberately
 * outside this function; identical inputs and configuration always yield the
 * exact same plan.
 */
export function planDispatchWave(input: DispatchWavePlanInput): DispatchWavePlan {
  const configuration = input.configuration ?? dispatchWaveConfig;
  nonNegativeInteger('workerCountNeeded', input.workerCountNeeded);
  nonNegativeInteger('workersAlreadyAssigned', input.workersAlreadyAssigned);
  nonNegativeInteger('waveNumber', input.waveNumber);
  if (input.waveNumber === 0) throw new Error('waveNumber must start at 1');
  if (input.availableCandidates !== undefined) nonNegativeInteger('availableCandidates', input.availableCandidates);

  const remainingCapacity = Math.max(0, input.workerCountNeeded - input.workersAlreadyAssigned);
  const isFinalAllowedWave = input.waveNumber >= configuration.maxWaves;
  const allowedWave = input.waveNumber <= configuration.maxWaves;
  const targetByCapacity = remainingCapacity * configuration.workerMultiplier;
  const targetCandidateCount = input.availableCandidates === undefined
    ? targetByCapacity
    : Math.min(targetByCapacity, input.availableCandidates);
  const canDispatch = allowedWave && remainingCapacity > 0 && targetCandidateCount > 0;

  return Object.freeze({
    waveNumber: input.waveNumber,
    remainingCapacity,
    targetCandidateCount,
    radiusMeters: configuration.radiusMetersByWave[Math.min(input.waveNumber, configuration.maxWaves) - 1],
    timeoutMs: configuration.timeoutMs,
    isFinalAllowedWave,
    canDispatch,
    shouldTryNextWave: canDispatch && !isFinalAllowedWave && !input.candidatesExhausted,
  });
}
