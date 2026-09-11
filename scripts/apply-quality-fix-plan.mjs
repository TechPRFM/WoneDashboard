import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

const args = new Set(process.argv.slice(2));
const commit = args.has("--commit");
if (!commit && !args.has("--dry-run")) throw new Error("Pass --dry-run or --commit explicitly.");

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8").replace(/^\uFEFF/, "");
for (const rawLine of envText.split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;
  const separator = line.indexOf("=");
  if (separator > 0) process.env[line.slice(0, separator)] = line.slice(separator + 1).replace(/^["']|["']$/g, "");
}

const url = new URL(process.env.DATABASE_URL);
url.searchParams.delete("sslmode");
if (process.env.DB_HOST_OVERRIDE) url.hostname = process.env.DB_HOST_OVERRIDE;
const client = new pg.Client({ connectionString: url.toString(), ssl: { rejectUnauthorized: false } });
const planPath = resolve(process.cwd(), "..", "db_quality_audits", "final_db_quality_execution_plan_20260801.json");
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const outputDir = resolve(process.cwd(), "..", "db_quality_audits");
mkdirSync(outputDir, { recursive: true });

const quote = (identifier) => `"${String(identifier).replaceAll('"', '""')}"`;
const dateOnly = (value) => value ? String(value).slice(0, 10) : null;
const normalizeCategory = (value) => String(value ?? "").toLowerCase()
  .replace(/half\s*marathon/g, "21.1 km")
  .replace(/full\s*marathon|marathon/g, "42.2 km")
  .replace(/kilomet(?:er|re)s?|kms?/g, "km")
  .replace(/[^a-z0-9.]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const report = {
  generatedAt: new Date().toISOString(),
  mode: commit ? "commit" : "dry-run",
  planPath,
  updates: { locations: 0, cities: 0, dates: 0, categoryDates: 0, malformedEntities: 0 },
  duplicateMerges: [],
  wrongGroupings: [],
  removedEmptyWrongParentRaces: [],
  validation: {},
};

async function tableExists(table) {
  const result = await client.query("select to_regclass($1) is not null as present", [`public.${table}`]);
  return result.rows[0].present;
}

async function columnsNamed(column) {
  const result = await client.query(`
    select table_name from information_schema.columns
    where table_schema='public' and column_name=$1
    order by table_name
  `, [column]);
  return result.rows.map((row) => row.table_name);
}

async function moveCategoryDependencies(oldCategoryId, targetCategoryId) {
  const tables = await columnsNamed("raceCategoryId");
  const updated = {};
  for (const table of tables) {
    if (table === "race_categories") continue;
    const result = await client.query(`update public.${quote(table)} set "raceCategoryId"=$1 where "raceCategoryId"=$2`, [targetCategoryId, oldCategoryId]);
    if (result.rowCount) updated[table] = result.rowCount;
  }
  return updated;
}

async function moveEditionDependencies(oldEditionId, targetEditionId, targetRaceId) {
  const editionTables = new Set([...(await columnsNamed("raceEditionId")), ...(await columnsNamed("matchedRaceEditionId"))]);
  const updated = {};
  for (const table of editionTables) {
    if (table === "race_editions" || table === "race_categories") continue;
    const hasRaceEdition = (await client.query(`select 1 from information_schema.columns where table_schema='public' and table_name=$1 and column_name='raceEditionId'`, [table])).rowCount > 0;
    const column = hasRaceEdition ? "raceEditionId" : "matchedRaceEditionId";
    const hasRaceId = (await client.query(`select 1 from information_schema.columns where table_schema='public' and table_name=$1 and column_name='raceId'`, [table])).rowCount > 0;
    const sql = hasRaceId
      ? `update public.${quote(table)} set ${quote(column)}=$1,"raceId"=$2 where ${quote(column)}=$3`
      : `update public.${quote(table)} set ${quote(column)}=$1 where ${quote(column)}=$2`;
    const params = hasRaceId ? [targetEditionId, targetRaceId, oldEditionId] : [targetEditionId, oldEditionId];
    const result = await client.query(sql, params);
    if (result.rowCount) updated[table] = result.rowCount;
  }
  return updated;
}

async function mergeEdition(oldEditionId, targetEditionId, targetRaceId) {
  const locked = await client.query(`select * from public.race_editions where id=any($1::text[]) for update`, [[oldEditionId, targetEditionId]]);
  if (locked.rowCount !== 2) throw new Error(`Edition merge precondition failed for ${oldEditionId} -> ${targetEditionId}`);
  const oldCategories = (await client.query(`select * from public.race_categories where "raceEditionId"=$1 order by id for update`, [oldEditionId])).rows;
  const targetCategories = (await client.query(`select * from public.race_categories where "raceEditionId"=$1 order by id for update`, [targetEditionId])).rows;
  const categoryActions = [];

  for (const oldCategory of oldCategories) {
    const oldLabels = new Set([normalizeCategory(oldCategory.category), normalizeCategory(oldCategory.title)].filter(Boolean));
    let matches = targetCategories.filter((target) => [normalizeCategory(target.category), normalizeCategory(target.title)].some((label) => oldLabels.has(label)));
    if (!matches.length && oldCategory.totalDistanceKm != null) {
      matches = targetCategories.filter((target) => target.totalDistanceKm != null && Math.abs(Number(target.totalDistanceKm) - Number(oldCategory.totalDistanceKm)) < 0.01);
    }
    if (matches.length === 1) {
      const target = matches[0];
      const dependencies = await moveCategoryDependencies(oldCategory.id, target.id);
      const deleted = await client.query(`delete from public.race_categories where id=$1`, [oldCategory.id]);
      if (deleted.rowCount !== 1) throw new Error(`Could not delete merged category ${oldCategory.id}`);
      categoryActions.push({ oldCategoryId: oldCategory.id, targetCategoryId: target.id, action: "merged", dependencies });
    } else {
      const moved = await client.query(`update public.race_categories set "raceEditionId"=$1 where id=$2`, [targetEditionId, oldCategory.id]);
      categoryActions.push({ oldCategoryId: oldCategory.id, action: "moved", rows: moved.rowCount });
    }
  }

  const dependencies = await moveEditionDependencies(oldEditionId, targetEditionId, targetRaceId);
  const remainingCategories = Number((await client.query(`select count(*)::int as count from public.race_categories where "raceEditionId"=$1`, [oldEditionId])).rows[0].count);
  if (remainingCategories) throw new Error(`Old edition ${oldEditionId} still has ${remainingCategories} categories`);
  const deleted = await client.query(`delete from public.race_editions where id=$1`, [oldEditionId]);
  if (deleted.rowCount !== 1) throw new Error(`Could not delete merged edition ${oldEditionId}`);
  return { oldEditionId, targetEditionId, categoryActions, dependencies };
}

async function moveFavoriteRaceReferences(oldRaceIds, targetRaceId) {
  if (!(await tableExists("_UserFavoriteRaces"))) return 0;
  await client.query(`delete from public."_UserFavoriteRaces" old where old."A"=any($1::text[]) and exists (select 1 from public."_UserFavoriteRaces" keep where keep."A"=$2 and keep."B"=old."B")`, [oldRaceIds, targetRaceId]);
  return (await client.query(`update public."_UserFavoriteRaces" set "A"=$1 where "A"=any($2::text[])`, [targetRaceId, oldRaceIds])).rowCount;
}

async function mergeDuplicateRaceGroup(group) {
  const allRaceIds = [group.canonicalRaceId, ...group.sourceRaceIds];
  const races = await client.query(`select * from public.races where id=any($1::text[]) for update`, [allRaceIds]);
  if (races.rowCount !== allRaceIds.length) throw new Error(`Duplicate group ${group.canonicalTitle} changed after preflight`);

  const editions = (await client.query(`select id,"raceId","eventDate"::text as "eventDate" from public.race_editions where "raceId"=any($1::text[]) order by "eventDate",id for update`, [allRaceIds])).rows;
  const byDate = new Map();
  for (const edition of editions) {
    const key = dateOnly(edition.eventDate);
    if (key) byDate.set(key, [...(byDate.get(key) ?? []), edition]);
  }
  const editionMerges = [];
  for (const rows of byDate.values()) {
    if (rows.length < 2) continue;
    const target = rows.find((row) => row.raceId === group.canonicalRaceId) ?? rows[0];
    for (const old of rows.filter((row) => row.id !== target.id)) editionMerges.push(await mergeEdition(old.id, target.id, group.canonicalRaceId));
  }

  const editionsUpdated = (await client.query(`update public.race_editions set "raceId"=$1 where "raceId"=any($2::text[])`, [group.canonicalRaceId, group.sourceRaceIds])).rowCount;
  const mappingsUpdated = (await client.query(`update public.race_edition_mappings set "raceId"=$1 where "raceId"=any($2::text[])`, [group.canonicalRaceId, group.sourceRaceIds])).rowCount;
  let reviewsUpdated = 0;
  let tagsUpdated = 0;
  if (await tableExists("race_reviews")) reviewsUpdated = (await client.query(`update public.race_reviews set "raceId"=$1 where "raceId"=any($2::text[])`, [group.canonicalRaceId, group.sourceRaceIds])).rowCount;
  if (await tableExists("race_tags")) tagsUpdated = (await client.query(`update public.race_tags set "raceId"=$1 where "raceId"=any($2::text[])`, [group.canonicalRaceId, group.sourceRaceIds])).rowCount;
  const favoritesUpdated = await moveFavoriteRaceReferences(group.sourceRaceIds, group.canonicalRaceId);

  const location = races.rows.find((row) => row.id === group.canonicalRaceId)?.location
    ?? races.rows.map((row) => row.location).find(Boolean)
    ?? null;
  await client.query(`update public.races set title=$1,location=coalesce(location,$2) where id=$3`, [group.canonicalTitle, location, group.canonicalRaceId]);
  const remainingRefs = Number((await client.query(`select count(*)::int as count from public.race_editions where "raceId"=any($1::text[])`, [group.sourceRaceIds])).rows[0].count)
    + Number((await client.query(`select count(*)::int as count from public.race_edition_mappings where "raceId"=any($1::text[])`, [group.sourceRaceIds])).rows[0].count);
  if (remainingRefs) throw new Error(`Duplicate race group ${group.canonicalTitle} still has ${remainingRefs} source references`);
  const deleted = await client.query(`delete from public.races where id=any($1::text[])`, [group.sourceRaceIds]);
  if (deleted.rowCount !== group.sourceRaceIds.length) throw new Error(`Expected ${group.sourceRaceIds.length} race deletes for ${group.canonicalTitle}, got ${deleted.rowCount}`);
  return { canonicalRaceId: group.canonicalRaceId, canonicalTitle: group.canonicalTitle, sourceRaceIds: group.sourceRaceIds, editionMerges, editionsUpdated, mappingsUpdated, reviewsUpdated, tagsUpdated, favoritesUpdated, racesDeleted: deleted.rowCount };
}

async function applyWrongGroupings(rows) {
  const canonicalByKey = new Map();
  for (const row of rows) {
    const editionResult = await client.query(`
      select re.*,r.title as "currentRaceTitle",r.location as "currentRaceLocation",r."raceType",r.source as "raceSource",r.sport
      from public.race_editions re join public.races r on r.id=re."raceId"
      where re.id=$1 and re."raceId"=$2 for update of re,r
    `, [row.editionId, row.currentRaceId]);
    if (editionResult.rowCount !== 1) throw new Error(`Wrong-grouping precondition changed for edition ${row.editionId}`);
    const edition = editionResult.rows[0];
    let targetRaceId = canonicalByKey.get(row.normalizedCanonicalKey) ?? row.existingTargetRaceId;
    let created = false;
    if (!targetRaceId) {
      targetRaceId = randomUUID();
      const location = edition.city || edition.location || null;
      await client.query(`insert into public.races (id,title,location,"raceType",source,sport) values ($1,$2,$3,$4,$5,$6)`, [targetRaceId, row.canonicalRaceTitle, location, edition.raceType, edition.raceSource, edition.sport]);
      canonicalByKey.set(row.normalizedCanonicalKey, targetRaceId);
      created = true;
    }
    const moved = await client.query(`update public.race_editions set "raceId"=$1 where id=$2`, [targetRaceId, row.editionId]);
    const mappings = await client.query(`update public.race_edition_mappings set "raceId"=$1 where "raceEditionId"=$2`, [targetRaceId, row.editionId]);
    let reviews = { rowCount: 0 };
    let tags = { rowCount: 0 };
    if (await tableExists("race_reviews")) reviews = await client.query(`update public.race_reviews set "raceId"=$1 where "raceEditionId"=$2`, [targetRaceId, row.editionId]);
    if (await tableExists("race_tags")) tags = await client.query(`update public.race_tags set "raceId"=$1 where "raceEditionId"=$2`, [targetRaceId, row.editionId]);
    report.wrongGroupings.push({ ...row, targetRaceId, created, editionRows: moved.rowCount, mappingRows: mappings.rowCount, reviewRows: reviews.rowCount, tagRows: tags.rowCount });
  }

  for (const sourceRaceId of new Set(rows.map((row) => row.currentRaceId))) {
    const counts = await client.query(`
      select
        (select count(*)::int from public.race_editions where "raceId"=$1) as editions,
        (select count(*)::int from public.race_edition_mappings where "raceId"=$1) as mappings,
        (select count(*)::int from public.race_reviews where "raceId"=$1) as reviews,
        (select count(*)::int from public.race_tags where "raceId"=$1) as tags
    `, [sourceRaceId]);
    if (Object.values(counts.rows[0]).every((value) => Number(value) === 0)) {
      const favorites = await tableExists("_UserFavoriteRaces") ? Number((await client.query(`select count(*)::int as count from public."_UserFavoriteRaces" where "A"=$1`, [sourceRaceId])).rows[0].count) : 0;
      if (!favorites) {
        const deleted = await client.query(`delete from public.races where id=$1`, [sourceRaceId]);
        if (deleted.rowCount) report.removedEmptyWrongParentRaces.push(sourceRaceId);
      }
    }
  }
}

try {
  await client.connect();
  await client.query("begin isolation level serializable");
  await client.query("select pg_advisory_xact_lock(821760214)");
  await client.query("set local statement_timeout='120s'");

  const liveCounts = await client.query(`select (select count(*)::int from public.races) races,(select count(*)::int from public.race_editions) editions,(select count(*)::int from public.race_categories) categories,(select count(*)::int from public.race_edition_mappings) mappings`);
  const expected = plan.liveCounts;
  for (const key of ["races", "editions", "categories", "mappings"]) if (Number(liveCounts.rows[0][key]) !== Number(expected[key])) throw new Error(`Live ${key} count changed: ${liveCounts.rows[0][key]} != ${expected[key]}`);

  for (const row of plan.executableAfterApproval.locationFixes) {
    const result = await client.query(`update public.race_editions set location=$1,city=coalesce(city,$2) where id=$3 and location is null and city is null`, [row.proposedLocation, row.proposedCity ?? row.proposedLocation, row.editionId]);
    report.updates.locations += result.rowCount;
  }
  for (const row of plan.executableAfterApproval.cityFixes) {
    const result = await client.query(`update public.race_editions set city=$1 where id=$2 and city is null`, [row.proposedCity, row.editionId]);
    report.updates.cities += result.rowCount;
  }
  for (const row of plan.executableAfterApproval.dateFixes) {
    const result = await client.query(`update public.race_editions set "eventDate"=$1::date,"eventEndDate"=case when "eventEndDate" is null or extract(year from "eventEndDate")=1970 then $1::date else "eventEndDate" end where id=$2 and "eventDate"::date=$3::date`, [row.afterEventDate, row.editionId, row.beforeEventDate]);
    if (result.rowCount !== 1) throw new Error(`Date precondition failed for ${row.editionId}`);
    report.updates.dates += result.rowCount;
    const categories = await client.query(`update public.race_categories set date=$1::date where "raceEditionId"=$2 and (date is null or extract(year from date)=1970)`, [row.afterEventDate, row.editionId]);
    report.updates.categoryDates += categories.rowCount;
  }

  for (const row of plan.executableAfterApproval.malformedCorrections) {
    const race = await client.query(`update public.races set title=$1,location=$2 where id=$3 and title like '%<%'`, [row.raceTitle, row.location, row.raceId]);
    const edition = await client.query(`update public.race_editions set title=$1,location=$2,city=$3,country=coalesce(country,'IN'),"eventDate"=$4::date,"eventEndDate"=$4::date where id=$5 and title like '%<%'`, [row.editionTitle, row.location, row.city, row.eventDate, row.editionId]);
    const mapping = await client.query(`update public.race_edition_mappings set "rawName"=$1,"externalEventKey"=$2,"updatedAt"=current_timestamp where id=$3 and ("rawName" like '%<%' or "externalEventKey" like '%<%')`, [row.rawName, row.externalEventKey, row.mappingId]);
    if (race.rowCount !== 1 || edition.rowCount !== 1 || mapping.rowCount !== 1) throw new Error("Malformed LongRun correction precondition failed");
    report.updates.malformedEntities += race.rowCount + edition.rowCount + mapping.rowCount;
  }

  for (const group of plan.executableAfterApproval.duplicateRaceMerges) report.duplicateMerges.push(await mergeDuplicateRaceGroup(group));
  await applyWrongGroupings(plan.executableAfterApproval.wrongGroupingFixes);

  const oldDuplicateIds = plan.executableAfterApproval.duplicateRaceMerges.flatMap((group) => group.sourceRaceIds);
  const oldDuplicatesRemaining = Number((await client.query(`select count(*)::int as count from public.races where id=any($1::text[])`, [oldDuplicateIds])).rows[0].count);
  const malformedRemaining = Number((await client.query(`select ((select count(*) from public.races where title like '%<%')+(select count(*) from public.race_editions where title like '%<%')+(select count(*) from public.race_edition_mappings where "rawName" like '%<%' or "externalEventKey" like '%<%'))::int as count`)).rows[0].count);
  const orphanCounts = await client.query(`
    select
      (select count(*)::int from public.race_editions re left join public.races r on r.id=re."raceId" where r.id is null) as editions,
      (select count(*)::int from public.race_categories rc left join public.race_editions re on re.id=rc."raceEditionId" where re.id is null) as categories,
      (select count(*)::int from public.results x left join public.race_categories rc on rc.id=x."raceCategoryId" where rc.id is null) as results,
      (select count(*)::int from public.race_edition_mappings m left join public.races r on r.id=m."raceId" left join public.race_editions re on re.id=m."raceEditionId" where r.id is null or re.id is null) as mappings
  `);
  report.validation = { oldDuplicatesRemaining, malformedRemaining, orphans: orphanCounts.rows[0] };
  if (oldDuplicatesRemaining || malformedRemaining || Object.values(orphanCounts.rows[0]).some((value) => Number(value) !== 0)) throw new Error(`Post-write validation failed: ${JSON.stringify(report.validation)}`);

  if (commit) await client.query("commit"); else await client.query("rollback");
  report.completedAt = new Date().toISOString();
  report.transaction = commit ? "committed" : "rolled_back";
} catch (error) {
  try { await client.query("rollback"); } catch {}
  report.error = { message: error.message, stack: error.stack };
  report.transaction = "rolled_back_on_error";
  throw error;
} finally {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "_");
  const reportPath = resolve(outputDir, `quality_fix_${commit ? "commit" : "dry_run"}_${stamp}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  process.stdout.write(`\nREPORT=${reportPath}\n${JSON.stringify({ mode: report.mode, transaction: report.transaction, updates: report.updates, duplicateGroups: report.duplicateMerges.length, wrongGroupings: report.wrongGroupings.length, removedEmptyWrongParentRaces: report.removedEmptyWrongParentRaces.length, validation: report.validation, error: report.error?.message }, null, 2)}\n`);
  await client.end();
}
