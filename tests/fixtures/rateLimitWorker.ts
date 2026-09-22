import { incrementRateLimit, enableTestMemoryFallback } from "../../src/middlewares/rateLimiter";

enableTestMemoryFallback(false);

process.on("message", async (msg: any) => {
  if (msg.action === "increment") {
    const { key, maxLimit, windowSeconds, failPolicy } = msg;
    try {
      const result = await incrementRateLimit(key, maxLimit, windowSeconds, failPolicy);
      if (process.send) {
        process.send({ success: true, result, pid: process.pid });
      }
    } catch (err: any) {
      if (process.send) {
        process.send({ success: false, error: err?.message, pid: process.pid });
      }
    }
  }
});
