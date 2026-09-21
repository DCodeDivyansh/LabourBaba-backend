import { LocationFreshnessReason } from './locationFreshnessPolicy';

export type ExclusionReason =
  | 'STALE_LOCATION'
  | 'MISSING_LOCATION'
  | 'INVALID_LOCATION'
  | 'FUTURE_LOCATION';

export interface LocationFreshnessMetrics {
  evaluationsTotal: {
    fresh: number;
    stale: number;
    missing: number;
    invalid: number;
    future_skew_exceeded: number;
  };
  exclusionsTotal: {
    stale_location: number;
    missing_location: number;
    invalid_location: number;
    future_location: number;
  };
  lastResetAt: string;
}

class LocationFreshnessTelemetry {
  private evaluations = {
    fresh: 0,
    stale: 0,
    missing: 0,
    invalid: 0,
    future_skew_exceeded: 0,
  };

  private exclusions = {
    stale_location: 0,
    missing_location: 0,
    invalid_location: 0,
    future_location: 0,
  };

  private lastResetAt = new Date().toISOString();

  /**
   * Records a location freshness evaluation event (low-cardinality).
   */
  recordEvaluation(reason: LocationFreshnessReason): void {
    switch (reason) {
      case 'FRESH':
        this.evaluations.fresh++;
        break;
      case 'STALE':
        this.evaluations.stale++;
        break;
      case 'MISSING':
        this.evaluations.missing++;
        break;
      case 'INVALID':
        this.evaluations.invalid++;
        break;
      case 'FUTURE_SKEW_EXCEEDED':
        this.evaluations.future_skew_exceeded++;
        break;
    }
  }

  /**
   * Records candidate exclusion due to location freshness issues during dispatch queries.
   */
  recordExclusion(reason: ExclusionReason): void {
    switch (reason) {
      case 'STALE_LOCATION':
        this.exclusions.stale_location++;
        break;
      case 'MISSING_LOCATION':
        this.exclusions.missing_location++;
        break;
      case 'INVALID_LOCATION':
        this.exclusions.invalid_location++;
        break;
      case 'FUTURE_LOCATION':
        this.exclusions.future_location++;
        break;
    }
  }

  /**
   * Returns snapshot of location freshness metrics.
   */
  getMetrics(): LocationFreshnessMetrics {
    return {
      evaluationsTotal: { ...this.evaluations },
      exclusionsTotal: { ...this.exclusions },
      lastResetAt: this.lastResetAt,
    };
  }

  /**
   * Resets metrics (useful for testing and monitoring windows).
   */
  reset(): void {
    this.evaluations = {
      fresh: 0,
      stale: 0,
      missing: 0,
      invalid: 0,
      future_skew_exceeded: 0,
    };
    this.exclusions = {
      stale_location: 0,
      missing_location: 0,
      invalid_location: 0,
      future_location: 0,
    };
    this.lastResetAt = new Date().toISOString();
  }
}

export const locationFreshnessTelemetry = new LocationFreshnessTelemetry();
