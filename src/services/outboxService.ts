import { Prisma } from "@prisma/client";
import prisma from "../config/prisma";
import { getCorrelationId } from "../utils/requestContext";
import { logger } from "../utils/logger";

export interface CreateOutboxEventDTO {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  recipientType: "worker" | "customer" | "admin" | "system";
  recipientId: string;
  payload: Record<string, any>;
  idempotencyKey?: string;
  correlationId?: string;
}

export interface OutboxRecord {
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  recipient_type: string;
  recipient_id: string;
  payload: any;
  status: string;
  attempts: number;
  max_attempts: number;
  available_at: Date;
  processed_at: Date | null;
  failed_at: Date | null;
  last_error: string | null;
  idempotency_key: string | null;
  correlation_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export class OutboxService {
  /**
   * Enqueues a notification outbox record within an existing database transaction.
   * Ensures business state mutation and outbox event commit atomically.
   */
  public async createOutboxEvent(
    tx: Prisma.TransactionClient,
    dto: CreateOutboxEventDTO
  ): Promise<OutboxRecord | null> {
    const correlationId = dto.correlationId || getCorrelationId() || undefined;
    const idempotencyKey =
      dto.idempotencyKey ||
      `${dto.eventType}:${dto.aggregateType}:${dto.aggregateId}:${dto.recipientId}`;

    try {
      const record = await (tx as any).notification_outbox.create({
        data: {
          event_type: dto.eventType,
          aggregate_type: dto.aggregateType,
          aggregate_id: dto.aggregateId,
          recipient_type: dto.recipientType,
          recipient_id: dto.recipientId,
          payload: dto.payload,
          idempotency_key: idempotencyKey,
          correlation_id: correlationId,
          status: "PENDING",
        },
      });

      logger.info(`[OUTBOX_CREATED] Created outbox event ${dto.eventType} for ${dto.recipientType} ${dto.recipientId}`, {
        outboxId: record.id,
        eventType: dto.eventType,
        aggregateId: dto.aggregateId,
        recipientId: dto.recipientId,
        correlationId,
      });

      return record;
    } catch (err: any) {
      // If unique constraint violated on idempotency_key, handle safely
      if (err.code === "P2002") {
        logger.warn(`[OUTBOX_DUPLICATE] Outbox event with key ${idempotencyKey} already exists. Skipping duplicate.`, {
          idempotencyKey,
          correlationId,
        });
        return null;
      }
      throw err;
    }
  }

  /**
   * Claims a batch of eligible PENDING outbox records for processing.
   */
  public async claimPendingEvents(batchSize = 20): Promise<OutboxRecord[]> {
    const now = new Date();

    // Use transaction to find and claim pending events
    return await prisma.$transaction(async (tx) => {
      const eligible = await (tx as any).notification_outbox.findMany({
        where: {
          status: "PENDING",
          available_at: { lte: now },
        },
        orderBy: { created_at: "asc" },
        take: batchSize,
      });

      if (!eligible || eligible.length === 0) {
        return [];
      }

      const ids = eligible.map((e: any) => e.id);

      await (tx as any).notification_outbox.updateMany({
        where: { id: { in: ids } },
        data: {
          status: "PROCESSING",
          updated_at: now,
        },
      });

      return eligible;
    });
  }

  /**
   * Marks an outbox event as successfully sent / processed.
   */
  public async markEventSuccess(id: string): Promise<void> {
    await (prisma as any).notification_outbox.update({
      where: { id },
      data: {
        status: "SENT",
        processed_at: new Date(),
        updated_at: new Date(),
      },
    });

    logger.info(`[OUTBOX_SENT] Outbox event ${id} processed and delivered successfully.`, { outboxId: id });
  }

  /**
   * Records a delivery failure, scheduling a retry with backoff or marking as terminal failure.
   */
  public async markEventFailure(
    id: string,
    errorMessage: string,
    isPermanent = false
  ): Promise<void> {
    const record = await (prisma as any).notification_outbox.findUnique({ where: { id } });
    if (!record) return;

    const nextAttempt = record.attempts + 1;
    const isTerminal = isPermanent || nextAttempt >= record.max_attempts;

    if (isTerminal) {
      await (prisma as any).notification_outbox.update({
        where: { id },
        data: {
          status: "FAILED",
          attempts: nextAttempt,
          failed_at: new Date(),
          last_error: errorMessage,
          updated_at: new Date(),
        },
      });

      logger.error(`[OUTBOX_FAILED] Outbox event ${id} permanently failed: ${errorMessage}`, {
        outboxId: id,
        attempts: nextAttempt,
        isPermanent,
        error: errorMessage,
        correlationId: record.correlation_id,
      });
    } else {
      // Exponential backoff: 5s, 15s, 45s, 135s...
      const backoffSeconds = Math.min(300, Math.pow(3, nextAttempt) * 5);
      const nextAvailableAt = new Date(Date.now() + backoffSeconds * 1000);

      await (prisma as any).notification_outbox.update({
        where: { id },
        data: {
          status: "PENDING",
          attempts: nextAttempt,
          available_at: nextAvailableAt,
          last_error: errorMessage,
          updated_at: new Date(),
        },
      });

      logger.warn(`[OUTBOX_RETRY] Outbox event ${id} failed (attempt ${nextAttempt}), retry in ${backoffSeconds}s`, {
        outboxId: id,
        attempts: nextAttempt,
        backoffSeconds,
        nextAvailableAt: nextAvailableAt.toISOString(),
        error: errorMessage,
        correlationId: record.correlation_id,
      });
    }
  }

  /**
   * Reconciles stale outbox events stuck in PROCESSING due to process crashes or hard restarts.
   */
  public async reconcileStaleEvents(staleThresholdMinutes = 5): Promise<number> {
    const staleThreshold = new Date(Date.now() - staleThresholdMinutes * 60 * 1000);

    const result = await (prisma as any).notification_outbox.updateMany({
      where: {
        status: "PROCESSING",
        updated_at: { lte: staleThreshold },
      },
      data: {
        status: "PENDING",
        updated_at: new Date(),
      },
    });

    if (result.count > 0) {
      logger.info(`[OUTBOX_RECONCILE] Recovered ${result.count} stale PROCESSING outbox events.`);
    }

    return result.count;
  }
}

export const outboxService = new OutboxService();
