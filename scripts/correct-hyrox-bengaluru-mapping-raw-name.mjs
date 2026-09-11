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
const mappingId = "abcda14b-87f0-445e-b9e2-e8e4b74b9393";
const previousRawName = "2026 Bengaluru";
const correctedRawName = "Hyrox Bengaluru - Doubles";
const report = { generatedAt: new Date().toISOString(), mode: commit ? "commit" : "dry-run", mappingId, previousRawName, correctedRawName };

try {
  await client.connect();
  await client.query("begin isolation level serializable");
  await client.query("select pg_advisory_xact_lock(821760214)");
  const source = await client.query(`
    select id,"raceName",year,"matchedRaceEditionId" from public.unmatched_race_entries
    where "raceName"=$1 and year=2026 and "matchedRaceEditionId"='955a9f34-c432-40d9-8d9d-29ab67972f68'
    for update
  `, [correctedRawName]);
  if (source.rowCount !== 1) throw new Error(`Exact unmatched source row not found: ${source.rowCount}`);
  const duplicate = await client.query(`
    select id from public.race_edition_mappings where "rawName"=$1 and year=2026 and id<>$2
  `, [correctedRawName, mappingId]);
  if (duplicate.rowCount) throw new Error(`Corrected rawName already mapped: ${JSON.stringify(duplicate.rows)}`);
  const updated = await client.query(`
    update public.race_edition_mappings
    set "rawName"=$1,"updatedAt"=current_timestamp
    where id=$2 and "rawName"=$3 and year=2026
      and "raceEditionId"='955a9f34-c432-40d9-8d9d-29ab67972f68'
      and "adapterKey"='hirox' and "externalEventKey"='8|2026 Bengaluru'
    returning id,"rawName",year,"raceEditionId","adapterKey","externalEventKey"
  `, [correctedRawName, mappingId, previousRawName]);
  if (updated.rowCount !== 1) throw new Error(`Mapping update precondition failed: ${updated.rowCount}`);
  report.updated = updated.rows[0];
  if (commit) await client.query("commit"); else await client.query("rollback");
  report.transaction = commit ? "committed" : "rolled_back";
} catch (error) {
  try { await client.query("rollback"); } catch {}
  report.transaction = "rolled_back_on_error";
  report.error = error.message;
  throw error;
} finally {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "_");
  const output = resolve(process.cwd(), "..", "db_quality_audits", `hyrox_mapping_raw_name_${commit ? "commit" : "dry_run"}_${stamp}.json`);
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }, null, 2));
  await client.end();
}
