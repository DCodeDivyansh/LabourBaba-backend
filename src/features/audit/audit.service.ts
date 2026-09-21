import prisma from "../../config/prisma";
import { Prisma } from "@prisma/client";
import { AuditAction, AuditEventInput, AuditLogDTO, AuditLogQueryParams } from "./audit.types";
import { getCorrelationId } from "../../utils/requestContext";
import { logger } from "../../utils/logger";
import { metricsService } from "../../metrics/metrics.service";

const FORBIDDEN_METADATA_KEYS = new Set([
  "password",
  "password_hash",
  "token",
  "refresh_token",
  "access_token",
  "otp",
  "otp_hash",
  "secret",
  "private_key",
  "signed_url",
  "file_url",
  "authorization",
  "cookie",
]);

export class AuditService {
  /**
   * Deeply sanitizes metadata object to prevent secrets, tokens, or PII from entering audit logs.
   */
  sanitizeMetadata(metadata?: Record<string, any> | null): Record<string, any> | undefined {
    if (!metadata || typeof metadata !== "object") return undefined;

    const sanitized: Record<string, any> = {};

    for (const [key, value] of Object.entries(metadata)) {
      const lowerKey = key.toLowerCase();

      // Skip forbidden keys
      if (FORBIDDEN_METADATA_KEYS.has(lowerKey)) {
        sanitized[key] = "[REDACTED]";
        continue;
      }

      if (value && typeof value === "object" && !Array.isArray(value)) {
        sanitized[key] = this.sanitizeMetadata(value);
      } else if (typeof value === "string" && (value.startsWith("http://") || value.startsWith("https://")) && value.includes("token=")) {
        // Redact URLs with query tokens
        sanitized[key] = "[SIGNED_URL_REDACTED]";
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  /**
   * Records a durable audit log in the PostgreSQL database.
   * Supports transactional dual-write when passed a Prisma transaction client.
   */
  async recordEvent(
    txOrPrisma: Prisma.TransactionClient | typeof prisma,
    event: AuditEventInput,
  ): Promise<AuditLogDTO> {
    const correlationId = event.correlationId || getCorrelationId() || null;
    const sanitizedMetadata = this.sanitizeMetadata(event.metadata);

    const client = txOrPrisma || prisma;

    const record = await (client as any).audit_log.create({
      data: {
        actor_id: event.actorId,
        actor_role: event.actorRole,
        action: event.action,
        target_type: event.targetType,
        target_id: event.targetId,
        reason: event.reason || null,
        correlation_id: correlationId,
        ip_address: event.ipAddress || null,
        user_agent: event.userAgent || null,
        metadata: sanitizedMetadata || Prisma.JsonNull,
      },
    });

    // Record metrics
    metricsService.recordAuditEvent(event.action, event.actorRole);

    logger.info(`[AUDIT] ${event.action} by ${event.actorRole}:${event.actorId} on ${event.targetType}:${event.targetId}`, {
      auditId: record.id,
      action: event.action,
      actorId: event.actorId,
      actorRole: event.actorRole,
      targetType: event.targetType,
      targetId: event.targetId,
      correlationId,
    });

    return {
      id: record.id,
      actorId: record.actor_id,
      actorRole: record.actor_role,
      action: record.action,
      targetType: record.target_type,
      targetId: record.target_id,
      reason: record.reason,
      correlationId: record.correlation_id,
      ipAddress: record.ip_address,
      userAgent: record.user_agent,
      metadata: record.metadata,
      createdAt: record.created_at.toISOString(),
    };
  }

  /**
   * Queries durable audit logs with filtering and pagination for admin investigation.
   */
  async queryAuditLogs(params: AuditLogQueryParams): Promise<{ items: AuditLogDTO[]; total: number; page: number; limit: number }> {
    const page = Math.max(1, params.page || 1);
    const limit = Math.max(1, Math.min(params.limit || 50, 100));
    const skip = (page - 1) * limit;

    const where: any = {};

    if (params.action) where.action = params.action;
    if (params.actorId) where.actor_id = params.actorId;
    if (params.targetType) where.target_type = params.targetType;
    if (params.targetId) where.target_id = params.targetId;
    if (params.correlationId) where.correlation_id = params.correlationId;

    if (params.startDate || params.endDate) {
      where.created_at = {};
      if (params.startDate) where.created_at.gte = params.startDate;
      if (params.endDate) where.created_at.lte = params.endDate;
    }

    const [items, total] = await Promise.all([
      (prisma as any).audit_log.findMany({
        where,
        orderBy: { created_at: "desc" },
        skip,
        take: limit,
      }),
      (prisma as any).audit_log.count({ where }),
    ]);

    return {
      items: items.map((r: any) => ({
        id: r.id,
        actorId: r.actor_id,
        actorRole: r.actor_role,
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        reason: r.reason,
        correlationId: r.correlation_id,
        ipAddress: r.ip_address,
        userAgent: r.user_agent,
        metadata: r.metadata,
        createdAt: r.created_at.toISOString(),
      })),
      total,
      page,
      limit,
    };
  }
}

export const auditService = new AuditService();
