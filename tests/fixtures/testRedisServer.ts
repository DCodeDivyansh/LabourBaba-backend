/**
 * testRedisServer.ts
 *
 * Lightweight, deterministic Redis RESP TCP Server for cross-instance integration testing.
 * Implements Redis wire protocol (RESP) for PING, INFO, SUBSCRIBE, PSUBSCRIBE, PUBLISH, QUIT,
 * allowing real IORedis clients and @socket.io/redis-adapter to communicate across multiple
 * API processes over real TCP sockets.
 *
 * If a real Redis daemon is running on REDIS_PORT / 6379, it can optionally use that directly.
 */

import net from "net";
const RedisParser = require("redis-parser");
import IORedis from "ioredis";

export interface TestRedisServerInstance {
  port: number;
  stop: () => Promise<void>;
  pause: () => void;
  resume: () => void;
  isRealRedis: boolean;
}

function serializeResp(data: any): Buffer {
  if (data === null || data === undefined) {
    return Buffer.from("$-1\r\n");
  }
  if (typeof data === "string") {
    const b = Buffer.from(data, "utf-8");
    return Buffer.concat([Buffer.from(`$${b.length}\r\n`), b, Buffer.from("\r\n")]);
  }
  if (Buffer.isBuffer(data)) {
    return Buffer.concat([Buffer.from(`$${data.length}\r\n`), data, Buffer.from("\r\n")]);
  }
  if (typeof data === "number") {
    return Buffer.from(`:${data}\r\n`);
  }
  if (Array.isArray(data)) {
    const parts: any[] = [Buffer.from(`*${data.length}\r\n`)];
    for (const item of data) {
      parts.push(serializeResp(item));
    }
    return Buffer.concat(parts);
  }
  return Buffer.from("+OK\r\n");
}

export async function startTestRedisServer(): Promise<TestRedisServerInstance> {
  const envPort = process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : 6379;
  const envHost = process.env.REDIS_HOST || "127.0.0.1";

  // 1. Check if external Redis is available
  try {
    const probe = new IORedis({
      host: envHost,
      port: envPort,
      connectTimeout: 800,
      maxRetriesPerRequest: null,
      retryStrategy: () => null,
    });
    const pong = await probe.ping();
    await probe.quit();
    if (pong === "PONG") {
      return {
        port: envPort,
        isRealRedis: true,
        stop: async () => {},
        pause: () => {},
        resume: () => {},
      };
    }
  } catch {
    // Fallback to internal RESP server
  }

  // 2. Start internal RESP server
  const activeSockets = new Set<net.Socket>();
  const channelSubs = new Map<string, Set<net.Socket>>();
  const patternSubs = new Map<string, Set<net.Socket>>();
  let isPaused = false;

  const server = net.createServer((socket) => {
    activeSockets.add(socket);

    const toStr = (val: any): string => (Buffer.isBuffer(val) ? val.toString("utf-8") : String(val));

    const parser = new RedisParser({
      returnBuffers: true,
      returnReply: (args: any) => {
        if (isPaused) {
          return; // Ignore / drop commands during simulated outage
        }
        if (!Array.isArray(args) || args.length === 0) return;

        const cmd = toStr(args[0]).toUpperCase();

        if (cmd === "PING") {
          socket.write(Buffer.from("+PONG\r\n"));
        } else if (cmd === "INFO") {
          socket.write(serializeResp("# Server\r\nredis_version:7.0.0\r\n"));
        } else if (cmd === "CLIENT" || cmd === "SELECT") {
          socket.write(Buffer.from("+OK\r\n"));
        } else if (cmd === "SUBSCRIBE") {
          for (let i = 1; i < args.length; i++) {
            const ch = toStr(args[i]);
            if (!channelSubs.has(ch)) channelSubs.set(ch, new Set());
            channelSubs.get(ch)!.add(socket);
            socket.write(serializeResp(["subscribe", ch, channelSubs.get(ch)!.size]));
          }
        } else if (cmd === "PSUBSCRIBE") {
          for (let i = 1; i < args.length; i++) {
            const pat = toStr(args[i]);
            if (!patternSubs.has(pat)) patternSubs.set(pat, new Set());
            patternSubs.get(pat)!.add(socket);
            socket.write(serializeResp(["psubscribe", pat, patternSubs.get(pat)!.size]));
          }
        } else if (cmd === "UNSUBSCRIBE") {
          for (let i = 1; i < args.length; i++) {
            const ch = toStr(args[i]);
            channelSubs.get(ch)?.delete(socket);
            socket.write(serializeResp(["unsubscribe", ch, channelSubs.get(ch)?.size || 0]));
          }
        } else if (cmd === "PUNSUBSCRIBE") {
          for (let i = 1; i < args.length; i++) {
            const pat = toStr(args[i]);
            patternSubs.get(pat)?.delete(socket);
            socket.write(serializeResp(["punsubscribe", pat, patternSubs.get(pat)?.size || 0]));
          }
        } else if (cmd === "PUBLISH") {
          const ch = toStr(args[1]);
          const msg = args[2]; // Preserved as raw Buffer
          let receivers = 0;

          // Direct channel matches
          if (channelSubs.has(ch)) {
            for (const s of channelSubs.get(ch)!) {
              if (s !== socket && !s.destroyed) {
                s.write(serializeResp(["message", ch, msg]));
                receivers++;
              }
            }
          }

          // Pattern matches (e.g. socket.io#*#)
          for (const [pat, set] of patternSubs.entries()) {
            const regexStr = pat.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
            const regex = new RegExp(`^${regexStr}$`);
            if (regex.test(ch)) {
              for (const s of set) {
                if (s !== socket && !s.destroyed) {
                  s.write(serializeResp(["pmessage", pat, ch, msg]));
                  receivers++;
                }
              }
            }
          }

          socket.write(serializeResp(receivers));
        } else if (cmd === "QUIT") {
          socket.write(Buffer.from("+OK\r\n"));
          socket.end();
        } else {
          socket.write(Buffer.from("+OK\r\n"));
        }
      },
      returnError: (err: any) => {
        console.error("[TEST_REDIS_PARSER_ERROR]", err);
      },
    });

    socket.on("data", (chunk) => {
      if (!isPaused) {
        parser.execute(chunk);
      }
    });

    socket.on("close", () => {
      activeSockets.delete(socket);
      for (const set of channelSubs.values()) set.delete(socket);
      for (const set of patternSubs.values()) set.delete(socket);
    });

    socket.on("error", () => {});
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const assignedPort = (server.address() as net.AddressInfo).port;

  return {
    port: assignedPort,
    isRealRedis: false,
    pause: () => {
      isPaused = true;
      for (const socket of activeSockets) {
        socket.destroy();
      }
      activeSockets.clear();
      channelSubs.clear();
      patternSubs.clear();
    },
    resume: () => {
      isPaused = false;
    },
    stop: async () => {
      isPaused = true;
      for (const socket of activeSockets) {
        socket.destroy();
      }
      activeSockets.clear();
      channelSubs.clear();
      patternSubs.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
