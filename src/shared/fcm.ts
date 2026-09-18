import { initializeApp, getApps, cert, App } from "firebase-admin/app";
import { getMessaging, Message } from "firebase-admin/messaging";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

let isFirebaseInitialized = false;
let app: App | undefined;

if (getApps().length > 0) {
  isFirebaseInitialized = true;
  app = getApps()[0];
} else {
  // Check if a service account file exists at the project root
  const rootServiceAccountPath = resolve(process.cwd(), "labourbaba-58a41-firebase-adminsdk-fbsvc-e72264934a.json");
  const serviceAccountVar = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  let serviceAccount: any = null;

  if (existsSync(rootServiceAccountPath)) {
    try {
      const fileContent = readFileSync(rootServiceAccountPath, "utf-8");
      serviceAccount = JSON.parse(fileContent);
      console.log(`[FCM] Found Firebase Service Account file at: ${rootServiceAccountPath}`);
    } catch (error: any) {
      console.error("[FCM] Failed to parse local service account JSON file:", error.message);
    }
  } else if (serviceAccountVar) {
    try {
      serviceAccount = JSON.parse(serviceAccountVar);
    } catch (error: any) {
      console.error("[FCM] Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON env variable:", error.message);
    }
  }

  if (serviceAccount) {
    try {
      app = initializeApp({
        credential: cert(serviceAccount),
      });
      isFirebaseInitialized = true;
      console.log("[FCM] Firebase Admin SDK initialized successfully via Service Account.");
    } catch (error: any) {
      console.error("[FCM] Failed to initialize Firebase Admin SDK with Service Account:", error.message);
    }
  } else {
    // Attempt default initialization (e.g., via GOOGLE_APPLICATION_CREDENTIALS environment variable or default metadata server)
    try {
      app = initializeApp();
      isFirebaseInitialized = true;
      console.log("[FCM] Firebase Admin SDK initialized via Application Default Credentials.");
    } catch (error: any) {
      console.warn("[FCM] Firebase Admin SDK could not be initialized (no credentials found). FCM calls will run in stub mode.");
    }
  }
}

export interface FCMPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface FCMDeliveryResult {
  token: string;
  success: boolean;
  messageId?: string;
  error?: any;
  isInvalidToken?: boolean;
}

/**
 * Determines if an FCM error indicates that a token is permanently invalid or unregistered.
 * Transient errors (e.g. server timeout, network disconnect) must NOT be treated as invalid tokens.
 */
export function isPermanentInvalidTokenError(error: any): boolean {
  if (!error) return false;
  const code = String(error.code || error.errorInfo?.code || "").toLowerCase();
  const message = String(error.message || "").toLowerCase();

  return (
    code.includes("registration-token-not-registered") ||
    code.includes("invalid-registration-token") ||
    code.includes("invalid-argument") ||
    message.includes("registration-token-not-registered") ||
    message.includes("invalid-registration-token") ||
    message.includes("requested entity was not found") ||
    message.includes("not a valid fcm registration token")
  );
}

/**
 * Send an FCM push notification to multiple tokens in parallel.
 * Detects invalid tokens and triggers cleanup callback while allowing valid tokens to succeed.
 */
export async function sendFCMToTokens(
  tokens: string[],
  payload: FCMPayload,
  onInvalidToken?: (token: string) => Promise<void> | void,
): Promise<FCMDeliveryResult[]> {
  if (!tokens || tokens.length === 0) return [];

  const results: FCMDeliveryResult[] = [];

  await Promise.allSettled(
    tokens.map(async (token) => {
      if (!token) return;
      try {
        if (isFirebaseInitialized && app) {
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

          const messageId = await getMessaging(app).send(message);
          results.push({ token, success: true, messageId });
        } else {
          // Stub mode for local dev / tests without credentials
          console.log(
            `[FCM STUB] → token=${token.slice(0, 12)}...`,
            JSON.stringify(payload),
          );
          results.push({ token, success: true, messageId: "stub-message-id" });
        }
      } catch (err: any) {
        const isInvalid = isPermanentInvalidTokenError(err);
        results.push({ token, success: false, error: err, isInvalidToken: isInvalid });

        if (isInvalid) {
          console.warn(`[FCM] Token is invalid/unregistered: ${token.slice(0, 12)}... Revoking.`);
          if (onInvalidToken) {
            try {
              await onInvalidToken(token);
            } catch (cleanupErr: any) {
              console.error("[FCM] Error in onInvalidToken callback:", cleanupErr.message);
            }
          }
        } else {
          console.error(`[FCM] Transient error sending to token ${token.slice(0, 12)}...:`, err.message);
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
  // Dynamically import workerDeviceService to prevent circular dependency
  const { workerDeviceService } = await import("../features/worker_device/worker_device.service");
  const activeDevices = await workerDeviceService.getActiveDevices(workerId);

  if (!activeDevices || activeDevices.length === 0) {
    console.log(`[FCM] Worker ${workerId} has no active push devices.`);
    return [];
  }

  const tokens = activeDevices.map((d) => d.fcm_token).filter(Boolean);
  return sendFCMToTokens(tokens, payload, async (invalidToken) => {
    await workerDeviceService.revokeByToken(invalidToken);
  });
}

/**
 * Legacy single-token notification helper for backward compatibility.
 */
export async function sendFCMNotification(
  deviceToken: string,
  payload: FCMPayload,
): Promise<void> {
  if (!deviceToken) {
    console.warn("[FCM] Cannot send notification: deviceToken is empty.");
    return;
  }

  const results = await sendFCMToTokens([deviceToken], payload, async (invalidToken) => {
    const { workerDeviceService } = await import("../features/worker_device/worker_device.service");
    await workerDeviceService.revokeByToken(invalidToken);
  });

  if (results[0] && !results[0].success && !results[0].isInvalidToken) {
    console.log(
      `[FCM FALLBACK] → token=${deviceToken.slice(0, 12)}...`,
      JSON.stringify(payload),
    );
  }
}
