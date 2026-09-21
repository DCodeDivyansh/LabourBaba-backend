import { AsyncLocalStorage } from "async_hooks";

export interface RequestContext {
  requestId: string;
  correlationId: string;
  userId?: string;
  workerId?: string;
  userRole?: string;
  route?: string;
  method?: string;
  [key: string]: unknown;
}

const asyncLocalStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Runs a function within an explicit asynchronous request context.
 */
export function runWithRequestContext<T>(
  context: RequestContext,
  fn: () => Promise<T> | T
): Promise<T> | T {
  return asyncLocalStorage.run(context, fn);
}

/**
 * Retrieves the current asynchronous request context, if available.
 */
export function getRequestContext(): RequestContext | undefined {
  return asyncLocalStorage.getStore();
}

/**
 * Convenience helper to retrieve current correlation ID or fallback to undefined.
 */
export function getCorrelationId(): string | undefined {
  return asyncLocalStorage.getStore()?.correlationId;
}

/**
 * Convenience helper to retrieve current request ID or fallback to undefined.
 */
export function getRequestId(): string | undefined {
  return asyncLocalStorage.getStore()?.requestId;
}
