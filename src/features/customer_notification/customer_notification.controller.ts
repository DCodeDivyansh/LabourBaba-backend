import { Request, Response } from "express";
import { customerNotificationService } from "./customer_notification.service";
import { customerDeviceService } from "../customer_device/customer_device.service";
import { UserRole } from "../../type/userRole";

/**
 * Lists notifications for the authenticated customer.
 */
export const listCustomerNotifications = async (req: Request, res: Response): Promise<void> => {
  try {
    const customerId = (req as any).user?.id;
    if (!customerId || (req as any).user?.role !== UserRole.CUSTOMER) {
      res.status(403).json({ success: false, message: "Forbidden: Customer role required" });
      return;
    }

    const unreadOnly = req.query.unread_only === "true" || req.query.unreadOnly === "true";
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
    const offset = req.query.offset ? parseInt(String(req.query.offset), 10) : 0;
    const cursor = req.query.cursor ? String(req.query.cursor) : undefined;

    const data = await customerNotificationService.listNotifications(customerId, {
      unreadOnly,
      limit,
      offset,
      cursor,
    });

    res.status(200).json({
      success: true,
      data: data.notifications,
      meta: {
        total: data.total,
        unreadCount: data.unreadCount,
        limit,
        offset,
        cursor: cursor || null,
        nextCursor: data.nextCursor,
      },
    });
  } catch (err: any) {
    const status = err.statusCode || 500;
    res.status(status).json({ success: false, message: err.message || "Internal server error" });
  }
};

/**
 * Retrieves unread (unacknowledged) notifications for the authenticated customer.
 */
export const getUnreadCustomerNotifications = async (req: Request, res: Response): Promise<void> => {
  try {
    const customerId = (req as any).user?.id;
    if (!customerId || (req as any).user?.role !== UserRole.CUSTOMER) {
      res.status(403).json({ success: false, message: "Forbidden: Customer role required" });
      return;
    }

    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
    const notifications = await customerNotificationService.getUnreadNotifications(customerId, limit);

    res.status(200).json({
      success: true,
      data: notifications,
      meta: { count: notifications.length },
    });
  } catch (err: any) {
    const status = err.statusCode || 500;
    res.status(status).json({ success: false, message: err.message || "Internal server error" });
  }
};

/**
 * Acknowledges a single notification for the authenticated customer.
 */
export const acknowledgeCustomerNotification = async (req: Request, res: Response): Promise<void> => {
  try {
    const customerId = (req as any).user?.id;
    if (!customerId || (req as any).user?.role !== UserRole.CUSTOMER) {
      res.status(403).json({ success: false, message: "Forbidden: Customer role required" });
      return;
    }

    const notificationId = req.params.id ? String(req.params.id) : "";
    if (!notificationId) {
      res.status(400).json({ success: false, message: "Notification ID is required" });
      return;
    }

    const result = await customerNotificationService.acknowledgeNotification(customerId, notificationId);
    res.status(200).json({
      success: true,
      message: "Notification acknowledged",
      data: result,
    });
  } catch (err: any) {
    const status = err.statusCode || 500;
    res.status(status).json({ success: false, message: err.message || "Internal server error" });
  }
};

/**
 * Acknowledges all pending notifications for the authenticated customer.
 */
export const acknowledgeAllCustomerNotifications = async (req: Request, res: Response): Promise<void> => {
  try {
    const customerId = (req as any).user?.id;
    if (!customerId || (req as any).user?.role !== UserRole.CUSTOMER) {
      res.status(403).json({ success: false, message: "Forbidden: Customer role required" });
      return;
    }

    const result = await customerNotificationService.acknowledgeAll(customerId);
    res.status(200).json({
      success: true,
      message: `Acknowledged ${result.acknowledgedCount} notification(s)`,
      data: result,
    });
  } catch (err: any) {
    const status = err.statusCode || 500;
    res.status(status).json({ success: false, message: err.message || "Internal server error" });
  }
};

/**
 * Registers or updates a device for the authenticated customer.
 */
export const registerCustomerDevice = async (req: Request, res: Response): Promise<void> => {
  try {
    const customerId = (req as any).user?.id;
    if (!customerId || (req as any).user?.role !== UserRole.CUSTOMER) {
      res.status(403).json({ success: false, message: "Forbidden: Customer role required" });
      return;
    }

    const { device_token, device_id, platform } = req.body;
    if (!device_token || typeof device_token !== "string" || !device_token.trim()) {
      res.status(400).json({ success: false, message: "device_token is required" });
      return;
    }

    const device = await customerDeviceService.registerDevice(customerId, {
      device_token: device_token.trim(),
      device_id: device_id ? String(device_id).trim() : undefined,
      platform: platform ? String(platform).trim() : "android",
    });

    res.status(200).json({
      success: true,
      message: "Device registered successfully",
      data: device,
    });
  } catch (err: any) {
    const status = err.statusCode || 500;
    res.status(status).json({ success: false, message: err.message || "Internal server error" });
  }
};

/**
 * Lists devices registered by the authenticated customer.
 */
export const listCustomerDevices = async (req: Request, res: Response): Promise<void> => {
  try {
    const customerId = (req as any).user?.id;
    if (!customerId || (req as any).user?.role !== UserRole.CUSTOMER) {
      res.status(403).json({ success: false, message: "Forbidden: Customer role required" });
      return;
    }

    const devices = await customerDeviceService.listDevices(customerId);
    res.status(200).json({
      success: true,
      data: devices,
    });
  } catch (err: any) {
    const status = err.statusCode || 500;
    res.status(status).json({ success: false, message: err.message || "Internal server error" });
  }
};

/**
 * Revokes a device owned by the authenticated customer.
 */
export const revokeCustomerDevice = async (req: Request, res: Response): Promise<void> => {
  try {
    const customerId = (req as any).user?.id;
    if (!customerId || (req as any).user?.role !== UserRole.CUSTOMER) {
      res.status(403).json({ success: false, message: "Forbidden: Customer role required" });
      return;
    }

    const deviceId = req.params.deviceId ? String(req.params.deviceId) : "";
    if (!deviceId) {
      res.status(400).json({ success: false, message: "deviceId parameter is required" });
      return;
    }

    const result = await customerDeviceService.revokeDevice(customerId, deviceId);
    res.status(200).json({
      success: true,
      message: "Device revoked successfully",
      data: result,
    });
  } catch (err: any) {
    const status = err.statusCode || 500;
    res.status(status).json({ success: false, message: err.message || "Internal server error" });
  }
};
