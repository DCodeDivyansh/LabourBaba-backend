import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { StorageDriver, StorageObjectMetadata } from "./storage.types";
import { LocalStorageDriver } from "./localStorageDriver";
import { logger } from "../../utils/logger";
import { metricsService } from "../../metrics/metrics.service";

/**
 * Production-ready Supabase / S3-compatible cloud object storage driver.
 *
 * Invariants:
 * 1. Zero fallback to local/mock/in-memory storage in all environments.
 * 2. Strict use of server-side service role key (anon/publishable key is forbidden).
 * 3. Bounded retry with exponential backoff for transient provider/network errors.
 * 4. Safe error logging with complete redaction of credentials, signatures, and document bytes.
 * 5. Full observability wiring via Prometheus metrics.
 */
export class SupabaseStorageDriver implements StorageDriver {
  private readonly client: SupabaseClient | null = null;
  private readonly bucketName: string;
  public readonly fallbackDriver: LocalStorageDriver | null = null;
  private readonly isProduction: boolean;

  constructor(bucketName: string) {
    this.bucketName = bucketName;
    this.isProduction = process.env.NODE_ENV === "production";
    this.fallbackDriver = null; // Zero local fallback in any environment

    const supabaseUrl = process.env.SUPABASE_URL;
    // Strictly require service role secret key; anon/publishable key lacks private bucket permissions
    const supabaseKey =
      process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (this.isProduction) {
      if (!supabaseUrl || !supabaseUrl.startsWith("https://") || !supabaseKey) {
        throw new Error(
          "[STORAGE_FATAL] Production requires valid SUPABASE_URL and SUPABASE_SECRET_KEY for private document storage.",
        );
      }
      this.client = createClient(supabaseUrl, supabaseKey);
    } else {
      if (supabaseUrl && supabaseKey) {
        try {
          this.client = createClient(supabaseUrl, supabaseKey);
        } catch (err: any) {
          logger.warn("[STORAGE_DRIVER] Could not initialize Supabase client", {
            error: this.redactError(err.message),
          });
        }
      }
    }
  }

  private redactError(msg: string): string {
    if (!msg) return "";
    return msg
      .replace(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, "[REDACTED_JWT]")
      .replace(/sb_[a-zA-Z0-9_-]+/g, "[REDACTED_KEY]")
      .replace(/key=[^&\s]+/gi, "key=[REDACTED]")
      .replace(/secret=[^&\s]+/gi, "secret=[REDACTED]")
      .replace(/sig=[^&\s]+/gi, "sig=[REDACTED]");
  }

  private isTransientError(err: any): boolean {
    if (!err) return false;
    const msg = (err.message || "").toLowerCase();
    const status = err.status || (err as any).statusCode;
    if (status && [500, 502, 503, 504, 429].includes(Number(status))) return true;
    if (
      msg.includes("econnreset") ||
      msg.includes("etimedout") ||
      msg.includes("fetch failed") ||
      msg.includes("timeout") ||
      msg.includes("network error") ||
      msg.includes("connection refused") ||
      msg.includes("enotfound")
    ) {
      return true;
    }
    return false;
  }

  private async withRetry<T>(
    operation: () => Promise<{ data: T | null; error: any }>,
    opName: string,
    maxRetries = 3,
  ): Promise<{ data: T | null; error: any }> {
    let attempt = 0;
    let lastResult: { data: T | null; error: any } = { data: null, error: null };

    while (attempt < maxRetries) {
      attempt++;
      try {
        const result = await operation();
        if (!result.error) {
          return result;
        }
        lastResult = result;
        if (!this.isTransientError(result.error) || attempt >= maxRetries) {
          return result;
        }
      } catch (thrown: any) {
        lastResult = { data: null, error: thrown };
        if (!this.isTransientError(thrown) || attempt >= maxRetries) {
          throw thrown;
        }
      }

      const backoffMs = Math.min(50 * Math.pow(2, attempt - 1), 500);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }

    return lastResult;
  }

  public async verifyConnectivity(): Promise<{ healthy: boolean; details?: any }> {
    if (!this.client) {
      return { healthy: false, details: "Supabase client uninitialized" };
    }
    try {
      const { data, error } = await this.client.storage.getBucket(this.bucketName);
      if (error) {
        return { healthy: false, details: this.redactError(error.message) };
      }
      if (data && data.public === true) {
        throw new Error(
          `[SECURITY ERROR] Storage bucket '${this.bucketName}' is configured as public! Private worker documents require a private bucket.`,
        );
      }
      return { healthy: true, details: { bucket: this.bucketName, public: false } };
    } catch (err: any) {
      return { healthy: false, details: this.redactError(err.message) };
    }
  }

  public async putObject(key: string, data: Buffer, contentType: string): Promise<void> {
    metricsService.recordStorageUploadAttempt("supabase");
    const startTime = process.hrtime.bigint();

    if (!this.client) {
      metricsService.recordStorageUploadFailure("supabase", "client_uninitialized");
      throw new Error(
        "[STORAGE_ERROR] Supabase storage client uninitialized. Check SUPABASE_URL and SUPABASE_SECRET_KEY.",
      );
    }

    const { error } = await this.withRetry(
      () =>
        this.client!.storage
          .from(this.bucketName)
          .upload(key, data, { contentType, upsert: true }),
      "putObject",
    );

    const elapsedSeconds = Number(process.hrtime.bigint() - startTime) / 1e9;

    if (error) {
      const reason = error.statusCode === "404" ? "bucket_not_found" : "provider_error";
      metricsService.recordStorageUploadFailure("supabase", reason);
      logger.error("[STORAGE_DRIVER] Supabase upload failed", {
        key,
        error: this.redactError(error.message),
      });
      throw new Error(`[STORAGE_ERROR] Supabase upload failed: ${this.redactError(error.message)}`);
    }

    metricsService.recordStorageUploadSuccess("supabase");
    metricsService.recordStorageLatency("supabase", "upload", elapsedSeconds);
  }

  public async getObject(key: string): Promise<{ data: Buffer; contentType: string } | null> {
    metricsService.recordStorageDownloadAttempt("supabase");
    const startTime = process.hrtime.bigint();

    if (!this.client) {
      metricsService.recordStorageDownloadFailure("supabase", "client_uninitialized");
      throw new Error(
        "[STORAGE_ERROR] Supabase storage client uninitialized. Check SUPABASE_URL and SUPABASE_SECRET_KEY.",
      );
    }

    const { data, error } = await this.withRetry(
      () => this.client!.storage.from(this.bucketName).download(key),
      "getObject",
    );

    const elapsedSeconds = Number(process.hrtime.bigint() - startTime) / 1e9;

    if (error) {
      const isNotFound =
        error.message?.includes("not found") ||
        error.statusCode === "404" ||
        (error as any).status === 404;

      if (isNotFound) {
        return null;
      }

      metricsService.recordStorageDownloadFailure("supabase", "provider_error");
      logger.error("[STORAGE_DRIVER] Supabase download failed", {
        key,
        error: this.redactError(error.message),
      });
      throw new Error(`[STORAGE_ERROR] Supabase download failed: ${this.redactError(error.message)}`);
    }

    if (data) {
      metricsService.recordStorageDownloadSuccess("supabase");
      metricsService.recordStorageLatency("supabase", "download", elapsedSeconds);
      const buffer = Buffer.from(await data.arrayBuffer());
      return { data: buffer, contentType: data.type || "application/octet-stream" };
    }

    return null;
  }

  public async deleteObject(key: string): Promise<void> {
    metricsService.recordStorageDeleteAttempt("supabase");
    const startTime = process.hrtime.bigint();

    if (!this.client) {
      metricsService.recordStorageDeleteFailure("supabase", "client_uninitialized");
      throw new Error(
        "[STORAGE_ERROR] Supabase storage client uninitialized. Check SUPABASE_URL and SUPABASE_SECRET_KEY.",
      );
    }

    const { error } = await this.withRetry(
      () => this.client!.storage.from(this.bucketName).remove([key]),
      "deleteObject",
    );

    const elapsedSeconds = Number(process.hrtime.bigint() - startTime) / 1e9;

    if (error) {
      metricsService.recordStorageDeleteFailure("supabase", "provider_error");
      logger.error("[STORAGE_DRIVER] Supabase delete failed", {
        key,
        error: this.redactError(error.message),
      });
      throw new Error(`[STORAGE_ERROR] Supabase delete failed: ${this.redactError(error.message)}`);
    }

    metricsService.recordStorageDeleteSuccess("supabase");
    metricsService.recordStorageLatency("supabase", "delete", elapsedSeconds);
  }

  public async objectExists(key: string): Promise<boolean> {
    if (!this.client) return false;

    const folder = key.includes("/") ? key.substring(0, key.lastIndexOf("/")) : "";
    const filename = key.includes("/") ? key.substring(key.lastIndexOf("/") + 1) : key;

    const { data, error } = await this.withRetry(
      () =>
        this.client!.storage.from(this.bucketName).list(folder, {
          search: filename,
        }),
      "objectExists",
    );

    if (error) {
      logger.error("[STORAGE_DRIVER] Supabase objectExists check failed", {
        key,
        error: this.redactError(error.message),
      });
      throw new Error(`[STORAGE_ERROR] Supabase existence check failed: ${this.redactError(error.message)}`);
    }

    if (Array.isArray(data)) {
      return data.some((item) => item.name === filename);
    }

    return false;
  }

  public async getMetadata(key: string): Promise<StorageObjectMetadata | null> {
    if (!this.client) return null;

    const folder = key.includes("/") ? key.substring(0, key.lastIndexOf("/")) : "";
    const filename = key.includes("/") ? key.substring(key.lastIndexOf("/") + 1) : key;

    const { data, error } = await this.withRetry(
      () =>
        this.client!.storage.from(this.bucketName).list(folder, {
          search: filename,
        }),
      "getMetadata",
    );

    if (error || !Array.isArray(data)) return null;

    const match = data.find((item) => item.name === filename);
    if (!match) return null;

    return {
      key,
      size: (match as any).metadata?.size || (match as any).metadata?.contentLength || 0,
      contentType: (match as any).metadata?.mimetype || "application/octet-stream",
      updatedAt: new Date(match.updated_at || match.created_at || Date.now()),
    };
  }
}
