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

/**
 * Send an FCM push notification to a device token.
 */
export async function sendFCMNotification(
  deviceToken: string,
  payload: FCMPayload,
): Promise<void> {
  if (!deviceToken) {
    console.warn("[FCM] Cannot send notification: deviceToken is empty.");
    return;
  }

  if (isFirebaseInitialized) {
    try {
      const message: Message = {
        token: deviceToken,
        android: {
          priority: "high",
          notification: {
            priority: "max",
            channelId: "incoming_jobs",
          },
        },
        data: {
          title: payload.title,
          body: payload.body,
          ...(payload.data ?? {}),
        },
      };

      const response = await getMessaging(app).send(message);
      console.log(`[FCM] Notification sent successfully: messageId=${response}`);
    } catch (error: any) {
      console.error("[FCM] Error sending FCM notification:", error.message);
      // Fallback to stub logging on error
      console.log(
        `[FCM FALLBACK] → token=${deviceToken.slice(0, 12)}...`,
        JSON.stringify(payload),
      );
    }
  } else {
    console.log(
      `[FCM STUB] → token=${deviceToken.slice(0, 12)}...`,
      JSON.stringify(payload),
    );
  }
}
