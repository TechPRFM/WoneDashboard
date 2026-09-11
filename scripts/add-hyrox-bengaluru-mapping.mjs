import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

const commit = process.argv.includes("--commit");
if (!commit && !process.argv.includes("--dry-run")) throw new Error("Pass --dry-run or --commit.");
const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8").replace(/^\uFEFF/, "");
for (const raw of envText.split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const at = line.indexOf("=");
  if (at > 0) process.env[line.slice(0, at)] = line.slice(at + 1).replace(/^["']|["']$/g, "");
}
const url = new URL(process.env.DATABASE_URL);
url.searchParams.delete("sslmode");
if (process.env.DB_HOST_OVERRIDE) url.hostname = process.env.DB_HOST_OVERRIDE;
const client = new pg.Client({ connectionString: url.toString(), ssl: { rejectUnauthorized: false } });

const mapping = {
  rawName: "2026 Bengaluru",
  year: 2026,
  raceId: "df50b52f-68c6-4422-81ed-21bd325dc132",
  raceEditionId: "955a9f34-c432-40d9-8d9d-29ab67972f68",
  adapterKey: "hirox",
  externalEventKey: "8|2026 Bengaluru",
  notes: "Exact official HYROX adapter mapping; event also resolves as HYRESULT s8-2026-bengaluru.",
};
const unmatchedRaceName = "Hyrox Bengaluru - Doubles";
const report = { generatedAt: new Date().toISOString(), mode: commit ? "commit" : "dry-run", mapping };

try {
  await client.connect();
  await client.query("begin isolation level serializable");
  await client.query("select pg_advisory_xact_lock(821760214)");
  const edition = await client.query(`
    select id,"raceId",title,year,"eventDate"::date::text as "eventDate"
    from public.race_editions where id=$1 for update
  `, [mapping.raceEditionId]);
  if (edition.rowCount !== 1 || edition.rows[0].raceId !== mapping.raceId ||
      edition.rows[0].title !== "HYROX 2026 Bengaluru" || edition.rows[0].year !== 2026 ||
      edition.rows[0].eventDate !== "2026-04-11") {
    throw new Error(`HYROX edition precondition failed: ${JSON.stringify(edition.rows[0] ?? null)}`);
  }
  const unmatched = await client.query(`
    select id,"raceName" from public.unmatched_race_entries
    where "matchedRaceEditionId"=$1 and "raceName"=$2 for update
  `, [mapping.raceEditionId, unmatchedRaceName]);
  if (unmatched.rowCount !== 1) throw new Error("HYROX unmatched source precondition failed");
  const duplicate = await client.query(`
    select id from public.race_edition_mappings
    where ("rawName"=$1 and year=$2) or "raceEditionId"=$3
  `, [mapping.rawName, mapping.year, mapping.raceEditionId]);
  if (duplicate.rowCount) throw new Error(`HYROX mapping already exists: ${JSON.stringify(duplicate.rows)}`);
  const inserted = await client.query(`
    insert into public.race_edition_mappings
      (id,"rawName",year,"raceId","raceEditionId","adapterKey","externalEventKey",notes,"createdAt","updatedAt")
    values (gen_random_uuid()::text,$1,$2,$3,$4,$5,$6,$7,current_timestamp,current_timestamp)
    returning id
  `, [mapping.rawName, mapping.year, mapping.raceId, mapping.raceEditionId, mapping.adapterKey, mapping.externalEventKey, mapping.notes]);
  report.inserted = inserted.rows[0];
  if (commit) await client.query("commit"); else await client.query("rollback");
  report.transaction = commit ? "committed" : "rolled_back";
} catch (error) {
  try { await client.query("rollback"); } catch {}
  report.transaction = "rolled_back_on_error";
  report.error = error.message;
  throw error;
} finally {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "_");
  const output = resolve(process.cwd(), "..", "db_quality_audits", `hyrox_bengaluru_mapping_${commit ? "commit" : "dry_run"}_${stamp}.json`);
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }, null, 2));
  await client.end();
}
