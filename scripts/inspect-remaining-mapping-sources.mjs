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
const editionIds = [
  "f06f68ab-3214-4c7c-886a-af7139519b69", "6a806b66-86b9-4439-850e-39d95c955caf",
  "67abfbc4-636f-4d5e-a880-171917380b7b", "6d0bfb02-7243-4829-a8aa-890fc549df9c",
  "3bf100fb-ffcd-40ca-b4e6-92fa01f48c71", "4b437bcd-6659-456e-a2d9-3420cfc69cba",
  "0e911373-93bb-4468-95b7-6000ee71e3ec", "a446edcd-02e2-4f6b-8233-77bcbfc94140",
  "ffe32eec-8901-419c-bc4c-5287eb48cd2c", "a3a76d3e-ac6c-42c8-97a6-d47bcebb248a",
  "26725d87-d876-4582-aa7e-2e700cfeb7a9", "341b17d0-a9ea-44d8-9dfe-aea509d56248",
];

await client.connect();
try {
  await client.query("begin read only");
  const rows = await client.query(`
    select re.id as "editionId",r.id as "raceId",r.title as "raceTitle",re.title as "editionTitle",
      re.year,re."eventDate"::date::text as "eventDate",re.source as "editionSource",
      reg.id as "registrationId",reg.source::text as "registrationSource",reg.status::text as "registrationStatus",
      ure.id as "ureId",ure."raceName",ure.category,ure.date::date::text as "ureDate",
      ure.source::text as "ureSource",ure.status::text as "ureStatus",ure."rawRowData"
    from public.race_editions re
    join public.races r on r.id=re."raceId"
    left join public.registrations reg on reg."raceEditionId"=re.id
    left join public.unmatched_race_entries ure on ure.id=reg."ureId"
    where re.id=any($1::text[])
    order by re."eventDate",re.id,reg.id
  `, [editionIds]);
  const matched = await client.query(`
    select "matchedRaceEditionId" as "editionId",id as "ureId","raceName",category,
      date::date::text as "ureDate",source::text as "ureSource",status::text as "ureStatus","rawRowData"
    from public.unmatched_race_entries where "matchedRaceEditionId"=any($1::text[])
    order by "matchedRaceEditionId",id
  `, [editionIds]);
  await client.query("rollback");
  const report = { generatedAt: new Date().toISOString(), registrations: rows.rows, matchedEntries: matched.rows };
  const output = resolve(process.cwd(), "..", "db_quality_audits", "remaining_mapping_source_evidence_20260802.json");
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }, null, 2));
} finally {
  await client.end();
}
