import { AuthenticatedUser, UserRole } from "../type/userRole";

export { AuthenticatedUser, UserRole };
export type PolicyActor = AuthenticatedUser;

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
  statusCode?: number;
  code?: string;
}

export class AuthorizationError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  get status(): number {
    return this.statusCode;
  }

  constructor(
    message: string,
    statusCode: number = 403,
    code = "FORBIDDEN"
  ) {
    super(message);
    this.name = "AuthorizationError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * Asserts that a policy decision allowed access.
 * Throws an AuthorizationError with appropriate status code if denied.
 */
export function assertPolicy(decision: PolicyDecision): void {
  if (!decision.allowed) {
    throw new AuthorizationError(
      decision.reason || "Forbidden: Insufficient permissions",
      decision.statusCode || 403,
      decision.code || "FORBIDDEN"
    );
  }
}
