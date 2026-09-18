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

export interface StorageProvider {
  putObject(key: string, data: Buffer, contentType: string): Promise<void>;
  deleteObject(key: string): Promise<void>;
  getSignedDownloadUrl(key: string, expiresInSeconds?: number): Promise<SignedUrlResult>;
  getSignedUploadUrl(
    key: string,
    contentType: string,
    expiresInSeconds?: number,
  ): Promise<SignedUploadUrlResult>;
  objectExists(key: string): Promise<boolean>;
}
