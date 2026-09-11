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

const editionId = "bf7a0a8a-1c7f-40ce-a3dc-759a30759cd2";
const raceId = "cecf9a27-a2a6-4c33-affd-5d1016cef52c";
const report = {
  generatedAt: new Date().toISOString(),
  mode: commit ? "commit" : "dry-run",
  editionId,
  oldTitle: "Harvest Global Energy Race",
  newTitle: "Harvest Gold Global Race",
  sourceUrls: [
    "https://pfsindia.in/past-events.html",
    "https://lbb.in/delhi/harvest-gold-global-race/",
  ],
};

try {
  await client.connect();
  await client.query("begin isolation level serializable");
  await client.query("select pg_advisory_xact_lock(821760214)");
  const edition = await client.query(`
    select id,"raceId",title,year,location,"eventDate"::date::text as "eventDate"
    from public.race_editions where id=$1 for update
  `, [editionId]);
  if (edition.rowCount !== 1 || edition.rows[0].raceId !== raceId ||
      edition.rows[0].title !== report.oldTitle || edition.rows[0].year !== 2019 ||
      edition.rows[0].location !== "Gurugram" || edition.rows[0].eventDate !== "2019-09-22") {
    throw new Error(`Harvest edition precondition failed: ${JSON.stringify(edition.rows[0] ?? null)}`);
  }
  const mapping = await client.query(`
    select id,"rawName","externalEventKey" from public.race_edition_mappings
    where "raceEditionId"=$1 and "adapterKey"='runizen' for update
  `, [editionId]);
  if (mapping.rowCount !== 1 || mapping.rows[0].rawName !== report.oldTitle) {
    throw new Error("Harvest source mapping precondition failed");
  }
  report.mappingPreserved = mapping.rows[0];
  report.editionsUpdated = (await client.query(`update public.race_editions set title=$1 where id=$2`, [report.newTitle, editionId])).rowCount;
  if (report.editionsUpdated !== 1) throw new Error("Harvest edition update failed");
  if (commit) await client.query("commit"); else await client.query("rollback");
  report.transaction = commit ? "committed" : "rolled_back";
} catch (error) {
  try { await client.query("rollback"); } catch {}
  report.transaction = "rolled_back_on_error";
  report.error = error.message;
  throw error;
} finally {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "_");
  const output = resolve(process.cwd(), "..", "db_quality_audits", `harvest_2019_${commit ? "commit" : "dry_run"}_${stamp}.json`);
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }, null, 2));
  await client.end();
}
