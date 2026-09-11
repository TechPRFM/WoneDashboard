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
const target = "4bdea206-7db0-461a-96e9-9070d1497256";
const source = "df902ca5-3216-43e4-84af-27e3c29534c7";
const report = { generatedAt: new Date().toISOString(), mode: commit ? "commit" : "dry-run", target, source };

try {
  await client.connect();
  await client.query("begin isolation level serializable");
  await client.query("select pg_advisory_xact_lock(821760214)");
  const races = await client.query("select id,title from public.races where id=any($1::text[]) for update", [[target, source]]);
  if (races.rowCount !== 2 || races.rows.some((row) => row.title !== "Vrukshathon Heritage Run")) throw new Error("Vrukshathon race precondition failed");
  const collision = await client.query(`select "eventDate"::date,count(*)::int from public.race_editions where "raceId"=any($1::text[]) and "eventDate" is not null group by "eventDate"::date having count(*)>1`, [[target, source]]);
  if (collision.rowCount) throw new Error(`Unexpected Vrukshathon date collision: ${JSON.stringify(collision.rows)}`);
  report.editionsUpdated = (await client.query(`update public.race_editions set "raceId"=$1 where "raceId"=$2`, [target, source])).rowCount;
  report.mappingsUpdated = (await client.query(`update public.race_edition_mappings set "raceId"=$1 where "raceId"=$2`, [target, source])).rowCount;
  report.reviewsUpdated = (await client.query(`update public.race_reviews set "raceId"=$1 where "raceId"=$2`, [target, source])).rowCount;
  report.tagsUpdated = (await client.query(`update public.race_tags set "raceId"=$1 where "raceId"=$2`, [target, source])).rowCount;
  report.racesDeleted = (await client.query("delete from public.races where id=$1", [source])).rowCount;
  if (report.editionsUpdated !== 1 || report.mappingsUpdated !== 1 || report.racesDeleted !== 1) throw new Error(`Unexpected Vrukshathon update counts: ${JSON.stringify(report)}`);
  const verification = await client.query(`select (select count(*)::int from public.races where id=$1) source,(select count(*)::int from public.race_editions where "raceId"=$1) editions,(select count(*)::int from public.race_edition_mappings where "raceId"=$1) mappings`, [source]);
  report.verification = verification.rows[0];
  if (Object.values(report.verification).some((value) => Number(value))) throw new Error(`Vrukshathon references remain: ${JSON.stringify(report.verification)}`);
  if (commit) await client.query("commit"); else await client.query("rollback");
  report.transaction = commit ? "committed" : "rolled_back";
} catch (error) {
  try { await client.query("rollback"); } catch {}
  report.transaction = "rolled_back_on_error";
  report.error = error.message;
  throw error;
} finally {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "_");
  const output = resolve(process.cwd(), "..", "db_quality_audits", `vrukshathon_postfix_${commit ? "commit" : "dry_run"}_${stamp}.json`);
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }, null, 2));
  await client.end();
}
