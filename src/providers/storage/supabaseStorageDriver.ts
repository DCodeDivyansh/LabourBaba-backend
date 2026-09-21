import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { StorageDriver, StorageObjectMetadata } from "./storage.types";
import { LocalStorageDriver } from "./localStorageDriver";
import { logger } from "../../utils/logger";

export class SupabaseStorageDriver implements StorageDriver {
  private readonly client: SupabaseClient | null = null;
  private readonly bucketName: string;
  private readonly fallbackDriver: LocalStorageDriver | null = null;
  private readonly isProduction: boolean;

  constructor(bucketName: string) {
    this.bucketName = bucketName;
    this.isProduction = process.env.NODE_ENV === "production";

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;

    if (this.isProduction) {
      if (!supabaseUrl || !supabaseKey) {
        throw new Error(
          "[STORAGE_FATAL] Production requires valid SUPABASE_URL and SUPABASE_SECRET_KEY for private document storage.",
        );
      }
      this.client = createClient(supabaseUrl, supabaseKey);
      this.fallbackDriver = null; // No fallback in production
    } else {
      // In dev / test mode: initialize fallback if Supabase not configured
      this.fallbackDriver = new LocalStorageDriver();
      if (supabaseUrl && supabaseKey) {
        try {
          this.client = createClient(supabaseUrl, supabaseKey);
        } catch (err: any) {
          logger.warn("[STORAGE_DRIVER] Could not initialize Supabase client, using local durable driver for development/test", {
            error: err.message,
          });
        }
      }
    }
  }

  public async putObject(key: string, data: Buffer, contentType: string): Promise<void> {
    if (this.client) {
      const { error } = await this.client.storage
        .from(this.bucketName)
        .upload(key, data, { contentType, upsert: true });

      if (error) {
        logger.error("[STORAGE_DRIVER] Supabase upload failed", {
          key,
          error: error.message,
        });
        if (this.isProduction || !this.fallbackDriver) {
          throw new Error(`[STORAGE_ERROR] Supabase upload failed: ${error.message}`);
        }
        await this.fallbackDriver.putObject(key, data, contentType);
        return;
      }
      return;
    }

    if (this.fallbackDriver) {
      await this.fallbackDriver.putObject(key, data, contentType);
      return;
    }

    throw new Error("[STORAGE_ERROR] Storage client uninitialized in production");
  }

  public async getObject(key: string): Promise<{ data: Buffer; contentType: string } | null> {
    if (this.client) {
      const { data, error } = await this.client.storage.from(this.bucketName).download(key);
      if (error) {
        if (error.message && (error.message.includes("not found") || error.message.includes("404"))) {
          if (this.fallbackDriver) {
            return await this.fallbackDriver.getObject(key);
          }
          return null;
        }
        if (this.isProduction || !this.fallbackDriver) {
          logger.error("[STORAGE_DRIVER] Supabase download failed", { key, error: error.message });
          throw new Error(`[STORAGE_ERROR] Supabase download failed: ${error.message}`);
        }
        return await this.fallbackDriver.getObject(key);
      } else if (data) {
        const buffer = Buffer.from(await data.arrayBuffer());
        return { data: buffer, contentType: data.type || "application/octet-stream" };
      }
    }

    if (this.fallbackDriver) {
      return await this.fallbackDriver.getObject(key);
    }

    return null;
  }

  public async deleteObject(key: string): Promise<void> {
    if (this.client) {
      const { error } = await this.client.storage.from(this.bucketName).remove([key]);
      if (error) {
        logger.error("[STORAGE_DRIVER] Supabase delete failed", { key, error: error.message });
        if (this.isProduction || !this.fallbackDriver) {
          throw new Error(`[STORAGE_ERROR] Supabase delete failed: ${error.message}`);
        }
        await this.fallbackDriver.deleteObject(key);
        return;
      }
      return;
    }

    if (this.fallbackDriver) {
      await this.fallbackDriver.deleteObject(key);
    }
  }

  public async objectExists(key: string): Promise<boolean> {
    if (this.client) {
      const folder = key.includes("/") ? key.substring(0, key.lastIndexOf("/")) : "";
      const filename = key.includes("/") ? key.substring(key.lastIndexOf("/") + 1) : key;
      const { data, error } = await this.client.storage.from(this.bucketName).list(folder, {
        search: filename,
      });
      if (error) {
        if (this.isProduction || !this.fallbackDriver) {
          logger.error("[STORAGE_DRIVER] Supabase objectExists check failed", { key, error: error.message });
          throw new Error(`[STORAGE_ERROR] Supabase existence check failed: ${error.message}`);
        }
        return await this.fallbackDriver.objectExists(key);
      } else if (Array.isArray(data)) {
        return data.some((item) => item.name === filename);
      }
      return false;
    }

    if (this.fallbackDriver) {
      return await this.fallbackDriver.objectExists(key);
    }

    return false;
  }

  public async getMetadata(key: string): Promise<StorageObjectMetadata | null> {
    if (this.fallbackDriver) {
      return await this.fallbackDriver.getMetadata(key);
    }
    const exists = await this.objectExists(key);
    if (!exists) return null;
    return {
      key,
      size: 0,
      contentType: "application/octet-stream",
      updatedAt: new Date(),
    };
  }
}
