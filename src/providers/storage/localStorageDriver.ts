import fs from "fs";
import path from "path";
import { StorageDriver, StorageObjectMetadata } from "./storage.types";
import { logger } from "../../utils/logger";

export class LocalStorageDriver implements StorageDriver {
  private readonly rootDir: string;

  constructor(customRootDir?: string) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "[SECURITY ERROR] LocalStorageDriver is strictly prohibited in production. " +
          "Identity documents require durable private object storage (e.g. Supabase S3).",
      );
    }
    this.rootDir = path.resolve(
      process.cwd(),
      customRootDir || process.env.STORAGE_LOCAL_DIR || "data/storage/private_documents"
    );
    this.ensureRootDir();
  }

  private ensureRootDir(): void {
    try {
      if (!fs.existsSync(this.rootDir)) {
        fs.mkdirSync(this.rootDir, { recursive: true });
      }
    } catch (err: any) {
      logger.error("[STORAGE_DRIVER] Failed to initialize storage directory", { error: err.message });
    }
  }

  /**
   * Resolves and verifies that the sanitized file path strictly resides within the root storage directory.
   */
  private resolveSafePath(key: string): string {
    if (!key || typeof key !== "string") {
      throw new Error("Invalid storage object key");
    }

    // Strip null bytes and normalize slashes
    const sanitizedKey = key.replace(/\0/g, "").replace(/\\/g, "/");
    
    // Normalize path components to prevent directory traversal
    const safeRelativePath = path.normalize(sanitizedKey).replace(/^(\.\.[\/\\])+/, "");
    const resolvedPath = path.resolve(this.rootDir, safeRelativePath);

    // Verify resolved path strictly starts with rootDir
    if (!resolvedPath.startsWith(this.rootDir)) {
      throw new Error("Directory traversal attempt detected in storage key");
    }

    return resolvedPath;
  }

  private getMetadataPath(resolvedFilePath: string): string {
    return `${resolvedFilePath}.meta.json`;
  }

  public async putObject(key: string, data: Buffer, contentType: string): Promise<void> {
    const filePath = this.resolveSafePath(key);
    const dir = path.dirname(filePath);

    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(filePath, data);

    const meta: StorageObjectMetadata = {
      key,
      size: data.length,
      contentType: contentType || "application/octet-stream",
      updatedAt: new Date(),
    };

    const metaPath = this.getMetadataPath(filePath);
    await fs.promises.writeFile(metaPath, JSON.stringify(meta), "utf8");
  }

  public async getObject(key: string): Promise<{ data: Buffer; contentType: string } | null> {
    try {
      const filePath = this.resolveSafePath(key);
      const exists = await this.objectExists(key);
      if (!exists) return null;

      const data = await fs.promises.readFile(filePath);
      let contentType = "application/octet-stream";

      const metaPath = this.getMetadataPath(filePath);
      try {
        const metaRaw = await fs.promises.readFile(metaPath, "utf8");
        const meta = JSON.parse(metaRaw);
        if (meta.contentType) contentType = meta.contentType;
      } catch {
        // Fallback MIME type deduction based on extension
        const ext = path.extname(filePath).toLowerCase();
        if (ext === ".pdf") contentType = "application/pdf";
        else if (ext === ".jpg" || ext === ".jpeg") contentType = "image/jpeg";
        else if (ext === ".png") contentType = "image/png";
      }

      return { data, contentType };
    } catch {
      return null;
    }
  }

  public async deleteObject(key: string): Promise<void> {
    try {
      const filePath = this.resolveSafePath(key);
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
      }
      const metaPath = this.getMetadataPath(filePath);
      if (fs.existsSync(metaPath)) {
        await fs.promises.unlink(metaPath);
      }
    } catch (err: any) {
      logger.warn("[STORAGE_DRIVER] Failed to delete object", { key, error: err.message });
    }
  }

  public async objectExists(key: string): Promise<boolean> {
    try {
      const filePath = this.resolveSafePath(key);
      const stat = await fs.promises.stat(filePath);
      return stat.isFile();
    } catch {
      return false;
    }
  }

  public async getMetadata(key: string): Promise<StorageObjectMetadata | null> {
    try {
      const filePath = this.resolveSafePath(key);
      const exists = await this.objectExists(key);
      if (!exists) return null;

      const metaPath = this.getMetadataPath(filePath);
      if (fs.existsSync(metaPath)) {
        const metaRaw = await fs.promises.readFile(metaPath, "utf8");
        const meta = JSON.parse(metaRaw);
        return {
          key: meta.key || key,
          size: meta.size,
          contentType: meta.contentType,
          updatedAt: new Date(meta.updatedAt),
        };
      }

      const stat = await fs.promises.stat(filePath);
      return {
        key,
        size: stat.size,
        contentType: "application/octet-stream",
        updatedAt: stat.mtime,
      };
    } catch {
      return null;
    }
  }
}
