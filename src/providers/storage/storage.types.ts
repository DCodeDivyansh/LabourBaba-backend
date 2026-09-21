export interface SignedUrlResult {
  url: string;
  expiresIn: number;
  expiresAt: string;
}

export interface SignedUploadUrlResult {
  uploadUrl: string;
  objectKey: string;
  expiresIn: number;
  expiresAt: string;
}

export interface StorageObjectMetadata {
  key: string;
  size: number;
  contentType: string;
  updatedAt: Date;
}

export interface StorageDriver {
  putObject(key: string, data: Buffer, contentType: string): Promise<void>;
  getObject(key: string): Promise<{ data: Buffer; contentType: string } | null>;
  deleteObject(key: string): Promise<void>;
  objectExists(key: string): Promise<boolean>;
  getMetadata(key: string): Promise<StorageObjectMetadata | null>;
}

export interface StorageProvider {
  putObject(key: string, data: Buffer, contentType: string): Promise<void>;
  getObject(key: string): Promise<{ data: Buffer; contentType: string } | null>;
  deleteObject(key: string): Promise<void>;
  objectExists(key: string): Promise<boolean>;
  getSignedDownloadUrl(key: string, expiresInSeconds?: number): Promise<SignedUrlResult>;
  getSignedUploadUrl(
    key: string,
    contentType: string,
    expiresInSeconds?: number,
  ): Promise<SignedUploadUrlResult>;
  verifySignedUrl(
    key: string,
    exp: number | string,
    signature: string,
    method?: "GET" | "PUT",
    contentType?: string,
  ): boolean;
  normalizeObjectKey(urlOrKey: string): string;
  generateDocumentKey(workerId: string, ext?: string): string;
  isWorkerDocumentKey(workerId: string, key: string): boolean;
}
