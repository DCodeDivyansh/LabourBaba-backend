/**
 * socketRedisAdapter.ts
 *
 * LabourBaba Backend — P6 Issue 11: Socket.IO Multi-Instance Scaling & Redis Adapter
 *
 * Connects Socket.IO to Redis Pub/Sub backplane using @socket.io/redis-adapter and IORedis.
 * Enables horizontal scaling across multiple API instances so room events, personal rooms,
 * notifications, and chat messages route transparently across instances.
 *
 * Invariants:
 * 1. Dedicated pubClient and subClient (never share a subscriber connection with general commands).
 * 2. Canonical Redis connection options reused from config/redis.ts.
 * 3. Fail-fast in production: Throws on startup if Redis is unavailable or misconfigured.
 * 4. Graceful lifecycle management: Clients are cleanly quit/disconnected during shutdown.
 * 5. Connection error and readiness telemetry are observable.
 */

import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import IORedis, { Redis as IORedisClient } from "ioredis";
import { getRedisConnectionOptions } from "../config/redis";
import { logger } from "../utils/logger";

let adapterPubClient: IORedisClient | null = null;
let adapterSubClient: IORedisClient | null = null;
let isAdapterReady = false;

export interface SocketRedisAdapterOptions {
  pubClient?: IORedisClient;
  subClient?: IORedisClient;
  forceEnable?: boolean;
}

/**
 * Attaches the Redis adapter to the given Socket.IO server.
 */
export async function setupSocketRedisAdapter(
  io: Server,
  options?: SocketRedisAdapterOptions
): Promise<boolean> {
  const isProduction = process.env.NODE_ENV === "production";
  const isEnabledExplicitly = process.env.SOCKET_REDIS_ADAPTER_ENABLED === "true";
  const isDisabledExplicitly = process.env.SOCKET_REDIS_ADAPTER_ENABLED === "false";

  // In production, multi-instance Redis adapter is mandatory
  const shouldEnable = options?.forceEnable || isEnabledExplicitly || (isProduction && !isDisabledExplicitly);

  if (!shouldEnable) {
    logger.info("[SOCKET_REDIS_ADAPTER] Redis adapter disabled by configuration; using local adapter.");
    return false;
  }

  logger.info("[SOCKET_REDIS_ADAPTER] Initializing Socket.IO Redis Pub/Sub adapter...");

  try {
    if (options?.pubClient && options?.subClient) {
      adapterPubClient = options.pubClient;
      adapterSubClient = options.subClient;
    } else {
      const redisOptions = getRedisConnectionOptions();

      // Dedicated pubClient
      adapterPubClient = new IORedis({
        ...redisOptions,
        maxRetriesPerRequest: null,
      });

      // Dedicated subClient (pub/sub requires separate client)
      adapterSubClient = adapterPubClient.duplicate();
    }

    // Attach error handlers to prevent unhandled process crashes
    adapterPubClient.on("error", (err) => {
      isAdapterReady = false;
      logger.error("[SOCKET_REDIS_ADAPTER_PUB_ERROR]", { error: err.message });
    });

    adapterSubClient.on("error", (err) => {
      isAdapterReady = false;
      logger.error("[SOCKET_REDIS_ADAPTER_SUB_ERROR]", { error: err.message });
    });

    adapterPubClient.on("ready", () => {
      if (adapterSubClient?.status === "ready") {
        isAdapterReady = true;
      }
      logger.info("[SOCKET_REDIS_ADAPTER] Pub client connected to Redis.");
    });

    adapterSubClient.on("ready", () => {
      if (adapterPubClient?.status === "ready") {
        isAdapterReady = true;
      }
      logger.info("[SOCKET_REDIS_ADAPTER] Sub client connected to Redis.");
    });

    // Await ready if connecting newly
    const waitForReady = (client: IORedisClient): Promise<void> => {
      if (client.status === "ready") return Promise.resolve();
      return new Promise((resolve, reject) => {
        const onReady = () => {
          cleanup();
          resolve();
        };
        const onError = (err: Error) => {
          cleanup();
          reject(err);
        };
        const cleanup = () => {
          client.removeListener("ready", onReady);
          client.removeListener("error", onError);
        };
        client.once("ready", onReady);
        client.once("error", onError);
      });
    };

    // Wait up to 5000ms for connections
    await Promise.race([
      Promise.all([waitForReady(adapterPubClient), waitForReady(adapterSubClient)]),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timeout waiting for Redis adapter connections")), 5000)
      ),
    ]);

    // Attach adapter to Socket.IO
    io.adapter(createAdapter(adapterPubClient, adapterSubClient));
    isAdapterReady = true;
    logger.info("[SOCKET_REDIS_ADAPTER] Socket.IO Redis adapter attached successfully.");
    return true;
  } catch (err: any) {
    isAdapterReady = false;
    logger.error("[SOCKET_REDIS_ADAPTER_INIT_FAILED]", { error: err.message });

    // Clean up failed clients
    await closeSocketRedisAdapter();

    if (isProduction || options?.forceEnable || isEnabledExplicitly) {
      throw new Error(
        `[SOCKET_REDIS_ADAPTER_ERROR] Failed to initialize Socket.IO Redis adapter: ${err.message}`
      );
    }

    logger.warn(
      "[SOCKET_REDIS_ADAPTER] Falling back to process-local adapter (non-production environment only)."
    );
    return false;
  }
}

/**
 * Returns whether the Redis adapter is currently connected and ready.
 */
export function isSocketRedisAdapterReady(): boolean {
  return isAdapterReady && adapterPubClient?.status === "ready" && adapterSubClient?.status === "ready";
}

/**
 * Retrieves the active pub/sub clients for inspection or testing.
 */
export function getSocketRedisAdapterClients(): {
  pubClient: IORedisClient | null;
  subClient: IORedisClient | null;
} {
  return {
    pubClient: adapterPubClient,
    subClient: adapterSubClient,
  };
}

/**
 * Gracefully shuts down and terminates the Redis adapter pub/sub connections.
 */
export async function closeSocketRedisAdapter(): Promise<void> {
  isAdapterReady = false;
  const pub = adapterPubClient;
  const sub = adapterSubClient;
  adapterPubClient = null;
  adapterSubClient = null;

  const closes: Promise<any>[] = [];

  if (pub) {
    closes.push(
      pub.quit().catch(() => {
        pub.disconnect();
      })
    );
  }

  if (sub) {
    closes.push(
      sub.quit().catch(() => {
        sub.disconnect();
      })
    );
  }

  await Promise.allSettled(closes);
  logger.info("[SOCKET_REDIS_ADAPTER] Redis adapter connections cleanly closed.");
}
