export enum UserRole {
  CUSTOMER = "customer",
  WORKER = "worker",
  ADMIN = "admin",
}

export function isValidUserRole(role: unknown): role is UserRole {
  return typeof role === "string" && Object.values(UserRole).includes(role as UserRole);
}

export interface AuthenticatedUser {
  id: string;
  phone?: string;
  role: UserRole;
}

export interface JwtPayload {
  id: string;
  phone?: string;
  role: UserRole;
  iat?: number;
  exp?: number;
}
