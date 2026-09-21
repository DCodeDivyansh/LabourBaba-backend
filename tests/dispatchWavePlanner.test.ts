import { getDispatchWaveConfiguration } from '../src/config/dispatchWaveConfig';
import { planDispatchWave } from '../src/features/dispatch/wavePlanner';

describe('Issue #25: canonical dispatch wave planner', () => {
  it('applies the worker multiplier to remaining capacity, not total demand', () => {
    expect(planDispatchWave({ workerCountNeeded: 5, workersAlreadyAssigned: 4, waveNumber: 1 }))
      .toMatchObject({ remainingCapacity: 1, targetCandidateCount: 2, radiusMeters: 3_000, timeoutMs: 30_000 });
    expect(planDispatchWave({ workerCountNeeded: 3, workersAlreadyAssigned: 0, waveNumber: 1 }).targetCandidateCount).toBe(6);
  });

  it('caps a target by the available candidate page without declaring page exhaustion', () => {
    const plan = planDispatchWave({ workerCountNeeded: 5, workersAlreadyAssigned: 0, waveNumber: 2, availableCandidates: 3 });
    expect(plan).toMatchObject({ targetCandidateCount: 3, radiusMeters: 5_000, canDispatch: true, shouldTryNextWave: true });
  });

  it('uses deterministic radius, timeout, and inclusive maximum-wave behavior', () => {
    expect(planDispatchWave({ workerCountNeeded: 1, workersAlreadyAssigned: 0, waveNumber: 4 }))
      .toMatchObject({ radiusMeters: 15_000, timeoutMs: 30_000, isFinalAllowedWave: true, canDispatch: true });
    expect(planDispatchWave({ workerCountNeeded: 1, workersAlreadyAssigned: 0, waveNumber: 5 }))
      .toMatchObject({ canDispatch: false, targetCandidateCount: 2 });
  });

  it('has no dispatchable wave when capacity is full or candidates are exhausted', () => {
    expect(planDispatchWave({ workerCountNeeded: 2, workersAlreadyAssigned: 2, waveNumber: 1 }))
      .toMatchObject({ remainingCapacity: 0, targetCandidateCount: 0, canDispatch: false });
    expect(planDispatchWave({ workerCountNeeded: 2, workersAlreadyAssigned: 0, waveNumber: 1, availableCandidates: 0 }))
      .toMatchObject({ targetCandidateCount: 0, canDispatch: false });
  });

  it('is deterministic for equal inputs', () => {
    const input = { workerCountNeeded: 4, workersAlreadyAssigned: 1, waveNumber: 3, availableCandidates: 5 };
    expect(planDispatchWave(input)).toEqual(planDispatchWave(input));
  });

  it('validates configuration and malformed planner inputs', () => {
    expect(() => getDispatchWaveConfiguration({ DISPATCH_WAVE_WORKER_MULTIPLIER: '0' })).toThrow(/positive integer/);
    expect(() => getDispatchWaveConfiguration({ DISPATCH_WAVE_RADII_METERS: '3000,nope' })).toThrow(/RADII/);
    expect(() => getDispatchWaveConfiguration({ DISPATCH_MAX_WAVES: '5', DISPATCH_WAVE_RADII_METERS: '3000,5000' })).toThrow(/cannot exceed/);
    expect(() => planDispatchWave({ workerCountNeeded: -1, workersAlreadyAssigned: 0, waveNumber: 1 })).toThrow(/non-negative/);
    expect(() => planDispatchWave({ workerCountNeeded: 1, workersAlreadyAssigned: 0, waveNumber: 0 })).toThrow(/start at 1/);
  });
});
