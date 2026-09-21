import crypto from 'crypto';

export interface DispatchOperationParams {
  requirementId: string;
  waveNumber?: number | null;
  operationType?: string | null;
}

export interface DispatchOperationResult {
  operationId: string;
  requirementId: string;
  jobId: string;
  waveNumber: number;
  waveId: string | null;
  status: 'created' | 'already_processed' | 'skipped_terminal' | 'skipped_not_found' | 'no_workers';
  workersDispatchedCount: number;
  workerIds: string[];
}

/**
 * Generates a deterministic, collision-resistant dispatch operation ID.
 *
 * Identity Formula:
 *   canonicalString = "req:<requirement_id>:wave:<wave_number>:type:<operation_type>"
 *   operationId     = "disp_op_" + sha256(canonicalString)[0..31]
 *
 * Guarantees:
 * 1. Deterministic: Identical business inputs always produce the exact same ID.
 * 2. Stable: Independent of wall-clock time, worker instance, or retry attempt.
 * 3. Normalized: Case and whitespace insensitive for requirementId and operationType.
 * 4. DB & URL Safe: Fixed length 40-character ASCII alphanumeric string (starts with `disp_op_`).
 */
export function generateDispatchOperationId(params: DispatchOperationParams): string {
  const reqId = (params.requirementId || '').trim().toLowerCase();
  const waveNum = typeof params.waveNumber === 'number' && params.waveNumber > 0 ? params.waveNumber : 1;
  const opType = (params.operationType || 'WAVE_DISPATCH').trim().toUpperCase();

  const canonicalKey = `req:${reqId}:wave:${waveNum}:type:${opType}`;
  const digest = crypto.createHash('sha256').update(canonicalKey).digest('hex').slice(0, 32);
  return `disp_op_${digest}`;
}

/**
 * Validates that a given operation ID matches the expected deterministic ID for the inputs.
 */
export function validateDispatchOperationId(
  operationId: string,
  params: DispatchOperationParams,
): boolean {
  if (!operationId || typeof operationId !== 'string') {
    return false;
  }
  const expected = generateDispatchOperationId(params);
  return operationId === expected;
}
