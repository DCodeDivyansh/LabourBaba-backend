export enum AuditAction {
  WORKER_SUSPENDED = "WORKER_SUSPENDED",
  WORKER_REACTIVATED = "WORKER_REACTIVATED",
  WORKER_VERIFIED = "WORKER_VERIFIED",
  WORKER_REJECTED = "WORKER_REJECTED",
  DOCUMENT_ACCESSED = "DOCUMENT_ACCESSED",
  DOCUMENT_VERIFICATION_CHANGED = "DOCUMENT_VERIFICATION_CHANGED",
  SESSION_REVOKED = "SESSION_REVOKED",
  REFRESH_TOKEN_REUSE_DETECTED = "REFRESH_TOKEN_REUSE_DETECTED",
  SECURITY_CONFIG_CHANGED = "SECURITY_CONFIG_CHANGED",
}

export interface AuditEventInput {
  actorId: string;
  actorRole: "admin" | "system" | "worker" | "customer";
  action: AuditAction | string;
  targetType: "worker" | "customer" | "document" | "booking" | "session" | "config" | string;
  targetId: string;
  reason?: string | null;
  correlationId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, any> | null;
}

export interface AuditLogDTO {
  id: string;
  actorId: string;
  actorRole: string;
  action: string;
  targetType: string;
  targetId: string;
  reason?: string | null;
  correlationId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, any> | null;
  createdAt: string;
}

export interface AuditLogQueryParams {
  action?: string;
  actorId?: string;
  targetType?: string;
  targetId?: string;
  correlationId?: string;
  startDate?: Date;
  endDate?: Date;
  page?: number;
  limit?: number;
}
