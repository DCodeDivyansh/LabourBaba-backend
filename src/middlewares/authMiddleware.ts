import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../utils/authUtils";
import { UserRole, isValidUserRole, AuthenticatedUser } from "../type/userRole";

export { UserRole, AuthenticatedUser };

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

/**
 * Express middleware to authenticate requests using JWT Bearer token.
 * Validates the JWT signature and normalizes the role claim against UserRole enum.
 */
export function authenticateJWT(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
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

  req.user = {
    id: decoded.id,
    phone: decoded.phone,
    role: decoded.role,
  };

  next();
}

/**
 * Express middleware to enforce Role-Based Access Control (RBAC).
 * Requires an authenticated principal with one of the allowed roles.
 * Must be executed after authenticateJWT.
 */
export function requireRole(...allowedRoles: UserRole[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        message: "Authentication required",
      });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      console.warn(
        `[SECURITY] Authorization failed: user ${req.user.id} with role '${req.user.role}' attempted to access route requiring [${allowedRoles.join(", ")}]`
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

