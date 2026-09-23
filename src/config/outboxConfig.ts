/**
 * LabourBaba Backend — Outbox Worker Configuration
 *
 * Centralized configuration for outbox polling, batch sizing, lease timeouts,
 * and graceful shutdown drain limits.
 */

export interface OutboxConfiguration {
  pollIntervalMs: number;
  batchSize: number;
  staleThresholdMinutes: number;
  shutdownDrainTimeoutMs: number;
}

export function getOutboxConfig(): OutboxConfiguration {
  const drainTimeoutEnv = process.env.OUTBOX_SHUTDOWN_DRAIN_TIMEOUT_MS;
  const parsedDrainTimeout = drainTimeoutEnv ? parseInt(drainTimeoutEnv, 10) : 5000;
  const shutdownDrainTimeoutMs =
    Number.isSafeInteger(parsedDrainTimeout) && parsedDrainTimeout > 0
      ? parsedDrainTimeout
      : 5000;

  const pollIntervalEnv = process.env.OUTBOX_POLL_INTERVAL_MS;
  const parsedPollInterval = pollIntervalEnv ? parseInt(pollIntervalEnv, 10) : 5000;
  const pollIntervalMs =
    Number.isSafeInteger(parsedPollInterval) && parsedPollInterval > 0
      ? parsedPollInterval
      : 5000;

  return {
    pollIntervalMs,
    batchSize: 20,
    staleThresholdMinutes: 5,
    shutdownDrainTimeoutMs,
  };
}

export const outboxConfig = getOutboxConfig();

export function assertOutboxConfig(): void {
  if (outboxConfig.shutdownDrainTimeoutMs <= 0 || !Number.isSafeInteger(outboxConfig.shutdownDrainTimeoutMs)) {
    throw new Error(
      `[CONFIG] Invalid OUTBOX_SHUTDOWN_DRAIN_TIMEOUT_MS: ${process.env.OUTBOX_SHUTDOWN_DRAIN_TIMEOUT_MS}. Must be a positive integer.`
    );
  }
}
