import { Client } from "pg";
import dotenv from "dotenv";
dotenv.config();

async function main() {
  // Extract base connection string pointing to template1 or postgres database on localhost:5432
  // If DIRECT_URL or DATABASE_URL has postgresql://...
  const rawUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;
  console.log("Testing DB connection...");
  const client = new Client({ connectionString: rawUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const res = await client.query("SELECT current_database(), version();");
  console.log("Connected to:", res.rows[0]);
  await client.end();
}

main().catch(console.error);
