import { Request, Response } from "express";
import { storageService } from "./storage.service";
import { storageConfig } from "../../config/storageConfig";
import { logger } from "../../utils/logger";

export const storageController = {
  /**
   * GET /api/storage/download/*
   * Validates short-lived HMAC signature & expiration, checks physical object existence, and streams file.
   */
  async downloadObject(req: Request, res: Response): Promise<void> {
    try {
      const rawKey = req.params[0] || (req.params as any).key || "";
      const { exp, sig } = req.query as { exp?: string; sig?: string };

      if (!rawKey || !exp || !sig) {
        res.status(403).json({
          success: false,
          code: "STORAGE_SIGNATURE_MISSING",
          message: "Missing signature, key, or expiration parameters.",
        });
        return;
      }

      const key = storageService.normalizeObjectKey(rawKey);

      // Verify HMAC-SHA256 signature and expiration
      const isValid = storageService.verifySignedUrl(key, exp, sig, "GET");
      if (!isValid) {
        res.status(403).json({
          success: false,
          code: "STORAGE_SIGNATURE_INVALID",
          message: "The download link is invalid or has expired.",
        });
        return;
      }

      // Check physical existence in durable storage
      const exists = await storageService.objectExists(key);
      if (!exists) {
        res.status(404).json({
          success: false,
          code: "STORAGE_OBJECT_NOT_FOUND",
          message: "The requested document could not be found in storage.",
        });
        return;
      }

      // Retrieve binary data from durable storage
      const obj = await storageService.getObject(key);
      if (!obj) {
        res.status(404).json({
          success: false,
          code: "STORAGE_OBJECT_NOT_FOUND",
          message: "The requested document could not be found in storage.",
        });
        return;
      }

      // Security headers for private identity documents
      res.setHeader("Content-Type", obj.contentType || "application/octet-stream");
      res.setHeader("Content-Length", obj.data.length);
      res.setHeader("Cache-Control", "private, no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Disposition", "inline");

      res.status(200).send(obj.data);
    } catch (err: any) {
      logger.error("[STORAGE_DOWNLOAD_ERROR]", { error: err.message });
      res.status(500).json({
        success: false,
        code: "STORAGE_DOWNLOAD_FAILED",
        message: "Failed to download document.",
      });
    }
  },

  /**
   * PUT /api/storage/upload/*
   * Validates presigned upload URL, enforces MIME allowlist & file size, and writes binary data to durable storage.
   */
  async uploadObject(req: Request, res: Response): Promise<void> {
    try {
      const rawKey = req.params[0] || (req.params as any).key || "";
      const { exp, sig } = req.query as { exp?: string; sig?: string };
      const rawContentType = req.headers["content-type"];

      if (!rawKey || !exp || !sig) {
        res.status(403).json({
          success: false,
          code: "STORAGE_SIGNATURE_MISSING",
          message: "Missing signature, key, or expiration parameters.",
        });
        return;
      }

      if (!rawContentType) {
        res.status(400).json({
          success: false,
          code: "STORAGE_MIME_MISSING",
          message: "Content-Type header is required for document upload.",
        });
        return;
      }

      const contentType = rawContentType.split(";")[0].trim().toLowerCase();
      if (!storageConfig.allowedMimeTypes.includes(contentType)) {
        res.status(415).json({
          success: false,
          code: "STORAGE_MIME_UNSUPPORTED",
          message: `MIME type '${contentType}' is not permitted. Allowed types: ${storageConfig.allowedMimeTypes.join(", ")}`,
        });
        return;
      }

      const key = storageService.normalizeObjectKey(rawKey);

      const isValid = storageService.verifySignedUrl(key, exp, sig, "PUT", contentType);
      if (!isValid) {
        res.status(403).json({
          success: false,
          code: "STORAGE_SIGNATURE_INVALID",
          message: "The upload link is invalid, expired, or does not match the content type.",
        });
        return;
      }

      // Read binary buffer
      const rawBody = (req as any).rawBody || req.body;
      const data = Buffer.isBuffer(rawBody)
        ? rawBody
        : typeof rawBody === "string"
        ? Buffer.from(rawBody)
        : Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from("");

      if (data.length === 0) {
        res.status(400).json({
          success: false,
          code: "STORAGE_EMPTY_PAYLOAD",
          message: "Upload payload cannot be empty.",
        });
        return;
      }

      if (data.length > storageConfig.maxSizeBytes) {
        res.status(413).json({
          success: false,
          code: "STORAGE_PAYLOAD_TOO_LARGE",
          message: `File size (${data.length} bytes) exceeds maximum permitted limit (${storageConfig.maxSizeBytes} bytes).`,
        });
        return;
      }

      await storageService.putObject(key, data, contentType);

      res.status(200).json({
        success: true,
        message: "Document uploaded successfully.",
        data: {
          key,
          size: data.length,
          contentType,
        },
      });
    } catch (err: any) {
      logger.error("[STORAGE_UPLOAD_ERROR]", { error: err.message });
      res.status(500).json({
        success: false,
        code: "STORAGE_UPLOAD_FAILED",
        message: "Failed to upload document.",
      });
    }
  },
};
