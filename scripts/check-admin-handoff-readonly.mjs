import fs from "node:fs";
import pg from "pg";

const envText = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const match = envText.match(/^\s*DATABASE_URL\s*=\s*(.*)$/m);
if (!match) throw new Error("DATABASE_URL is missing from .env.local");
const connectionString = match[1].trim().replace(/^['"]|['"]$/g, "");
const url = new URL(connectionString);
url.searchParams.delete("sslmode");
const pool = new pg.Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: false } });

try {
  const [identity, columns, auditColumns, entryColumns] = await Promise.all([
    pool.query(`
      select
        current_user as "currentUser",
        to_regclass('public.admin_actions')::text as "adminActionsTable"
    `),
    pool.query(`
      select column_name as "columnName"
      from information_schema.columns
      where table_schema = 'public' and table_name = 'users'
      order by ordinal_position
    `),
    pool.query(`
      select column_name as "columnName"
      from information_schema.columns
      where table_schema = 'public' and table_name = 'admin_actions'
      order by ordinal_position
    `),
    pool.query(`
      select column_name as "columnName"
      from information_schema.columns
      where table_schema = 'public' and table_name = 'unmatched_race_entries'
      order by ordinal_position
    `),
  ]);
  console.log(JSON.stringify({
    ...identity.rows[0],
    userColumns: columns.rows.map((row) => row.columnName),
    adminActionColumns: auditColumns.rows.map((row) => row.columnName),
    unmatchedEntryColumns: entryColumns.rows.map((row) => row.columnName),
  }, null, 2));
} finally {
  await pool.end();
}
