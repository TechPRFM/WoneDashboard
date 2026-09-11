import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import pg from "pg";

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const separator = trimmed.indexOf("=");
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnv(path.join(process.cwd(), ".env.local"));
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");

const sql = fs.readFileSync(path.join(process.cwd(), "migrations", "20260817_adapter_operations.sql"), "utf8");
function stripSslMode(value) {
  const url = new URL(value);
  url.searchParams.delete("sslmode");
  return url.toString();
}

const rejectUnauthorized = process.env.PG_REJECT_UNAUTHORIZED !== "false";
const client = new pg.Client({
  connectionString: rejectUnauthorized ? process.env.DATABASE_URL : stripSslMode(process.env.DATABASE_URL),
  ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized },
});

await client.connect();
try {
  await client.query(sql);
  const result = await client.query(`
    select
      to_regclass('public.adapter_ops_runs')::text as runs,
      to_regclass('public.adapter_ops_adapter_results')::text as results,
      count(*)::int as upcoming_rows
    from public.adapter_upcoming_events
  `);
  console.log(JSON.stringify({ applied: true, verification: result.rows[0] }, null, 2));
} finally {
  await client.end();
}
