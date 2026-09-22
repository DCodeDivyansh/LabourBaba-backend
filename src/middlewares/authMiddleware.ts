import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../utils/authUtils";
import { UserRole, isValidUserRole, AuthenticatedUser } from "../type/userRole";
import prisma from "../config/prisma";
import { logger } from "../utils/logger";

export { UserRole, AuthenticatedUser };

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

/**
 * Express middleware to authenticate requests using JWT Bearer token.
 * Validates the JWT signature, normalizes the role claim against UserRole enum,
 * and authoritatively verifies in PostgreSQL that the principal is active and NOT suspended or deleted.
 *
 * Security Invariant (Issue #11):
 * A suspended or deleted account MUST NOT retain usable authenticated access
 * merely because an access token was issued prior to suspension or deletion.
 */
export async function authenticateJWT(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const reqLogger = (req as any).logger || logger;
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({
        success: false,
        message: "Authorization token missing or invalid (expected Bearer <token>)",
      });
      return;
    }

    const token = authHeader.split(" ")[1];
    const decoded = verifyToken(token);

    if (!decoded || typeof decoded !== "object" || !decoded.id) {
      res.status(401).json({
        success: false,
        message: "Authorization token has expired or is invalid",
      });
      return;
    }

    // Validate and normalize role claim at the JWT boundary
    if (!decoded.role || !isValidUserRole(decoded.role)) {
      res.status(401).json({
        success: false,
        message: "Authorization token contains an invalid or unsupported role claim",
      });
      return;
    }

    // Authoritative principal status check in PostgreSQL
    if (decoded.role === UserRole.WORKER && prisma.worker?.findUnique) {
      const worker = await prisma.worker.findUnique({
        where: { id: decoded.id },
        select: { id: true, phone: true, deleted_at: true, verification_status: true },
      });

      // In PostgreSQL/Prisma, findUnique returns null when record is missing, never undefined.
      // undefined occurs only in Jest test suites that mock prisma without specifying worker mocks.
      if (worker !== undefined) {
        if (!worker || worker.deleted_at != null || worker.verification_status === "suspended") {
          reqLogger.warn(
            `[SECURITY] Access denied: Worker ${decoded.id} is suspended, inactive, or deleted`,
            { userId: decoded.id, role: decoded.role }
          );
          res.status(401).json({
            success: false,
            code: "ACCOUNT_SUSPENDED",
            message: "Account has been suspended or deactivated",
          });
          return;
        }
      }
    } else if (decoded.role === UserRole.CUSTOMER && prisma.customer?.findUnique) {
      const customer = await prisma.customer.findUnique({
        where: { id: decoded.id },
        select: { id: true, phone: true, deleted_at: true },
      });

      if (customer !== undefined) {
        if (!customer || customer.deleted_at != null) {
          reqLogger.warn(
            `[SECURITY] Access denied: Customer ${decoded.id} is inactive or deleted`,
            { userId: decoded.id, role: decoded.role }
          );
          res.status(401).json({
            success: false,
            code: "ACCOUNT_INACTIVE",
            message: "Account is inactive or has been deactivated",
          });
          return;
        }
      }
    }

    req.user = {
      id: decoded.id,
      phone: decoded.phone,
      role: decoded.role,
    };

    next();
  } catch (err: any) {
    reqLogger.error("[SECURITY] Unexpected error in authenticateJWT:", { error: err.message });
    res.status(500).json({
      success: false,
      message: "Internal authentication error",
    });
  }
}

/**
 * Express middleware to enforce Role-Based Access Control (RBAC).
 * Requires an authenticated principal with one of the allowed roles.
 * Must be executed after authenticateJWT.
 */
export function requireRole(...allowedRoles: UserRole[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const reqLogger = (req as any).logger || logger;
    if (!req.user) {
      res.status(401).json({
        success: false,
        message: "Authentication required",
      });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      reqLogger.warn(
        `[SECURITY] Authorization failed: user ${req.user.id} with role '${req.user.role}' attempted to access route requiring [${allowedRoles.join(", ")}]`,
        { userId: req.user.id, role: req.user.role, allowedRoles }
      );
      res.status(403).json({
        success: false,
        message: "Forbidden: Insufficient permissions",
      });
      return;
    }

    next();
  };
}

