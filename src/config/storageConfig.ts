import dotenv from "dotenv";

dotenv.config();

export interface StorageConfig {
  bucketName: string;
  signedUrlTtlSeconds: number;
  signingSecret: string;
  maxSizeBytes: number;
  allowedMimeTypes: string[];
  isTestMode: boolean;
}

const KNOWN_INSECURE_SECRETS = [
  "test",
  "secret",
  "password",
  "changeme",
  "storage_secret",
  "signing_secret",
  "your_storage_secret",
];

export function validateStorageSecret(
  value: string | undefined,
  varName: string,
  minLength = 16,
): string {
  if (value === undefined || value === null || typeof value !== "string") {
    if (process.env.NODE_ENV === "test") {
      return "test_storage_secret_key_1234567890_super_secure";
    }
    throw new Error(
      `[SECURITY ERROR] Required storage environment variable '${varName}' is missing.`,
    );
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new Error(
      `[SECURITY ERROR] Storage environment variable '${varName}' cannot be empty.`,
    );
  }

  if (KNOWN_INSECURE_SECRETS.includes(trimmed.toLowerCase())) {
    if (process.env.NODE_ENV === "test") {
      return "test_storage_secret_key_1234567890_super_secure";
    }
    throw new Error(
      `[SECURITY ERROR] Storage environment variable '${varName}' contains a known insecure placeholder value.`,
    );
  }

  if (trimmed.length < minLength) {
    if (process.env.NODE_ENV === "test") {
      return "test_storage_secret_key_1234567890_super_secure";
    }
    throw new Error(
      `[SECURITY ERROR] Storage environment variable '${varName}' is too short (min ${minLength} characters).`,
    );
  }

  return trimmed;
}

export function assertProductionStorageConfig(): void {
  const nodeEnv = process.env.NODE_ENV || "development";
  
  if (nodeEnv !== "production") {
    return;
  }

  // Enforce production storage gatekeepers
  validateStorageSecret(process.env.STORAGE_SIGNING_SECRET, "STORAGE_SIGNING_SECRET");

  const provider = process.env.STORAGE_PROVIDER;
  if (!provider || provider === "local" || provider === "mock") {
    throw new Error(
      `[SECURITY ERROR] STORAGE_PROVIDER must be configured to a private object storage provider (e.g. 'supabase') in production. Found: '${provider || "undefined"}'.`,
    );
  }

  if (provider === "supabase") {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_URL.startsWith("https://")) {
      throw new Error(
        `[SECURITY ERROR] Required Supabase storage environment variable 'SUPABASE_URL' is missing or invalid in production.`,
      );
    }
    const secretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!secretKey || secretKey.trim().length < 20) {
      throw new Error(
        `[SECURITY ERROR] Required Supabase storage environment variable 'SUPABASE_SECRET_KEY' (service role key) is missing or too short in production.`,
      );
    }
  }

  if (!process.env.STORAGE_BUCKET_NAME || process.env.STORAGE_BUCKET_NAME.trim().length === 0) {
    throw new Error(
      `[SECURITY ERROR] Required storage environment variable 'STORAGE_BUCKET_NAME' cannot be empty in production.`,
    );
  }
}

export const storageConfig: StorageConfig = {
  bucketName: process.env.STORAGE_BUCKET_NAME || "labourbaba-private-documents",
  signedUrlTtlSeconds: parseInt(process.env.DOCUMENT_SIGNED_URL_TTL_SECONDS || "900", 10),
  signingSecret: validateStorageSecret(
    process.env.STORAGE_SIGNING_SECRET,
    "STORAGE_SIGNING_SECRET",
  ),
  maxSizeBytes: parseInt(process.env.MAX_DOCUMENT_SIZE_BYTES || String(5 * 1024 * 1024), 10),
  allowedMimeTypes: ["application/pdf", "image/jpeg", "image/png"],
  isTestMode: process.env.NODE_ENV === "test",
};
