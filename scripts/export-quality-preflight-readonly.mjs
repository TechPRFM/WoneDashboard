import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8").replace(/^\uFEFF/, "");
for (const rawLine of envText.split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;
  const separator = line.indexOf("=");
  if (separator < 1) continue;
  process.env[line.slice(0, separator)] = line.slice(separator + 1).replace(/^["']|["']$/g, "");
}

const url = new URL(process.env.DATABASE_URL);
url.searchParams.delete("sslmode");
if (process.env.DB_HOST_OVERRIDE) url.hostname = process.env.DB_HOST_OVERRIDE;
const pool = new pg.Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: false }, max: 2 });

const outPath = new URL("../../db_quality_audits/production_quality_preflight_20260801.json", import.meta.url);
const clean = (value) => String(value ?? "").trim().toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ");
const withoutOrdinalAndYear = (value) => clean(value)
  .replace(/\b20\d{2}\b/g, " ")
  .replace(/\b\d+(?:st|nd|rd|th)\b/g, " ")
  .replace(/\bedition\b/g, " ")
  .replace(/\s+/g, " ")
  .trim();
const dateYear = (value) => {
  const match = String(value ?? "").match(/\b((?:19|20)\d{2})-\d{2}-\d{2}\b/);
  return match ? Number(match[1]) : null;
};
const tableName = (row) => row.table_name;

try {
  const [columnsResult, fkResult, racesResult, editionsResult, categoriesResult, mappingsResult, editionEvidenceResult] = await Promise.all([
    pool.query(`
      select table_name,column_name,data_type,udt_name,is_nullable,column_default
      from information_schema.columns
      where table_schema='public'
      order by table_name,ordinal_position
    `),
    pool.query(`
      select tc.table_name,kcu.column_name,ccu.table_name as foreign_table_name,
             ccu.column_name as foreign_column_name,rc.delete_rule,tc.constraint_name
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on tc.constraint_name=kcu.constraint_name and tc.table_schema=kcu.table_schema
      join information_schema.constraint_column_usage ccu
        on ccu.constraint_name=tc.constraint_name and ccu.table_schema=tc.table_schema
      join information_schema.referential_constraints rc
        on rc.constraint_name=tc.constraint_name and rc.constraint_schema=tc.table_schema
      where tc.constraint_type='FOREIGN KEY' and tc.table_schema='public'
      order by ccu.table_name,tc.table_name,kcu.column_name
    `),
    pool.query('select * from public.races order by title,id'),
    pool.query('select *,"eventDate"::text as "eventDateText" from public.race_editions order by year desc,title,id'),
    pool.query(`
      select rc.*,count(distinct res.id)::int as "resultCount"
      from public.race_categories rc
      left join public.results res on res."raceCategoryId"=rc.id
      group by rc.id
      order by rc."raceEditionId",rc.category,rc.id
    `),
    pool.query('select * from public.race_edition_mappings order by year desc,"rawName",id'),
    pool.query(`
      select re.id,
             count(distinct rc.id)::int as "categoryCount",
             count(distinct res.id)::int as "resultCount",
             count(distinct reg.id)::int as "registrationCount",
             count(distinct ure.id)::int as "matchedEntryCount",
             array_remove(array_agg(distinct res.source),null) as "resultSources",
             array_remove(array_agg(distinct res."verifiedBy"),null) as "verifiedBy",
             array_remove(array_agg(distinct res."timingLink"),null) as "timingLinks"
      from public.race_editions re
      left join public.race_categories rc on rc."raceEditionId"=re.id
      left join public.results res on res."raceCategoryId"=rc.id
      left join public.registrations reg on reg."raceEditionId"=re.id
      left join public.unmatched_race_entries ure on ure."matchedRaceEditionId"=re.id
      group by re.id
    `),
  ]);

  const races = racesResult.rows;
  const editions = editionsResult.rows;
  const categories = categoriesResult.rows;
  const mappings = mappingsResult.rows;
  const editionEvidenceById = new Map(editionEvidenceResult.rows.map((row) => [row.id, row]));
  const raceById = new Map(races.map((row) => [row.id, row]));
  const editionsByRace = new Map();
  const categoriesByEdition = new Map();
  const mappingsByEdition = new Map();
  for (const row of editions) editionsByRace.set(row.raceId, [...(editionsByRace.get(row.raceId) ?? []), row]);
  for (const row of categories) categoriesByEdition.set(row.raceEditionId, [...(categoriesByEdition.get(row.raceEditionId) ?? []), row]);
  for (const row of mappings) mappingsByEdition.set(row.raceEditionId, [...(mappingsByEdition.get(row.raceEditionId) ?? []), row]);

  const referencingFks = fkResult.rows.filter((row) => ["races", "race_editions", "race_categories"].includes(row.foreign_table_name));
  const dependencyCounts = {};
  for (const fk of referencingFks) {
    if (!dependencyCounts[fk.foreign_table_name]) dependencyCounts[fk.foreign_table_name] = {};
    const query = `select "${fk.column_name}"::text as id,count(*)::int as count from public."${fk.table_name}" where "${fk.column_name}" is not null group by "${fk.column_name}"`;
    const result = await pool.query(query);
    if (!dependencyCounts[fk.foreign_table_name][fk.table_name]) dependencyCounts[fk.foreign_table_name][fk.table_name] = {};
    for (const row of result.rows) dependencyCounts[fk.foreign_table_name][fk.table_name][row.id] = row.count;
  }

  const missingLocations = editions.filter((row) => !row.location && !row.city).map((edition) => {
    const race = raceById.get(edition.raceId);
    const siblings = editionsByRace.get(edition.raceId) ?? [];
    const siblingLocations = [...new Set(siblings.flatMap((row) => [row.city, row.location]).filter(Boolean).map(clean))];
    const mappingRows = mappingsByEdition.get(edition.id) ?? [];
    const proposed = race?.location && siblingLocations.length === 1 && siblingLocations[0] === clean(race.location) ? race.location : null;
    return {
      editionId: edition.id,
      raceId: edition.raceId,
      raceTitle: race?.title,
      editionTitle: edition.title,
      year: edition.year,
      eventDate: edition.eventDateText,
      raceLocation: race?.location,
      siblingLocations,
      mappings: mappingRows.map((row) => ({ id: row.id, rawName: row.rawName, adapterKey: row.adapterKey, externalEventKey: row.externalEventKey })),
      evidence: editionEvidenceById.get(edition.id),
      proposedLocation: proposed,
      confidence: proposed ? "deterministic_db_consensus" : "needs_source_verification",
    };
  });

  const missingCities = editions.filter((row) => !row.city && row.location).map((edition) => ({
    editionId: edition.id,
    raceId: edition.raceId,
    raceTitle: raceById.get(edition.raceId)?.title,
    editionTitle: edition.title,
    year: edition.year,
    location: edition.location,
    mappings: (mappingsByEdition.get(edition.id) ?? []).map((row) => ({ rawName: row.rawName, adapterKey: row.adapterKey, externalEventKey: row.externalEventKey })),
  }));

  const dateMismatches = editions.filter((row) => dateYear(row.eventDateText) && dateYear(row.eventDateText) !== row.year).map((edition) => ({
    editionId: edition.id,
    raceId: edition.raceId,
    raceTitle: raceById.get(edition.raceId)?.title,
    editionTitle: edition.title,
    year: edition.year,
    eventDate: edition.eventDateText,
    categories: (categoriesByEdition.get(edition.id) ?? []).map((row) => ({ id: row.id, category: row.category, date: row.date })),
    mappings: (mappingsByEdition.get(edition.id) ?? []).map((row) => ({ id: row.id, rawName: row.rawName, year: row.year, adapterKey: row.adapterKey, externalEventKey: row.externalEventKey })),
  }));

  const noCategories = editions.filter((row) => !(categoriesByEdition.get(row.id)?.length)).map((edition) => ({
    editionId: edition.id,
    raceId: edition.raceId,
    raceTitle: raceById.get(edition.raceId)?.title,
    editionTitle: edition.title,
    year: edition.year,
    eventDate: edition.eventDateText,
    location: edition.location,
    city: edition.city,
    mappings: (mappingsByEdition.get(edition.id) ?? []).map((row) => ({ id: row.id, rawName: row.rawName, adapterKey: row.adapterKey, externalEventKey: row.externalEventKey })),
    evidence: editionEvidenceById.get(edition.id),
  }));

  const noMappings = editions.filter((row) => !(mappingsByEdition.get(row.id)?.length)).map((edition) => ({
    editionId: edition.id,
    raceId: edition.raceId,
    raceTitle: raceById.get(edition.raceId)?.title,
    editionTitle: edition.title,
    year: edition.year,
    eventDate: edition.eventDateText,
    location: edition.location,
    city: edition.city,
    categoryCount: (categoriesByEdition.get(edition.id) ?? []).length,
    evidence: editionEvidenceById.get(edition.id),
  }));

  const buckets = new Map();
  for (const race of races) {
    const key = withoutOrdinalAndYear(race.title);
    if (!key) continue;
    buckets.set(key, [...(buckets.get(key) ?? []), race]);
  }
  const duplicateRaceGroups = [...buckets.entries()].filter(([, rows]) => rows.length > 1).map(([normalizedTitle, rows]) => ({
    normalizedTitle,
    races: rows.map((race) => ({
      race,
      editions: (editionsByRace.get(race.id) ?? []).map((edition) => ({
        ...edition,
        categories: categoriesByEdition.get(edition.id) ?? [],
        mappings: mappingsByEdition.get(edition.id) ?? [],
      })),
      dependencies: Object.fromEntries(Object.entries(dependencyCounts.races ?? {}).map(([table, counts]) => [table, counts[race.id] ?? 0])),
    })),
  }));

  const report = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    schema: {
      tables: [...new Set(columnsResult.rows.map(tableName))],
      columns: columnsResult.rows,
      foreignKeysReferencingCoreRaceTables: referencingFks,
    },
    counts: { races: races.length, editions: editions.length, categories: categories.length, mappings: mappings.length },
    issues: {
      missingLocations,
      missingCities,
      dateMismatches,
      noCategories,
      noMappings,
      malformedTitles: [
        ...races.filter((row) => /<\/?[a-z][^>]*>/i.test(row.title)).map((race) => ({ entity: "race", ...race })),
        ...editions.filter((row) => /<\/?[a-z][^>]*>/i.test(row.title)).map((edition) => ({ entity: "edition", ...edition, raceTitle: raceById.get(edition.raceId)?.title })),
        ...mappings.filter((row) => /<\/?[a-z][^>]*>/i.test(row.rawName) || /<\/?[a-z][^>]*>/i.test(row.externalEventKey ?? "")).map((mapping) => ({ entity: "mapping", ...mapping })),
      ],
      duplicateRaceGroups,
    },
    referenceData: {
      cities: [...new Set(editions.map((row) => row.city).filter(Boolean))].sort(),
      locations: [...new Set([...races.map((row) => row.location), ...editions.map((row) => row.location)].filter(Boolean))].sort(),
      races: races.map((row) => ({ id: row.id, title: row.title, location: row.location, sport: row.sport, raceType: row.raceType })),
    },
    dependencyCounts,
  };
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    output: outPath.pathname,
    counts: report.counts,
    issueCounts: Object.fromEntries(Object.entries(report.issues).map(([key, value]) => [key, value.length])),
    coreForeignKeys: referencingFks.length,
  }, null, 2));
} finally {
  await pool.end();
}
