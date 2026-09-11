import "server-only";

import { Pool } from "pg";

type GlobalWithPool = typeof globalThis & { __woneAdapterOpsWritePool?: Pool };

function stripSslMode(value: string) {
  try {
    const url = new URL(value);
    url.searchParams.delete("sslmode");
    return url.toString();
  } catch {
    return value;
  }
}

export function getAdapterOpsWritePool() {
  const globalForPool = globalThis as GlobalWithPool;
  if (globalForPool.__woneAdapterOpsWritePool) return globalForPool.__woneAdapterOpsWritePool;
  const connectionString = process.env.ADAPTER_OPS_DATABASE_URL
    || (process.env.NODE_ENV === "development" ? process.env.DATABASE_URL : null);
  if (!connectionString) {
    throw new Error("ADAPTER_OPS_DATABASE_URL is not configured for the scoped monitoring writer.");
  }
  const rejectUnauthorized = process.env.PG_REJECT_UNAUTHORIZED !== "false";
  const pool = new Pool({
    connectionString: rejectUnauthorized ? connectionString : stripSslMode(connectionString),
    max: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 20_000,
    ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized },
  });
  globalForPool.__woneAdapterOpsWritePool = pool;
  return pool;
}
