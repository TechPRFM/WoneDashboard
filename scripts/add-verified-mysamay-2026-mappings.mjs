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

const events = [
  {
    raceId: "bad75cdf-49b5-4f56-963b-9376a7d402f3",
    raceEditionId: "f06f68ab-3214-4c7c-886a-af7139519b69",
    editionTitle: "Bangalore Ultra 2026",
    eventDate: "2026-07-26",
    externalEventKey: "213855ab-1223-4f0e-8af7-9610b87e1980|Bangalore Ultra 2026|2026",
    rawNames: ["Bangalore Ultra 2026"],
    evidence: "https://mysamay.in/event/info/213855ab-1223-4f0e-8af7-9610b87e1980",
  },
  {
    raceId: "915a7c52-10a1-449d-bee9-735b875429a8",
    raceEditionId: "ffe32eec-8901-419c-bc4c-5287eb48cd2c",
    editionTitle: "Mumbai Half Marathon 2026",
    eventDate: "2026-08-30",
    externalEventKey: "3aa173cb-de29-4a2c-9051-7d5e20d32370|Mumbai Half Marathon 2026|2026",
    rawNames: ["Mumbai Half Marathon", "Mumbai Half Marathon 2026"],
    evidence: "https://mysamay.in/event/info/3aa173cb-de29-4a2c-9051-7d5e20d32370",
  },
  {
    raceId: "b0b53857-69f2-4023-a245-42e10c673ee8",
    raceEditionId: "341b17d0-a9ea-44d8-9dfe-aea509d56248",
    editionTitle: "Wipro Bengaluru Marathon 2026",
    eventDate: "2026-09-27",
    externalEventKey: "02f1f7a7-6cf0-4f1a-9f73-4ea3edfb6503|Wipro Bengaluru Marathon 2026|2026",
    rawNames: ["Wipro Bengaluru Marathon", "Wipro Bengaluru Marathon 2026"],
    evidence: "https://mysamay.in/public/event/info/02f1f7a7-6cf0-4f1a-9f73-4ea3edfb6503",
  },
];
const report = { generatedAt: new Date().toISOString(), mode: commit ? "commit" : "dry-run", events, inserted: [] };

try {
  await client.connect();
  await client.query("begin isolation level serializable");
  await client.query("select pg_advisory_xact_lock(821760214)");
  for (const event of events) {
    const edition = await client.query(`
      select id,"raceId",title,year,"eventDate"::date::text as "eventDate"
      from public.race_editions where id=$1 for update
    `, [event.raceEditionId]);
    const row = edition.rows[0];
    if (edition.rowCount !== 1 || row.raceId !== event.raceId || row.title !== event.editionTitle ||
        row.year !== 2026 || row.eventDate !== event.eventDate) {
      throw new Error(`Edition precondition failed: ${JSON.stringify(row ?? null)}`);
    }
    for (const rawName of event.rawNames) {
      const source = await client.query(`
        select ure.id from public.unmatched_race_entries ure
        left join public.registrations reg on reg."ureId"=ure.id
        where ure."raceName"=$1 and ure.year=2026
          and (ure."matchedRaceEditionId"=$2 or reg."raceEditionId"=$2)
        limit 1
      `, [rawName, event.raceEditionId]);
      if (source.rowCount !== 1) throw new Error(`Source label not linked to edition: ${rawName}`);
      const duplicate = await client.query(`select id from public.race_edition_mappings where "rawName"=$1 and year=2026`, [rawName]);
      if (duplicate.rowCount) throw new Error(`Mapping already exists for ${rawName}: ${JSON.stringify(duplicate.rows)}`);
      const inserted = await client.query(`
        insert into public.race_edition_mappings
          (id,"rawName",year,"raceId","raceEditionId","adapterKey","externalEventKey",notes,"createdAt","updatedAt")
        values (gen_random_uuid()::text,$1,2026,$2,$3,'mysamay',$4,$5,current_timestamp,current_timestamp)
        returning id,"rawName",year,"raceEditionId","adapterKey","externalEventKey"
      `, [rawName, event.raceId, event.raceEditionId, event.externalEventKey, `Verified against MySamay event page: ${event.evidence}`]);
      report.inserted.push(inserted.rows[0]);
    }
  }
  if (commit) await client.query("commit"); else await client.query("rollback");
  report.transaction = commit ? "committed" : "rolled_back";
} catch (error) {
  try { await client.query("rollback"); } catch {}
  report.transaction = "rolled_back_on_error";
  report.error = error.message;
  throw error;
} finally {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "_");
  const output = resolve(process.cwd(), "..", "db_quality_audits", `verified_mysamay_2026_mappings_${commit ? "commit" : "dry_run"}_${stamp}.json`);
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }, null, 2));
  await client.end();
}
