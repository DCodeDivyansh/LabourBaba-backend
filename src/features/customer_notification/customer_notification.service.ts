import prisma from "../../config/prisma";
import { logger } from "../../utils/logger";

export interface CustomerNotificationDTO {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: any;
  status: string;
  createdAt: Date;
  acknowledgedAt: Date | null;
  isRead: boolean;
}

export interface ListCustomerNotificationsOptions {
  unreadOnly?: boolean;
  limit?: number;
  offset?: number;
  cursor?: string;
}

export class CustomerNotificationService {
  /**
   * Lists notifications for an authenticated customer.
   * Invariant: Scoped strictly to recipient_type = 'customer' AND recipient_id = customerId.
   * Supports both offset and keyset/cursor pagination.
   */
  public async listNotifications(
    customerId: string,
    options: ListCustomerNotificationsOptions = {},
  ): Promise<{ notifications: CustomerNotificationDTO[]; total: number; unreadCount: number; nextCursor: string | null }> {
    const safeLimit = Math.min(100, Math.max(1, options.limit || 50));
    const safeOffset = Math.max(0, options.offset || 0);

    const baseWhere: any = {
      recipient_type: "customer",
      recipient_id: customerId,
    };

    const queryWhere = { ...baseWhere };
    if (options.unreadOnly) {
      queryWhere.acknowledged_at = null;
    }

    const findArgs: any = {
      where: queryWhere,
      orderBy: { created_at: "desc" },
      take: safeLimit,
      select: {
        id: true,
        event_type: true,
        aggregate_type: true,
        aggregate_id: true,
        payload: true,
        status: true,
        created_at: true,
        acknowledged_at: true,
      },
    };

    if (options.cursor) {
      findArgs.cursor = { id: options.cursor };
      findArgs.skip = 1;
    } else {
      findArgs.skip = safeOffset;
    }

    const [rows, total, unreadCount] = await Promise.all([
      (prisma as any).notification_outbox.findMany(findArgs),
      (prisma as any).notification_outbox.count({ where: baseWhere }),
      (prisma as any).notification_outbox.count({ where: { ...baseWhere, acknowledged_at: null } }),
    ]);

    const notifications: CustomerNotificationDTO[] = (rows || []).map((r: any) => ({
      id: r.id,
      eventType: r.event_type,
      aggregateType: r.aggregate_type,
      aggregateId: r.aggregate_id,
      payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload,
      status: r.status,
      createdAt: r.created_at,
      acknowledgedAt: r.acknowledged_at ?? null,
      isRead: r.acknowledged_at !== null,
    }));

    const nextCursor = rows && rows.length === safeLimit ? rows[rows.length - 1].id : null;

    return { notifications, total, unreadCount, nextCursor };
  }

  /**
   * Retrieves unread (unacknowledged) notifications for customer offline recovery.
   */
  public async getUnreadNotifications(
    customerId: string,
    limit = 50,
  ): Promise<CustomerNotificationDTO[]> {
    const { notifications } = await this.listNotifications(customerId, {
      unreadOnly: true,
      limit,
    });
    return notifications;
  }

  /**
   * Explicit application-level acknowledgement of a notification.
   * Invariant: Customer A can NEVER acknowledge or mutate Customer B's notifications.
   */
  public async acknowledgeNotification(
    customerId: string,
    notificationId: string,
  ): Promise<{ success: boolean; notificationId: string; acknowledgedAt: Date }> {
    const existing = await (prisma as any).notification_outbox.findFirst({
      where: {
        id: notificationId,
        recipient_type: "customer",
        recipient_id: customerId,
      },
      select: {
        id: true,
        acknowledged_at: true,
      },
    });

    if (!existing) {
      logger.warn(`[CUSTOMER_NOTIFICATION_SECURITY] IDOR or invalid notification: User ${customerId} attempted to ack ${notificationId}`);
      const err: any = new Error("Notification not found or access denied");
      err.statusCode = 404;
      throw err;
    }

    if (existing.acknowledged_at) {
      return {
        success: true,
        notificationId,
        acknowledgedAt: existing.acknowledged_at,
      };
    }

    const now = new Date();
    await (prisma as any).notification_outbox.update({
      where: { id: notificationId },
      data: {
        acknowledged_at: now,
        acknowledged_by: customerId,
        updated_at: now,
      },
    });

    logger.info(`[CUSTOMER_NOTIFICATION_ACK] Customer ${customerId} acknowledged notification ${notificationId}`);

    return {
      success: true,
      notificationId,
      acknowledgedAt: now,
    };
  }

  /**
   * Acknowledges all pending unread notifications for a customer in bulk.
   */
  public async acknowledgeAll(
    customerId: string,
  ): Promise<{ success: boolean; acknowledgedCount: number }> {
    const now = new Date();
    const result = await (prisma as any).notification_outbox.updateMany({
      where: {
        recipient_type: "customer",
        recipient_id: customerId,
        acknowledged_at: null,
      },
      data: {
        acknowledged_at: now,
        acknowledged_by: customerId,
        updated_at: now,
      },
    });

    logger.info(`[CUSTOMER_NOTIFICATION_ACK_ALL] Customer ${customerId} acknowledged ${result.count} notification(s)`);

    return {
      success: true,
      acknowledgedCount: result.count,
    };
  }
}

export const customerNotificationService = new CustomerNotificationService();
