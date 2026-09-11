import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

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

await client.connect();
try {
  await client.query("begin read only");
  const editions = await client.query(`
    select re.*, r.title as "raceTitle",
      (select count(*)::int from public.race_categories rc where rc."raceEditionId"=re.id) as "categoryCount",
      (select count(*)::int from public.registrations reg where reg."raceEditionId"=re.id) as "registrationCount",
      (select count(*)::int from public.race_edition_mappings rem where rem."raceEditionId"=re.id) as "mappingCount",
      (select count(*)::int from public.unmatched_race_entries ure where ure."matchedRaceEditionId"=re.id) as "unmatchedCount"
    from public.race_editions re
    join public.races r on r.id=re."raceId"
    where re.id=any($1::text[])
    order by re."eventDate"
  `, [["955a9f34-c432-40d9-8d9d-29ab67972f68", "0e911373-93bb-4468-95b7-6000ee71e3ec"]]);
  const categories = await client.query(`
    select rc.*,
      (select count(*)::int from public.results res where res."raceCategoryId"=rc.id) as "resultCount",
      (select count(*)::int from public.registrations reg where reg."raceCategoryId"=rc.id) as "registrationCount"
    from public.race_categories rc where rc."raceEditionId"=any($1::text[])
    order by rc."raceEditionId",rc.category
  `, [["955a9f34-c432-40d9-8d9d-29ab67972f68", "0e911373-93bb-4468-95b7-6000ee71e3ec"]]);
  const registrations = await client.query(`
    select reg.id,reg."raceEditionId",reg."raceCategoryId",reg.status::text,reg.source::text,
      reg."eventDate"::date::text as "eventDate",reg."ureId",reg."resultId",reg."createdAt"::text as "createdAt",
      ure."raceName",ure.year,ure.category,ure."distanceKm",ure.sport::text as sport,
      ure.date::date::text as date,ure.location,ure.city,ure.source::text as "ureSource",
      ure.status::text as "ureStatus",ure."rawRowData",ure.notes
    from public.registrations reg
    left join public.unmatched_race_entries ure on ure.id=reg."ureId"
    where reg."raceEditionId"=any($1::text[])
    order by reg."createdAt"
  `, [["955a9f34-c432-40d9-8d9d-29ab67972f68", "0e911373-93bb-4468-95b7-6000ee71e3ec"]]);
  const unmatched = await client.query(`
    select id,"raceName",year,category,"distanceKm",sport::text,date::date::text as date,
      location,city,source::text,status::text,"matchedRaceEditionId","rawRowData",notes
    from public.unmatched_race_entries
    where "matchedRaceEditionId"=any($1::text[])
    order by "createdAt"
  `, [["955a9f34-c432-40d9-8d9d-29ab67972f68", "0e911373-93bb-4468-95b7-6000ee71e3ec"]]);
  const mappings = await client.query(`
    select * from public.race_edition_mappings
    where "raceEditionId"=any($1::text[])
    order by "createdAt"
  `, [["955a9f34-c432-40d9-8d9d-29ab67972f68", "0e911373-93bb-4468-95b7-6000ee71e3ec"]]);
  await client.query("rollback");
  const report = { generatedAt: new Date().toISOString(), editions: editions.rows, categories: categories.rows, registrations: registrations.rows, unmatched: unmatched.rows, mappings: mappings.rows };
  const output = resolve(process.cwd(), "..", "db_quality_audits", "hyrox_bengaluru_edition_evidence_20260802.json");
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }, null, 2));
} finally {
  await client.end();
}
