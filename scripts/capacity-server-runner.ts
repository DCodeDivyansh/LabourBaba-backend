/**
 * capacity-server-runner.ts
 *
 * Dedicated process runner for the LabourBaba HTTP + Socket.IO + BullMQ server
 * during production capacity and load verification drills.
 *
 * Runs in its own isolated Node.js process so the load generator runs on separate
 * OS threads and does not contaminate the server's event loop, CPU, or heap.
 */

import dotenv from "dotenv";
dotenv.config();

process.env.NODE_ENV = "staging";
process.env.PORT = process.env.CAPACITY_TEST_PORT || "5001";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || "capacity_test_access_secret_32_characters_minimum_ok!";
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "capacity_test_refresh_secret_32_characters_minimum_ok!";
process.env.STORAGE_SIGNING_SECRET = process.env.STORAGE_SIGNING_SECRET || "capacity_test_storage_signing_secret_32_chars_ok!";
process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || "rzp_live_capacity_test_key_id_ok";
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "capacity_test_razorpay_secret_key_ok";
process.env.RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || "rzp_live_capacity_webhook_secret_ok";
process.env.SMS_PROVIDER = process.env.SMS_PROVIDER || "twilio";
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "AC_capacity_test_account_sid_valid_format";
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "capacity_test_auth_token_valid_format";
process.env.TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER || "+15555555555";
process.env.GENERIC_SMS_API_URL = process.env.GENERIC_SMS_API_URL || "https://sms.capacity-test.com/send";
process.env.GENERIC_SMS_API_KEY = process.env.GENERIC_SMS_API_KEY || "capacity_test_generic_sms_key_ok";
process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || "capacity_test_supabase_service_role_key_long_enough";
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://capacity-test.supabase.co";
import crypto from "crypto";

function generateEphemeralFirebaseServiceAccount(): string {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const sa = {
    type: "service_account",
    project_id: "labourbaba-capacity-test",
    private_key_id: "capacity-test-key-id-01",
    private_key: privateKey,
    client_email: "firebase-adminsdk@labourbaba-capacity-test.iam.gserviceaccount.com",
    client_id: "123456789012345678901",
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
    client_x509_cert_url: "https://www.googleapis.com/robot/v1/metadata/x509/firebase-adminsdk%40labourbaba-capacity-test.iam.gserviceaccount.com",
  };

  return Buffer.from(JSON.stringify(sa)).toString("base64");
}

process.env.FIREBASE_SERVICE_ACCOUNT_JSON = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || generateEphemeralFirebaseServiceAccount();
process.env.FCM_PROJECT_ID = process.env.FCM_PROJECT_ID || "capacity-test-fcm-project";
process.env.STORAGE_PROVIDER = process.env.STORAGE_PROVIDER || "supabase";
process.env.STORAGE_BUCKET_NAME = process.env.STORAGE_BUCKET_NAME || "labourbaba-private-documents";
process.env.ENABLE_WORKERS = process.env.ENABLE_WORKERS || "true";
process.env.DB_POOL_MAX = process.env.DB_POOL_MAX || "25";

async function main() {
  console.log(`[CAPACITY_SERVER] Starting server on PID ${process.pid} (NODE_ENV=${process.env.NODE_ENV}, PORT=${process.env.PORT})...`);

  // Importing src/server executes startServer() automatically when NODE_ENV !== 'test'
  await import("../src/server");

  console.log(`[CAPACITY_SERVER] Server imported and started on port ${process.env.PORT}`);

  // Graceful shutdown handling
  const shutdown = async (signal: string) => {
    console.log(`[CAPACITY_SERVER] Received ${signal}. Shutting down gracefully...`);
    try {
      const { lifecycleManager } = await import("../src/lifecycle/lifecycleManager");
      await lifecycleManager.shutdown(signal, false);
      console.log(`[CAPACITY_SERVER] Shutdown complete.`);
      process.exit(0);
    } catch (err) {
      console.error(`[CAPACITY_SERVER] Error during shutdown:`, err);
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("message", (msg) => {
    if (msg === "SHUTDOWN") shutdown("IPC_SHUTDOWN");
  });
}

main().catch((err) => {
  console.error("[CAPACITY_SERVER] Fatal unhandled error:", err);
  process.exit(1);
});
