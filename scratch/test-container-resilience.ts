import { execSync } from "child_process";
import { Client as PgClient } from "pg";
import IORedis from "ioredis";

async function test() {
  console.log("Starting containers...");
  execSync("docker run -d --name test_pg_resilience -p 5440:5432 -e POSTGRES_PASSWORD=pass postgis/postgis:17-3.5 -c max_connections=300", { stdio: "inherit" });
  execSync("docker run -d --name test_redis_resilience -p 6385:6379 redis:7", { stdio: "inherit" });

  await new Promise((r) => setTimeout(r, 4000));

  const client = new PgClient("postgresql://postgres:pass@127.0.0.1:5440/postgres");
  await client.connect();
  console.log("Connected to PG!");

  const r = new IORedis("redis://127.0.0.1:6385");
  console.log("Redis ping:", await r.ping());

  // Rapid 100 queries
  console.log("Firing 200 rapid parallel queries...");
  await Promise.all(Array.from({ length: 200 }).map(() => client.query("SELECT 1")));
  console.log("200 queries finished!");

  // Rapid 200 redis pings
  console.log("Firing 200 rapid redis pings...");
  await Promise.all(Array.from({ length: 200 }).map(() => r.ping()));
  console.log("200 pings finished!");

  await client.end();
  r.disconnect();

  execSync("docker rm -f test_pg_resilience test_redis_resilience", { stdio: "inherit" });
  console.log("SUCCESS!");
}

test().catch((e) => {
  console.error("FAILED:", e);
  try { execSync("docker rm -f test_pg_resilience test_redis_resilience", { stdio: "pipe" }); } catch {}
});
