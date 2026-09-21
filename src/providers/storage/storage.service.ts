import crypto from "crypto";
import { storageConfig } from "../../config/storageConfig";
import {
  SignedUrlResult,
  SignedUploadUrlResult,
  StorageDriver,
  StorageProvider,
} from "./storage.types";
import { LocalStorageDriver } from "./localStorageDriver";
import { SupabaseStorageDriver } from "./supabaseStorageDriver";

export class StorageService implements StorageProvider {
  private readonly bucketName: string;
  private readonly defaultTtl: number;
  private readonly signingSecret: string;
  private readonly storageBaseUrl: string;
  private readonly driver: StorageDriver;

  constructor(customDriver?: StorageDriver) {
    this.bucketName = storageConfig.bucketName;
    this.defaultTtl = storageConfig.signedUrlTtlSeconds;
    this.signingSecret = storageConfig.signingSecret;
    this.storageBaseUrl = process.env.STORAGE_BASE_URL || "https://storage.labourbaba.com";

    if (customDriver) {
      this.driver = customDriver;
    } else if (process.env.STORAGE_PROVIDER === "supabase") {
      this.driver = new SupabaseStorageDriver(this.bucketName);
    } else if (process.env.NODE_ENV === "production") {
      throw new Error(
        "[STORAGE_FATAL] STORAGE_PROVIDER must be configured to a private cloud provider (e.g. 'supabase') in production. LocalStorageDriver is forbidden in production.",
      );
    } else {
      this.driver = new LocalStorageDriver();
    }
  }

  /**
   * Generates a safe, opaque object key for a worker document.
   * Format: workers/{workerId}/documents/{uuid}.{ext}
   * Never includes Aadhaar, PAN, phone number, or other PII.
   */
  public generateDocumentKey(workerId: string, ext = "pdf"): string {
    const cleanExt = ext.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "pdf";
    const documentId = crypto.randomUUID();
    return `workers/${workerId}/documents/${documentId}.${cleanExt}`;
  }

  /**
   * Verifies if a given object key belongs to the specified worker.
   */
  public isWorkerDocumentKey(workerId: string, key: string): boolean {
    if (!workerId || !key) return false;
    const normalizedKey = this.normalizeObjectKey(key);
    return normalizedKey.startsWith(`workers/${workerId}/documents/`);
  }

  /**
   * Normalizes a file URL or key into an object key.
   */
  public normalizeObjectKey(urlOrKey: string): string {
    if (!urlOrKey) return "";
    try {
      if (urlOrKey.startsWith("http://") || urlOrKey.startsWith("https://")) {
        const parsed = new URL(urlOrKey);
        let pathname = parsed.pathname.replace(/^\/+/, "");
        if (pathname.startsWith("download/")) {
          pathname = pathname.substring("download/".length);
        } else if (pathname.startsWith("upload/")) {
          pathname = pathname.substring("upload/".length);
        } else if (pathname.startsWith("api/storage/download/")) {
          pathname = pathname.substring("api/storage/download/".length);
        } else if (pathname.startsWith("api/storage/upload/")) {
          pathname = pathname.substring("api/storage/upload/".length);
        }
        return decodeURIComponent(pathname);
      }
    } catch {
      // Not a valid URL, treat as raw key
    }
    return urlOrKey.replace(/^\/+/, "");
  }

  /**
   * Generates a short-lived HMAC-SHA256 signed download URL.
   * Authorization must have already succeeded before calling this.
   */
  public async getSignedDownloadUrl(
    key: string,
    expiresInSeconds?: number,
  ): Promise<SignedUrlResult> {
    const normalizedKey = this.normalizeObjectKey(key);
    const ttl = Math.min(expiresInSeconds || this.defaultTtl, this.defaultTtl);
    const exp = Math.floor(Date.now() / 1000) + ttl;
    const expiresAt = new Date(exp * 1000).toISOString();

    const signature = crypto
      .createHmac("sha256", this.signingSecret)
      .update(`GET:${this.bucketName}:${normalizedKey}:${exp}`)
      .digest("hex");

    const url = `${this.storageBaseUrl}/download/${encodeURIComponent(normalizedKey)}?exp=${exp}&sig=${signature}`;

    return {
      url,
      expiresIn: ttl,
      expiresAt,
    };
  }

  /**
   * Generates a short-lived presigned upload URL scoped to a specific object key.
   */
  public async getSignedUploadUrl(
    key: string,
    contentType: string,
    expiresInSeconds?: number,
  ): Promise<SignedUploadUrlResult> {
    const normalizedKey = this.normalizeObjectKey(key);
    const ttl = Math.min(expiresInSeconds || this.defaultTtl, this.defaultTtl);
    const exp = Math.floor(Date.now() / 1000) + ttl;
    const expiresAt = new Date(exp * 1000).toISOString();

    const signature = crypto
      .createHmac("sha256", this.signingSecret)
      .update(`PUT:${this.bucketName}:${normalizedKey}:${contentType}:${exp}`)
      .digest("hex");

    const uploadUrl = `${this.storageBaseUrl}/upload/${encodeURIComponent(normalizedKey)}?exp=${exp}&sig=${signature}`;

    return {
      uploadUrl,
      objectKey: normalizedKey,
      expiresIn: ttl,
      expiresAt,
    };
  }

  /**
   * Verifies the authenticity and expiration of a signed download/upload URL.
   */
  public verifySignedUrl(
    key: string,
    exp: number | string,
    signature: string,
    method: "GET" | "PUT" = "GET",
    contentType?: string,
  ): boolean {
    if (!key || !exp || !signature) return false;

    const expNum = typeof exp === "string" ? parseInt(exp, 10) : exp;
    if (isNaN(expNum) || expNum <= Math.floor(Date.now() / 1000)) {
      return false; // Expired
    }

    const normalizedKey = this.normalizeObjectKey(key);
    const payload =
      method === "PUT" && contentType
        ? `PUT:${this.bucketName}:${normalizedKey}:${contentType}:${expNum}`
        : `${method}:${this.bucketName}:${normalizedKey}:${expNum}`;

    const expectedSignature = crypto
      .createHmac("sha256", this.signingSecret)
      .update(payload)
      .digest("hex");

    try {
      const expectedBuf = Buffer.from(expectedSignature, "hex");
      const receivedBuf = Buffer.from(signature, "hex");

      if (expectedBuf.length !== receivedBuf.length || expectedBuf.length === 0) {
        return false;
      }

      return crypto.timingSafeEqual(expectedBuf, receivedBuf);
    } catch {
      return false;
    }
  }

  public async putObject(key: string, data: Buffer, contentType: string): Promise<void> {
    const normalizedKey = this.normalizeObjectKey(key);
    await this.driver.putObject(normalizedKey, data, contentType);
  }

  public async getObject(key: string): Promise<{ data: Buffer; contentType: string } | null> {
    const normalizedKey = this.normalizeObjectKey(key);
    return await this.driver.getObject(normalizedKey);
  }

  public async deleteObject(key: string): Promise<void> {
    const normalizedKey = this.normalizeObjectKey(key);
    await this.driver.deleteObject(normalizedKey);
  }

  public async objectExists(key: string): Promise<boolean> {
    const normalizedKey = this.normalizeObjectKey(key);
    if (!normalizedKey) return false;
    return await this.driver.objectExists(normalizedKey);
  }
}

export const storageService = new StorageService();
