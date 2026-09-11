import { readFileSync } from "node:fs";
import pg from "pg";

const editionIds = process.argv.slice(2);
if (!editionIds.length) throw new Error("Pass one or more race edition IDs.");

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

try {
  await client.connect();
  const result = await client.query(`
    select re.id, re.title, re.year, re."eventDate"::date::text as "eventDate",
           re.location, re.city, re.source,
           r.id as "raceId", r.title as "raceTitle", r.location as "raceLocation",
           coalesce((select jsonb_agg(jsonb_build_object(
             'category', rc.category, 'title', rc.title, 'distanceKm', rc."totalDistanceKm", 'source', rc.source
           ) order by rc.category) from public.race_categories rc where rc."raceEditionId"=re.id), '[]') as categories,
           coalesce((select jsonb_agg(jsonb_build_object(
             'adapterKey', rem."adapterKey", 'rawName', rem."rawName", 'externalEventKey', rem."externalEventKey"
           ) order by rem."adapterKey") from public.race_edition_mappings rem where rem."raceEditionId"=re.id), '[]') as mappings,
           coalesce((select jsonb_agg(distinct jsonb_build_object(
             'source', res.source, 'timingLink', res."timingLink", 'bibNumber', res."bibNumber"
           )) from public.results res
             join public.race_categories result_category on result_category.id=res."raceCategoryId"
             where result_category."raceEditionId"=re.id), '[]') as results,
           coalesce((select jsonb_agg(distinct jsonb_build_object(
             'source', ure.source, 'timingLink', ure."timingLink", 'raceName', ure."raceName"
           )) from public.unmatched_race_entries ure where ure."matchedRaceEditionId"=re.id), '[]') as unmatched
    from public.race_editions re
    join public.races r on r.id=re."raceId"
    where re.id=any($1::text[])
    order by re.year desc, re.title
  `, [editionIds]);
  console.log(JSON.stringify(result.rows, null, 2));
} finally {
  await client.end();
}
