import { execSync } from "child_process";
import autocannon from "autocannon";
import { Client as PgClient } from "pg";

async function main() {
  console.log("Starting postgres & redis...");
  execSync("docker rm -f dbg-pg dbg-redis", { stdio: "ignore" });
  execSync("docker run -d --name dbg-pg -p 5434:5432 -e POSTGRES_PASSWORD=pass postgis/postgis:17-3.5 -c max_connections=300", { stdio: "inherit" });
  execSync("docker run -d --name dbg-redis -p 6381:6379 redis:7", { stdio: "inherit" });

  await new Promise((r) => setTimeout(r, 4000));

  const client = new PgClient("postgresql://postgres:pass@127.0.0.1:5434/postgres");
  await client.connect();
  console.log("Connected to dbg-pg!");

  // Check initial activity
  const res1 = await client.query("SELECT count(*) FROM pg_stat_activity;");
  console.log("Initial connections:", res1.rows[0].count);

  // Now create 100 parallel connections to postgres
  console.log("Opening 100 concurrent clients to PostgreSQL...");
  const clients = Array.from({ length: 100 }).map(() => new PgClient("postgresql://postgres:pass@127.0.0.1:5434/postgres"));
  await Promise.all(clients.map((c) => c.connect()));
  console.log("All 100 clients connected!");

  const res2 = await client.query("SELECT count(*) FROM pg_stat_activity;");
  console.log("Active connections:", res2.rows[0].count);

  await Promise.all(clients.map((c) => c.end()));
  console.log("All 100 clients closed cleanly!");

  await client.end();
  execSync("docker rm -f dbg-pg dbg-redis", { stdio: "ignore" });
  console.log("Done!");
}

main().catch((e) => {
  console.error("FAIL:", e);
  try {
    console.log("DOCKER LOGS:");
    console.log(execSync("docker logs dbg-pg").toString());
  } catch {}
});
