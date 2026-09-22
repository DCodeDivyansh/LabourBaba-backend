const { incrementRateLimit, enableTestMemoryFallback } = require("../../src/middlewares/rateLimiter");

// Genuinely independent Node OS process
enableTestMemoryFallback(false);

process.on("message", async (msg) => {
  if (msg.action === "increment") {
    const { key, maxLimit, windowSeconds, failPolicy } = msg;
    try {
      const result = await incrementRateLimit(key, maxLimit, windowSeconds, failPolicy);
      process.send({ success: true, result, pid: process.pid });
    } catch (err) {
      process.send({ success: false, error: err.message, pid: process.pid });
    }
  }
});
