import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import pg from "pg";

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8").replace(/^\uFEFF/, "");
for (const rawLine of envText.split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;
  const separator = line.indexOf("=");
  if (separator > 0) process.env[line.slice(0, separator)] = line.slice(separator + 1).replace(/^["']|["']$/g, "");
}

const url = new URL(process.env.DATABASE_URL);
url.searchParams.delete("sslmode");
if (process.env.DB_HOST_OVERRIDE) url.hostname = process.env.DB_HOST_OVERRIDE;
const client = new pg.Client({ connectionString: url.toString(), ssl: { rejectUnauthorized: false } });

const requestedTables = [
  "races", "race_editions", "race_categories", "race_edition_mappings",
  "results", "splits", "rank_info", "ResultClaim", "personal_bests", "result_flags",
  "eligibilities", "legacy_results", "registrations", "club_activities", "club_images",
  "gmail_import_results", "race_reviews", "race_tags", "strava_import_results",
  "unmatched_race_entries", "user_activities", "_UserFavoriteRaces", "_UserRejectedResults",
];

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "_");
const outputDir = resolve(process.cwd(), "..", "db_snapshots", "production", `before_quality_fix_${stamp}`);
mkdirSync(outputDir, { recursive: true });

try {
  await client.connect();
  await client.query("begin transaction read only");
  const availableResult = await client.query("select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE'");
  const available = new Set(availableResult.rows.map((row) => row.table_name));
  const tables = requestedTables.filter((table) => available.has(table));
  const manifest = { generatedAt: new Date().toISOString(), readOnly: true, outputDir, tables: [] };

  for (const table of tables) {
    const result = await client.query(`select * from public."${table.replaceAll('"', '""')}"`);
    const file = resolve(outputDir, `${table}.json`);
    writeFileSync(file, JSON.stringify(result.rows, null, 2));
    manifest.tables.push({ table, rows: result.rowCount, file });
    process.stdout.write(`${table}: ${result.rowCount}\n`);
  }
  await client.query("commit");
  const manifestPath = resolve(outputDir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  process.stdout.write(JSON.stringify({ outputDir, manifestPath, tables: manifest.tables.length, rows: manifest.tables.reduce((sum, row) => sum + row.rows, 0) }, null, 2));
} catch (error) {
  try { await client.query("rollback"); } catch {}
  throw error;
} finally {
  await client.end();
}
