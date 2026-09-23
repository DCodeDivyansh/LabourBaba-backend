/**
 * Test Failure Injection Manager (P6 Issue 7)
 *
 * Provides deterministic, isolated failure-injection barriers to prove
 * crash recovery and dual-write resilience between PostgreSQL and BullMQ.
 *
 * STRICT PRODUCTION GUARDS:
 * - Prohibited in production (`process.env.NODE_ENV === 'production'`).
 * - Any attempt to enable or trigger in production immediately throws or returns false.
 * - Disabled by default in all environments.
 */

export type FailureInjectionPoint =
  | 'AFTER_DB_COMMIT_BEFORE_QUEUE_ENQUEUE'
  | 'AFTER_DB_COMMIT_BEFORE_TIMEOUT_ENQUEUE'
  | 'AFTER_DB_COMMIT_BEFORE_NOTIFICATION_ENQUEUE';

export class FailureInjectionManager {
  private activeHooks = new Set<FailureInjectionPoint>();

  /**
   * Activates a specific failure injection hook for deterministic testing.
   */
  public enableHook(hook: FailureInjectionPoint): void {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[SECURITY] Failure injection is strictly prohibited in production environment.');
    }
    this.activeHooks.add(hook);
  }

  /**
   * Deactivates a specific failure injection hook.
   */
  public disableHook(hook: FailureInjectionPoint): void {
    this.activeHooks.delete(hook);
  }

  /**
   * Clears all active hooks.
   */
  public clearAllHooks(): void {
    this.activeHooks.clear();
  }

  /**
   * Checks whether a failure injection hook is currently active.
   * Always returns false in production.
   */
  public isHookActive(hook: FailureInjectionPoint): boolean {
    if (process.env.NODE_ENV === 'production') {
      return false;
    }
    return this.activeHooks.has(hook);
  }

  /**
   * Triggers the failure if the specified hook is active.
   * Throws a deterministic error simulating a process crash or network failure.
   */
  public triggerIfActive(hook: FailureInjectionPoint, contextOrMessage?: string | Record<string, any>): void {
    if (this.isHookActive(hook)) {
      const msg = typeof contextOrMessage === 'string'
        ? contextOrMessage
        : contextOrMessage
        ? `[SIMULATED_FAILURE:${hook}] Intentional crash after DB commit before queue enqueue (${JSON.stringify(contextOrMessage)})`
        : `[SIMULATED_FAILURE:${hook}] Intentional crash after DB commit before queue enqueue`;
      throw new Error(msg);
    }
  }
}

export const failureInjection = new FailureInjectionManager();
