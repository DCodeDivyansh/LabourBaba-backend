import crypto from "crypto";
import { storageConfig } from "../../config/storageConfig";
import { SignedUrlResult, SignedUploadUrlResult, StorageProvider } from "./storage.types";

export class StorageService implements StorageProvider {
  private readonly bucketName: string;
  private readonly defaultTtl: number;
  private readonly signingSecret: string;
  private readonly storageBaseUrl: string;

  constructor() {
    this.bucketName = storageConfig.bucketName;
    this.defaultTtl = storageConfig.signedUrlTtlSeconds;
    this.signingSecret = storageConfig.signingSecret;
    this.storageBaseUrl = process.env.STORAGE_BASE_URL || "https://storage.labourbaba.com";
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
        // Remove leading /download/ or /upload/ if present
        let pathname = parsed.pathname.replace(/^\/+/, "");
        if (pathname.startsWith("download/")) {
          pathname = pathname.substring("download/".length);
        } else if (pathname.startsWith("upload/")) {
          pathname = pathname.substring("upload/".length);
        }
        return pathname;
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

  public async putObject(_key: string, _data: Buffer, _contentType: string): Promise<void> {
    // In-memory / mock implementation for storage backend
  }

  public async deleteObject(_key: string): Promise<void> {
    // In-memory / mock implementation for storage backend
  }

  public async objectExists(_key: string): Promise<boolean> {
    return true;
  }
}

export const storageService = new StorageService();
