import { initializeApp, getApps, cert, deleteApp, App } from "firebase-admin/app";
import { getMessaging, Message } from "firebase-admin/messaging";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import crypto from "crypto";
import { logger } from "../utils/logger";
import { metricsService } from "../metrics/metrics.service";

let isFirebaseInitialized = false;
let app: App | undefined;

/**
 * Safely computes a deterministic, privacy-preserving fingerprint (10 hex characters)
 * of an FCM registration token for structured logs and telemetry.
 * Strictly prevents raw secret registration token exposure.
 */
export function fingerprintToken(token: string): string {
  if (!token || typeof token !== "string") return "empty_token";
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 10);
}

export interface FCMPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

export type FCMErrorCategory =
  | "INVALID_REGISTRATION_TOKEN"
  | "UNREGISTERED_DEVICE"
  | "INVALID_ARGUMENT"
  | "AUTHENTICATION_ERROR"
  | "SERVER_UNAVAILABLE"
  | "INTERNAL_ERROR"
  | "TRANSIENT_FAILURE"
  | "RATE_LIMITED"
  | "UNKNOWN";

export interface ClassifiedFCMError {
  category: FCMErrorCategory;
  isInvalidToken: boolean;
  isPermanent: boolean;
  shouldRetry: boolean;
  message: string;
}

export interface FCMDeliveryResult {
  token: string;
  tokenFingerprint?: string;
  success: boolean;
  messageId?: string;
  error?: any;
  isInvalidToken?: boolean;
  errorCategory?: FCMErrorCategory;
  latencyMs?: number;
}

export interface IFCMProvider {
  sendToTokens(
    tokens: string[],
    payload: FCMPayload,
    onInvalidToken?: (token: string) => Promise<void> | void,
  ): Promise<FCMDeliveryResult[]>;
}

let mockFcmProvider: IFCMProvider | null = null;

/**
 * Registers an explicit mock FCM provider for test environments only.
 * Strictly prohibited in production.
 */
export function setMockFcmProvider(provider: IFCMProvider | null): void {
  if (process.env.NODE_ENV === "production" && provider !== null) {
    throw new Error("[SECURITY_VIOLATION] Mock FCM provider cannot be registered in production environment.");
  }
  mockFcmProvider = provider;
}

/**
 * Resets Firebase Admin SDK and test mocks cleanly.
 */
export function resetFirebaseApp(): void {
  app = undefined;
  isFirebaseInitialized = false;
  mockFcmProvider = null;
  try {
    const existingApps = getApps();
    for (const a of existingApps) {
      deleteApp(a).catch(() => {});
    }
  } catch {}
}

/**
 * Resolves Firebase service account credentials from multiple standard configuration approaches:
 * 1. FIREBASE_SERVICE_ACCOUNT_PATH or local JSON files (e.g. root service account)
 * 2. FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_KEY (raw JSON or base64 JSON)
 * 3. Separated credentials: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
 * 4. GOOGLE_APPLICATION_CREDENTIALS (Application Default Credentials)
 */
function resolveFirebaseCredentials(): { type: "service_account"; creds: any } | { type: "adc" } | null {
  // 1. Check custom path or standard root service account files
  const candidatePaths = [
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
    resolve(process.cwd(), "labourbaba-58a41-firebase-adminsdk-fbsvc-e72264934a.json"),
    resolve(process.cwd(), "firebase-service-account.json"),
  ].filter(Boolean) as string[];

  for (const candidate of candidatePaths) {
    if (existsSync(candidate)) {
      try {
        const fileContent = readFileSync(candidate, "utf-8");
        const parsed = JSON.parse(fileContent);
        logger.info(`[FCM] Found Firebase Service Account file.`);
        return { type: "service_account", creds: parsed };
      } catch (err: any) {
        logger.error("[FCM] Failed to parse local service account JSON file:", { error: err.message });
        if (process.env.NODE_ENV === "production") {
          throw new Error(`[FCM_CONFIG_ERROR] Failed to parse local service account JSON file: ${err.message}`);
        }
      }
    }
  }

  // 2. Check JSON string in environment (raw or base64)
  const rawJsonVar = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (rawJsonVar && rawJsonVar.trim().length > 0) {
    try {
      let jsonString = rawJsonVar.trim();
      // Handle base64 encoded JSON
      if (!jsonString.startsWith("{") && !jsonString.startsWith("[")) {
        try {
          const decoded = Buffer.from(jsonString, "base64").toString("utf-8");
          if (decoded.startsWith("{")) {
            jsonString = decoded;
          }
        } catch {}
      }
      const parsed = JSON.parse(jsonString);
      return { type: "service_account", creds: parsed };
    } catch (err: any) {
      logger.error("[FCM] Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON env variable:", { error: err.message });
      if (process.env.NODE_ENV === "production") {
        throw new Error(`[FCM_CONFIG_ERROR] Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON env variable: ${err.message}`);
      }
    }
  }

  // 3. Check securely separated credentials
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (projectId && clientEmail && privateKey) {
    // Correctly normalize literal "\n" escapes from CI/CD secrets
    const normalizedKey = privateKey.replace(/\\n/g, "\n");
    return {
      type: "service_account",
      creds: {
        projectId,
        clientEmail,
        privateKey: normalizedKey,
      },
    };
  }

  // 4. Check Google Application Default Credentials
  if (
    process.env.GOOGLE_APPLICATION_CREDENTIALS &&
    process.env.GOOGLE_APPLICATION_CREDENTIALS !== "undefined" &&
    process.env.GOOGLE_APPLICATION_CREDENTIALS.trim().length > 0
  ) {
    return { type: "adc" };
  }

  return null;
}

export function getFirebaseApp(): App | undefined {
  if (app) return app;

  if (getApps().length > 0) {
    isFirebaseInitialized = true;
    app = getApps()[0];
    return app;
  }

  const resolved = resolveFirebaseCredentials();

  if (resolved?.type === "service_account") {
    try {
      app = initializeApp({
        credential: cert(resolved.creds),
      });
      isFirebaseInitialized = true;
      logger.info("[FCM] Firebase Admin SDK initialized successfully via Service Account.");
    } catch (error: any) {
      logger.error("[FCM] Failed to initialize Firebase Admin SDK with Service Account:", { error: error.message });
      if (process.env.NODE_ENV === "production") {
        throw new Error(`[FCM_INIT_ERROR] Failed to initialize Firebase Admin SDK: ${error.message}`);
      }
    }
  } else if (resolved?.type === "adc") {
    try {
      app = initializeApp();
      isFirebaseInitialized = true;
      logger.info("[FCM] Firebase Admin SDK initialized via Application Default Credentials.");
    } catch (error: any) {
      logger.error("[FCM] Failed to initialize Firebase Admin SDK via ADC:", { error: error.message });
      if (process.env.NODE_ENV === "production") {
        throw new Error(`[FCM_INIT_ERROR] Failed to initialize Firebase Admin SDK via ADC: ${error.message}`);
      }
    }
  } else {
    logger.info("[FCM] Firebase Admin SDK uninitialized (no credentials configured).");
  }

  return app;
}

// Initialize on module load
try {
  getFirebaseApp();
} catch (err: any) {
  if (process.env.NODE_ENV === "production") {
    throw err;
  }
}

/**
 * Validates that FCM is configured and successfully initializable in production.
 */
export function assertFcmConfig(): void {
  if (process.env.NODE_ENV === "test") {
    return;
  }

  const isProduction = process.env.NODE_ENV === "production";
  if (!isProduction) {
    return;
  }

  const resolved = resolveFirebaseCredentials();
  if (!resolved) {
    throw new Error(
      "[FCM_CONFIG_ERROR] Production requires valid Firebase Admin SDK credentials (FIREBASE_SERVICE_ACCOUNT_JSON, service account JSON file, or GOOGLE_APPLICATION_CREDENTIALS)."
    );
  }

  // Authoritatively verify that the credentials can initialize the messaging client
  const firebaseApp = getFirebaseApp();
  if (!firebaseApp || !isFirebaseInitialized) {
    throw new Error(
      "[FCM_CONFIG_ERROR] Production Firebase Admin SDK initialization failed. Cannot operate in uninitialized or stub mode in production."
    );
  }
}

/**
 * Classifies an FCM error into structured operational categories.
 * Distinguishes invalid tokens (permanent) vs rate limiting / network outages (transient).
 */
export function classifyFCMError(error: any): ClassifiedFCMError {
  if (!error) {
    return {
      category: "UNKNOWN",
      isInvalidToken: false,
      isPermanent: false,
      shouldRetry: false,
      message: "Unknown error",
    };
  }

  const code = String(error.code || error.errorInfo?.code || "").toLowerCase();
  const message = String(error.message || "").toLowerCase();

  // 1. Unregistered device / dead token
  if (
    code.includes("registration-token-not-registered") ||
    message.includes("registration-token-not-registered") ||
    message.includes("requested entity was not found")
  ) {
    return {
      category: "UNREGISTERED_DEVICE",
      isInvalidToken: true,
      isPermanent: true,
      shouldRetry: false,
      message: error.message || "Registration token is no longer registered",
    };
  }

  // 2. Invalid token format
  if (
    code.includes("invalid-registration-token") ||
    message.includes("invalid-registration-token") ||
    message.includes("not a valid fcm registration token")
  ) {
    return {
      category: "INVALID_REGISTRATION_TOKEN",
      isInvalidToken: true,
      isPermanent: true,
      shouldRetry: false,
      message: error.message || "Invalid FCM registration token format",
    };
  }

  // 3. Invalid argument (malformed payload or token)
  if (code.includes("invalid-argument") || message.includes("invalid-argument")) {
    const isTokenIssue = message.includes("token") || message.includes("recipient");
    return {
      category: "INVALID_ARGUMENT",
      isInvalidToken: isTokenIssue,
      isPermanent: true,
      shouldRetry: false,
      message: error.message || "Invalid argument in FCM request",
    };
  }

  // 4. Rate limiting / Quota exceeded
  if (
    code.includes("quota-exceeded") ||
    code.includes("message-rate-exceeded") ||
    code.includes("device-message-rate-exceeded") ||
    message.includes("rate limit") ||
    message.includes("429")
  ) {
    return {
      category: "RATE_LIMITED",
      isInvalidToken: false,
      isPermanent: false,
      shouldRetry: true,
      message: error.message || "FCM quota or message rate exceeded",
    };
  }

  // 5. Transient network or FCM server error
  if (
    code.includes("server-unavailable") ||
    code.includes("internal-error") ||
    message.includes("etimedout") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("socket hang up") ||
    message.includes("503") ||
    message.includes("500") ||
    message.includes("502") ||
    message.includes("timeout")
  ) {
    return {
      category: "TRANSIENT_FAILURE",
      isInvalidToken: false,
      isPermanent: false,
      shouldRetry: true,
      message: error.message || "Transient network or FCM server error",
    };
  }

  // 6. Authentication or credential mismatch
  if (
    code.includes("authentication-error") ||
    code.includes("mismatched-credential") ||
    message.includes("credential") ||
    message.includes("auth error")
  ) {
    return {
      category: "AUTHENTICATION_ERROR",
      isInvalidToken: false,
      isPermanent: true,
      shouldRetry: false,
      message: error.message || "Firebase Admin authentication or credential mismatch",
    };
  }

  return {
    category: "UNKNOWN",
    isInvalidToken: false,
    isPermanent: false,
    shouldRetry: true,
    message: error.message || "Unknown FCM error",
  };
}

/**
 * Determines if an FCM error indicates that a token is permanently invalid or unregistered.
 * Transient errors (e.g. server timeout, network disconnect) must NOT be treated as invalid tokens.
 */
export function isPermanentInvalidTokenError(error: any): boolean {
  return classifyFCMError(error).isInvalidToken;
}

/**
 * Send an FCM push notification to multiple tokens in parallel.
 * Detects invalid tokens and triggers cleanup callback while allowing valid tokens to succeed.
 *
 * Invariants:
 * 1. Zero Fake Success: Never returns success: true or fake message IDs when Firebase is uninitialized.
 * 2. Explicit Mocking: In tests, mock delivery must use an explicit mock provider.
 * 3. Fail-Loud in Production: Uninitialized FCM in production returns explicit failure results.
 * 4. Token Privacy: Logs strictly use SHA-256 token fingerprints, never raw tokens.
 */
export async function sendFCMToTokens(
  tokens: string[],
  payload: FCMPayload,
  onInvalidToken?: (token: string) => Promise<void> | void,
): Promise<FCMDeliveryResult[]> {
  if (!tokens || tokens.length === 0) return [];

  // 1. Explicit Test Mock Provider check (strictly disallowed in production)
  if (process.env.NODE_ENV === "production") {
    if (mockFcmProvider) {
      mockFcmProvider = null;
      throw new Error("[SECURITY_VIOLATION] Mock FCM provider cannot be active in production environment.");
    }
  } else if (mockFcmProvider) {
    return mockFcmProvider.sendToTokens(tokens, payload, onInvalidToken);
  }

  const currentApp = getFirebaseApp();
  const results: FCMDeliveryResult[] = [];

  await Promise.allSettled(
    tokens.map(async (token) => {
      if (!token) return;
      const fp = fingerprintToken(token);
      const startTime = Date.now();

      try {
        if (isFirebaseInitialized && currentApp) {
          const message: Message = {
            token,
            android: {
              priority: "high",
            },
            data: {
              title: payload.title,
              body: payload.body,
              ...(payload.data ?? {}),
            },
          };

          const messageId = await getMessaging(currentApp).send(message);
          const latencyMs = Date.now() - startTime;

          // Record telemetry
          try {
            metricsService.recordNotificationAttempt("fcm");
            metricsService.recordNotificationSuccess("fcm");
            metricsService.recordFcmSuccess(latencyMs);
          } catch {}

          results.push({
            token,
            tokenFingerprint: fp,
            success: true,
            messageId,
            latencyMs,
          });
        } else {
          // Uninitialized FCM — NEVER return fake success or fake message IDs!
          const latencyMs = Date.now() - startTime;
          const uninitError = new Error("[FCM_UNINITIALIZED] Firebase Admin SDK is not initialized. Notification delivery failed.");

          try {
            metricsService.recordNotificationAttempt("fcm");
            metricsService.recordNotificationFailure("fcm", "permanent");
            metricsService.recordFcmFailure("uninitialized");
          } catch {}

          logger.error("[FCM_DELIVERY_FAILED] Cannot send push notification: Firebase Admin SDK is uninitialized", {
            tokenFingerprint: fp,
            title: payload.title,
          });

          results.push({
            token,
            tokenFingerprint: fp,
            success: false,
            error: uninitError,
            isInvalidToken: false,
            errorCategory: "UNKNOWN",
            latencyMs,
          });
        }
      } catch (err: any) {
        const latencyMs = Date.now() - startTime;
        const classified = classifyFCMError(err);

        try {
          metricsService.recordNotificationAttempt("fcm");
          metricsService.recordNotificationFailure("fcm", classified.shouldRetry ? "transient" : "permanent");
          metricsService.recordFcmFailure(classified.category);
          if (classified.isInvalidToken) {
            metricsService.recordFcmInvalidToken();
          }
        } catch {}

        results.push({
          token,
          tokenFingerprint: fp,
          success: false,
          error: err,
          isInvalidToken: classified.isInvalidToken,
          errorCategory: classified.category,
          latencyMs,
        });

        if (classified.isInvalidToken) {
          logger.warn(`[FCM] Token is invalid/unregistered (${classified.category}). Triggering revocation.`, {
            tokenFingerprint: fp,
          });
          if (onInvalidToken) {
            try {
              await onInvalidToken(token);
            } catch (cleanupErr: any) {
              logger.error("[FCM] Error in onInvalidToken callback:", { error: cleanupErr.message });
            }
          }
        } else {
          logger.error(`[FCM] Transient error sending push notification:`, {
            tokenFingerprint: fp,
            category: classified.category,
            error: err.message,
          });
        }
      }
    }),
  );

  return results;
}

/**
 * Send an FCM push notification to all active devices of a worker.
 */
export async function sendFCMToWorker(
  workerId: string,
  payload: FCMPayload,
): Promise<FCMDeliveryResult[]> {
  const { workerDeviceService } = await import("../features/worker_device/worker_device.service");
  const activeDevices = await workerDeviceService.getActiveDevices(workerId);

  if (!activeDevices || activeDevices.length === 0) {
    logger.info(`[FCM] Worker ${workerId} has no active push devices.`);
    return [];
  }

  const tokens = activeDevices.map((d) => d.fcm_token).filter(Boolean);
  return sendFCMToTokens(tokens, payload, async (invalidToken) => {
    await workerDeviceService.revokeByToken(invalidToken);
  });
}

/**
 * Send an FCM push notification to all active devices of a customer.
 */
export async function sendFCMToCustomer(
  customerId: string,
  payload: FCMPayload,
): Promise<FCMDeliveryResult[]> {
  const { customerDeviceService } = await import("../features/customer_device/customer_device.service");
  const activeDevices = await customerDeviceService.getActiveDevices(customerId);

  if (!activeDevices || activeDevices.length === 0) {
    logger.info(`[FCM] Customer ${customerId} has no active push devices.`);
    return [];
  }

  const tokens = activeDevices.map((d) => d.fcm_token).filter(Boolean);
  return sendFCMToTokens(tokens, payload, async (invalidToken) => {
    await customerDeviceService.revokeByToken(invalidToken);
  });
}

/**
 * Universal recipient push dispatcher.
 */
export async function sendFCMToRecipient(
  recipientType: string,
  recipientId: string,
  payload: FCMPayload,
): Promise<FCMDeliveryResult[]> {
  if (recipientType === "worker") {
    return sendFCMToWorker(recipientId, payload);
  } else if (recipientType === "customer") {
    return sendFCMToCustomer(recipientId, payload);
  }
  return [];
}

/**
 * Legacy single-token notification helper for backward compatibility.
 */
export async function sendFCMNotification(
  deviceToken: string,
  payload: FCMPayload,
): Promise<void> {
  if (!deviceToken) {
    logger.warn("[FCM] Cannot send notification: deviceToken is empty.");
    return;
  }

  const results = await sendFCMToTokens([deviceToken], payload, async (invalidToken) => {
    const { workerDeviceService } = await import("../features/worker_device/worker_device.service");
    await workerDeviceService.revokeByToken(invalidToken);
  });

  if (results[0] && !results[0].success && !results[0].isInvalidToken) {
    logger.warn(`[FCM_FALLBACK] Push notification failed transiently.`);
  }
}
