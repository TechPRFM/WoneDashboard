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
const cityFixes = [
  ["ccf42481-9ea8-4091-8d37-f7b3625da1b5", "Sri Vijaya Puram", "https://andamanchronicle.net/arrangements-for-conduct-of-10th-edition-of-andaman-marathon-on-in-full-swing/"],
  ["3faa3bc7-e214-43f0-aad5-fa03efad885d", "Mollem", "https://www.townscript.com/e/DudhsagarUltraTrail2026"],
  ["7886d435-4359-4fa9-bf2b-fd0c9d2ef8be", "Nagaon", "https://www.townscript.com/e/the-wild-trail-run-2026"],
  ["2af77f3d-b4c2-4be2-a0dd-fd9e7cc4b111", "Khawasa", "https://www.mptourism.com/mowgli-land-half-marathon.htm"],
  ["4dfea0b2-6a2b-457d-922e-48cab0fc89a7", "Khawasa", "https://utsav.gov.in/public/view-event/mowgliland-half-marathon"],
  ["2f5c152d-ea49-473b-a6dc-0a5b467e5d1a", "Surat", "https://www.amarujala.com/amp/india-news/gujarat-day-night-marathon-was-organized-in-surat-to-mark-gujarat-state-formation-day"],
  ["9feb5eba-33a0-42c7-8cc5-efd7bc4938ba", "Punakha", "https://bhutaninternationalmarathon.com/course-information/"],
];
const trainingEditionId = "40ba2221-7f88-4c56-b1c7-d697e0a5eb57";
const trainingRaceId = "b9a68d4d-d201-41e2-b055-1f6aabb274ad";
const report = { generatedAt: new Date().toISOString(), mode: commit ? "commit" : "dry-run", cityFixes: [], trainingProgram: {} };

try {
  await client.connect();
  await client.query("begin isolation level serializable");
  await client.query("select pg_advisory_xact_lock(821760214)");
  for (const [editionId, city, sourceUrl] of cityFixes) {
    const result = await client.query(`update public.race_editions set city=$1 where id=$2 and city is null`, [city, editionId]);
    if (result.rowCount !== 1) throw new Error(`City precondition failed for ${editionId}`);
    report.cityFixes.push({ editionId, city, sourceUrl, rows: result.rowCount });
  }

  const edition = await client.query(`select id,"raceId",title from public.race_editions where id=$1 and "raceId"=$2 for update`, [trainingEditionId, trainingRaceId]);
  if (edition.rowCount !== 1 || edition.rows[0].title !== "Train & Shine Program 2026-27") throw new Error("Train & Shine precondition failed");
  const referenceColumns = await client.query(`
    select table_name,column_name from information_schema.columns
    where table_schema='public' and column_name in ('raceEditionId','matchedRaceEditionId')
      and table_name not in ('race_editions','race_edition_mappings')
    order by table_name,column_name
  `);
  const downstream = {};
  for (const row of referenceColumns.rows) {
    const count = Number((await client.query(`select count(*)::int as count from public."${row.table_name.replaceAll('"','""')}" where "${row.column_name}"=$1`, [trainingEditionId])).rows[0].count);
    if (count) downstream[`${row.table_name}.${row.column_name}`] = count;
  }
  if (Object.keys(downstream).length) throw new Error(`Train & Shine has downstream data: ${JSON.stringify(downstream)}`);
  report.trainingProgram.downstream = downstream;
  report.trainingProgram.mappingsDeleted = (await client.query(`delete from public.race_edition_mappings where "raceEditionId"=$1`, [trainingEditionId])).rowCount;
  report.trainingProgram.editionsDeleted = (await client.query(`delete from public.race_editions where id=$1`, [trainingEditionId])).rowCount;
  const remainingEditions = Number((await client.query(`select count(*)::int as count from public.race_editions where "raceId"=$1`, [trainingRaceId])).rows[0].count);
  report.trainingProgram.racesDeleted = remainingEditions === 0 ? (await client.query(`delete from public.races where id=$1`, [trainingRaceId])).rowCount : 0;
  report.trainingProgram.sourceUrl = "https://hyderabadrunners.com/training/";
  if (report.trainingProgram.editionsDeleted !== 1) throw new Error("Train & Shine edition was not deleted");

  if (commit) await client.query("commit"); else await client.query("rollback");
  report.transaction = commit ? "committed" : "rolled_back";
} catch (error) {
  try { await client.query("rollback"); } catch {}
  report.transaction = "rolled_back_on_error";
  report.error = error.message;
  throw error;
} finally {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "_");
  const output = resolve(process.cwd(), "..", "db_quality_audits", `post_audit_evidence_${commit ? "commit" : "dry_run"}_${stamp}.json`);
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }, null, 2));
  await client.end();
}
