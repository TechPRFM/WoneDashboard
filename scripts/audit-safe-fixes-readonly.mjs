import { readFileSync } from "node:fs";
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

const yearsIn = (value) => Array.from(String(value ?? "").matchAll(/\b(20\d{2})\b/g), (match) => Number(match[1]));
const dateYear = (value) => {
  if (!value) return null;
  const calendarYear = String(value).match(/\b((?:19|20)\d{2})-\d{2}-\d{2}\b/);
  if (calendarYear) return Number(calendarYear[1]);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getFullYear();
};
const round3 = (value) => Math.round(value * 1000) / 1000;
const clean = (value) => String(value ?? "").trim().toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ");
const withoutYears = (value) => clean(value).replace(/\b20\d{2}\b/g, " ").replace(/\b\d+(st|nd|rd|th)\s+edition\b/g, " ").replace(/\s+/g, " ").trim();
const ageGroup = (value) => /^(m|f|male|female|women|men)\s*\d{2}\s*[-–]\s*\d{2}$/i.test(String(value).trim()) || /^(m|f)\s*\d{2}[-–]\d{2}$/i.test(String(value).trim()) || /^no age$/i.test(String(value).trim());

const genericTokens = new Set(["a", "an", "and", "at", "by", "for", "from", "in", "india", "of", "on", "run", "runner", "runners", "running", "race", "marathon", "half", "ultra", "trail", "challenge", "event", "events", "edition", "championship", "championships"]);
const placeAliases = { bangalore: "bengaluru", banglore: "bengaluru", mysore: "mysuru", panchmarhi: "pachmarhi", tiruppur: "tirupur", trivandrum: "thiruvananthapuram", vizag: "visakhapatnam" };
function titleTokens(value) {
  return String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/&/g, " and ").replace(/\b20\d{2}\b/g, " ").replace(/\b2k\d{2}\b/g, " ").replace(/\b(\d+(?:\.\d+)?)\s*k\b/g, "$1k").replace(/\b(\d+)(st|nd|rd|th)\b/g, " ").replace(/\bedition\s*[-:]?\s*\d+\b/g, " ").replace(/\bseason\s*[-:]?\s*\d+\b/g, " ").replace(/[^a-z0-9.]+/g, " ").split(/\s+/).filter(Boolean).map((token) => placeAliases[token] ?? token);
}
const normalizedTitle = (value) => titleTokens(value).join(" ");
const coreTitleTokens = (value) => new Set(titleTokens(value).filter((token) => !genericTokens.has(token)));
function sequenceRatio(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j];
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}
function tokenOverlap(a, b) {
  if (!a.size || !b.size) return null;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.min(a.size, b.size);
}
function matchScore(raceTitle, editionTitle) {
  const raceNorm = normalizedTitle(raceTitle);
  const editionNorm = normalizedTitle(editionTitle);
  const raceCore = coreTitleTokens(raceTitle);
  const editionCore = coreTitleTokens(editionTitle);
  const seq = sequenceRatio(raceNorm, editionNorm);
  const overlap = tokenOverlap(raceCore, editionCore);
  const subset = raceCore.size >= 2 && Array.from(raceCore).every((token) => editionCore.has(token));
  const contained = raceNorm === editionNorm || (raceNorm && editionNorm && (raceNorm.includes(editionNorm) || editionNorm.includes(raceNorm)));
  const autoLooksOkay = contained || subset || seq >= 0.97;
  const flagged = !autoLooksOkay && (overlap == null || overlap < 0.75) && seq < 0.82;
  return { sequenceRatio: round3(seq), coreTokenOverlap: overlap == null ? null : round3(overlap), autoLooksOkay: autoLooksOkay && !flagged, flagged };
}

function dashboardExpectedDistance(value) {
  const text = String(value ?? "").toLowerCase();
  if (ageGroup(value)) return null;
  if (/\bhalf\s+marathon\b/.test(text)) return 21.1;
  if (/\bmarathon\b/.test(text) && !/\bhalf\b/.test(text) && !/\bultra\b/.test(text)) return 42.2;
  const km = text.match(/\b(\d+(?:\.\d+)?)\s*k(?:m)?\b/);
  if (km) return Number(km[1]);
  const miles = text.match(/\b(\d+(?:\.\d+)?)\s*(?:mi|mile|miles)\b/);
  return miles ? round3(Number(miles[1]) * 1.609344) : null;
}

function distancesIn(value) {
  const text = clean(value);
  if (!text || ageGroup(text)) return [];
  const values = [];
  if (/\bhalf\s+marathon\b/.test(text)) values.push(21.1);
  if (/\b(full\s+)?marathon\b/.test(text) && !/\bhalf\b/.test(text) && !/\bultra\b/.test(text)) values.push(42.2);
  for (const match of text.matchAll(/\b(\d+(?:\.\d+)?)\s*k(?:m)?\b/g)) values.push(Number(match[1]));
  for (const match of text.matchAll(/\b(\d+(?:\.\d+)?)\s*(?:mi|mile|miles)\b/g)) values.push(round3(Number(match[1]) * 1.609344));
  return Array.from(new Set(values.map(round3)));
}

const sample = (rows, fields) => rows.slice(0, 8).map((row) => Object.fromEntries(fields.map((field) => [field, row[field]])));

try {
  const [raceResult, editionResult, categoryResult, mappingResult] = await Promise.all([
    pool.query('select id,title,location,sport::text as sport,"raceType" from public.races order by title,id'),
    pool.query('select id,"raceId",title,location,city,year,"eventDate"::text as "eventDate" from public.race_editions order by year desc,title,id'),
    pool.query(`
      select rc.id,rc."raceEditionId",rc.category,rc.title,rc."totalDistanceKm",rc.date::text as date,
             count(res.id)::int as "resultCount"
      from public.race_categories rc
      left join public.results res on res."raceCategoryId"=rc.id
      group by rc.id
      order by rc."raceEditionId",rc.category,rc.id
    `),
    pool.query('select id,"rawName",year,"raceId","raceEditionId","adapterKey","externalEventKey" from public.race_edition_mappings order by year desc,"rawName",id'),
  ]);

  const races = raceResult.rows;
  const editions = editionResult.rows;
  const categories = categoryResult.rows;
  const mappings = mappingResult.rows;
  const raceById = new Map(races.map((row) => [row.id, row]));
  const editionById = new Map(editions.map((row) => [row.id, row]));
  const categoriesByEdition = new Map();
  const mappingsByEdition = new Map();
  const editionsByRace = new Map();
  for (const row of categories) categoriesByEdition.set(row.raceEditionId, [...(categoriesByEdition.get(row.raceEditionId) ?? []), row]);
  for (const row of mappings) mappingsByEdition.set(row.raceEditionId, [...(mappingsByEdition.get(row.raceEditionId) ?? []), row]);
  for (const row of editions) editionsByRace.set(row.raceId, [...(editionsByRace.get(row.raceId) ?? []), row]);

  const racesWithYear = races.filter((race) => yearsIn(race.title).length);
  const raceTitleBuckets = new Map();
  for (const race of races) raceTitleBuckets.set(withoutYears(race.title), [...(raceTitleBuckets.get(withoutYears(race.title)) ?? []), race]);
  const raceYearSafeRename = racesWithYear.filter((race) => withoutYears(race.title).length >= 3 && (raceTitleBuckets.get(withoutYears(race.title)) ?? []).length === 1);
  const raceYearNeedsMerge = racesWithYear.filter((race) => (raceTitleBuckets.get(withoutYears(race.title)) ?? []).length > 1);

  const duplicateYearEditions = editions.filter((edition) => {
    const years = yearsIn(edition.title);
    return years.length > new Set(years).size;
  });
  const titleYearMismatch = editions.filter((edition) => yearsIn(edition.title).some((year) => year !== edition.year));
  const titleYearSafe = titleYearMismatch.filter((edition) => {
    const mapRows = mappingsByEdition.get(edition.id) ?? [];
    return dateYear(edition.eventDate) === edition.year && mapRows.length > 0 && mapRows.every((mapping) => mapping.year === edition.year);
  });
  const editionDateMismatch = editions.filter((edition) => dateYear(edition.eventDate) && dateYear(edition.eventDate) !== edition.year);
  const missingDate = editions.filter((edition) => !edition.eventDate);
  const missingDateFromCategory = missingDate.filter((edition) => {
    const dates = Array.from(new Set((categoriesByEdition.get(edition.id) ?? []).map((category) => category.date).filter(Boolean)));
    return dates.length === 1 && dateYear(dates[0]) === edition.year;
  }).map((edition) => ({ ...edition, proposedEventDate: (categoriesByEdition.get(edition.id) ?? []).find((category) => category.date)?.date }));

  const missingLocation = editions.filter((edition) => !edition.location && !edition.city);
  const missingLocationFromRace = missingLocation.filter((edition) => {
    const race = raceById.get(edition.raceId);
    const siblingLocations = Array.from(new Set((editionsByRace.get(edition.raceId) ?? []).flatMap((row) => [row.city, row.location]).filter(Boolean).map(clean)));
    return race?.location && siblingLocations.length === 1 && siblingLocations[0] === clean(race.location);
  }).map((edition) => ({ ...edition, proposedLocation: raceById.get(edition.raceId)?.location }));

  const missingCity = editions.filter((edition) => !edition.city && edition.location);
  const noCategories = editions.filter((edition) => !(categoriesByEdition.get(edition.id)?.length));
  const noMappings = editions.filter((edition) => !(mappingsByEdition.get(edition.id)?.length));

  const ageCategories = categories.filter((category) => ageGroup(category.category));
  const unusedAgeCategories = ageCategories.filter((category) => Number(category.resultCount) === 0);

  const distanceCandidates = [];
  const ambiguousDistances = [];
  for (const category of categories) {
    const edition = editionById.get(category.raceEditionId);
    const race = raceById.get(edition?.raceId);
    const categoryIsEventTitle = clean(category.category) === clean(edition?.title) || clean(category.category) === clean(race?.title);
    let values = distancesIn(category.category);
    if (!values.length && category.title && !categoryIsEventTitle) values = distancesIn(category.title);
    const item = { ...category, raceTitle: race?.title, editionTitle: edition?.title, year: edition?.year, expectedValues: values };
    if (categoryIsEventTitle || values.length !== 1) {
      if (category.totalDistanceKm == null || values.length > 1) ambiguousDistances.push(item);
      continue;
    }
    const expected = values[0];
    const tolerance = expected >= 40 ? 0.6 : 0.25;
    if (category.totalDistanceKm == null || Math.abs(Number(category.totalDistanceKm) - expected) > tolerance) {
      distanceCandidates.push({ ...item, proposedDistanceKm: expected, action: category.totalDistanceKm == null ? "fill" : "correct" });
    }
  }
  const missingDistanceSafe = distanceCandidates.filter((row) => row.action === "fill");
  const mismatchDistanceSafe = distanceCandidates.filter((row) => row.action === "correct");

  const mappingYearMismatch = mappings.filter((mapping) => editionById.get(mapping.raceEditionId)?.year !== mapping.year);
  const mappingYearSafe = mappingYearMismatch.filter((mapping) => {
    const edition = editionById.get(mapping.raceEditionId);
    const evidenceYears = new Set([...yearsIn(mapping.rawName), ...yearsIn(mapping.externalEventKey)]);
    return dateYear(edition?.eventDate) === edition?.year && evidenceYears.has(edition.year) && !evidenceYears.has(mapping.year);
  });

  const exactDuplicateRaceGroups = Array.from(raceTitleBuckets.entries())
    .filter(([title, rows]) => title && rows.length > 1)
    .map(([title, rows]) => ({
      normalizedTitle: title,
      raceIds: rows.map((row) => row.id),
      raceTitles: rows.map((row) => row.title),
      years: rows.flatMap((row) => (editionsByRace.get(row.id) ?? []).map((edition) => edition.year)).sort(),
      sports: Array.from(new Set(rows.map((row) => row.sport).filter(Boolean))),
      locations: Array.from(new Set(rows.map((row) => clean(row.location)).filter(Boolean))),
    }));
  const highConfidenceMergeGroups = exactDuplicateRaceGroups.filter((group) => group.sports.length <= 1 && group.locations.length <= 1);

  const suspectEditionMatches = editions.flatMap((edition) => {
    const race = raceById.get(edition.raceId);
    const score = matchScore(race?.title, edition.title);
    return score.flagged ? [{ ...edition, raceTitle: race?.title, score }] : [];
  });
  const mappingTitleMismatches = mappings.flatMap((mapping) => {
    const edition = editionById.get(mapping.raceEditionId);
    const race = raceById.get(edition?.raceId);
    const score = matchScore(race?.title, mapping.rawName);
    return !score.autoLooksOkay && score.sequenceRatio < 0.68 ? [{ ...mapping, raceTitle: race?.title, editionTitle: edition?.title, score }] : [];
  });
  const dashboardMissingDistance = [];
  const dashboardDistanceMismatch = [];
  for (const category of categories) {
    const expected = dashboardExpectedDistance(`${category.category} ${category.title ?? ""}`);
    if (expected == null) continue;
    const edition = editionById.get(category.raceEditionId);
    const race = raceById.get(edition?.raceId);
    const item = { ...category, raceTitle: race?.title, editionTitle: edition?.title, year: edition?.year, expectedDistanceKm: expected };
    if (category.totalDistanceKm == null) dashboardMissingDistance.push(item);
    else if (Math.abs(Number(category.totalDistanceKm) - expected) > (expected >= 40 ? 0.6 : 0.25)) dashboardDistanceMismatch.push(item);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    tableCounts: { races: races.length, editions: editions.length, categories: categories.length, mappings: mappings.length },
    deterministicSafeAfterBackup: {
      categoryDistanceFillFromSingleExplicitLabel: { count: missingDistanceSafe.length, samples: sample(missingDistanceSafe, ["id", "raceTitle", "editionTitle", "year", "category", "proposedDistanceKm"]) },
      categoryDistanceCorrectionFromSingleExplicitLabel: { count: mismatchDistanceSafe.length, samples: sample(mismatchDistanceSafe, ["id", "raceTitle", "editionTitle", "year", "category", "totalDistanceKm", "proposedDistanceKm"]) },
      raceTitleRemoveYearNoCollision: { count: raceYearSafeRename.length, samples: sample(raceYearSafeRename, ["id", "title"]) },
      editionTitleRemoveRepeatedYear: { count: duplicateYearEditions.length, samples: sample(duplicateYearEditions, ["id", "raceId", "title", "year"]) },
      editionTitleCorrectYearWithDateAndMappingConsensus: { count: titleYearSafe.length, samples: sample(titleYearSafe, ["id", "raceId", "title", "year", "eventDate"]) },
      eventDateFromSingleCategoryDateSameYear: { count: missingDateFromCategory.length, samples: sample(missingDateFromCategory, ["id", "raceId", "title", "year", "proposedEventDate"]) },
      locationFromCanonicalRaceAndUnanimousSiblings: { count: missingLocationFromRace.length, samples: sample(missingLocationFromRace, ["id", "raceId", "title", "year", "proposedLocation"]) },
      mappingYearFromEditionDateAndExternalEvidence: { count: mappingYearSafe.length, samples: sample(mappingYearSafe, ["id", "rawName", "year", "raceEditionId", "externalEventKey"]) },
    },
    needsReviewNotAutoFix: {
      raceTitleYearCollisionNeedsMerge: raceYearNeedsMerge.length,
      editionTitleYearMismatchWithoutFullConsensus: titleYearMismatch.length - titleYearSafe.length,
      editionYearEventDateMismatch: editionDateMismatch.length,
      missingEventDateNoDatabaseEvidence: missingDate.length - missingDateFromCategory.length,
      missingLocationNoUnanimousDatabaseEvidence: missingLocation.length - missingLocationFromRace.length,
      displayLocationButMissingStructuredCity: missingCity.length,
      editionsWithoutCategories: noCategories.length,
      editionsWithoutMappings: noMappings.length,
      ageGroupCategoriesTotal: ageCategories.length,
      ageGroupCategoriesUnusedButStillNeedTargetCategoryReview: unusedAgeCategories.length,
      ambiguousOrEventTitleDistanceRows: ambiguousDistances.length,
      mappingYearMismatchWithoutFullConsensus: mappingYearMismatch.length - mappingYearSafe.length,
      exactNormalizedDuplicateRaceGroups: exactDuplicateRaceGroups.length,
      highConfidenceDuplicateRaceGroupsStillRequiringFkMergePlan: highConfidenceMergeGroups.length,
      suspectEditionMatches: suspectEditionMatches.length,
      mappingTitleMismatches: mappingTitleMismatches.length,
    },
    dashboardRuleTotals: {
      raceTitleHasYear: racesWithYear.length,
      editionTitleDuplicateYear: duplicateYearEditions.length,
      editionTitleYearMismatch: titleYearMismatch.length,
      editionYearDateMismatch: editionDateMismatch.length,
      missingEventDate: missingDate.length,
      missingLocation: missingLocation.length,
      missingStructuredCity: missingCity.length,
      editionWithoutCategories: noCategories.length,
      editionWithoutMapping: noMappings.length,
      ageGroupAsCategory: ageCategories.length,
      mappingYearMismatch: mappingYearMismatch.length,
      categoryMissingDistance: dashboardMissingDistance.length,
      categoryDistanceMismatch: dashboardDistanceMismatch.length,
      suspectEditionMatch: suspectEditionMatches.length,
      mappingTitleMismatch: mappingTitleMismatches.length,
    },
    reviewSamples: {
      malformedOrDuplicateYearEditionTitles: sample(duplicateYearEditions, ["id", "raceId", "title", "year"]),
      editionYearDateMismatch: sample(editionDateMismatch, ["id", "raceId", "title", "year", "eventDate"]),
      exactDuplicateRaceGroups: exactDuplicateRaceGroups.slice(0, 20),
      suspectEditionMatches: suspectEditionMatches.map((row) => Object.fromEntries(["id", "raceId", "raceTitle", "title", "year", "eventDate", "score"].map((field) => [field, row[field]]))),
      mappingTitleMismatches: sample(mappingTitleMismatches, ["id", "raceId", "raceEditionId", "raceTitle", "editionTitle", "rawName", "year", "adapterKey", "score"]),
      dashboardMissingDistance: sample(dashboardMissingDistance, ["id", "raceTitle", "editionTitle", "year", "category", "title", "totalDistanceKm", "expectedDistanceKm"]),
      dashboardDistanceMismatch: sample(dashboardDistanceMismatch, ["id", "raceTitle", "editionTitle", "year", "category", "title", "totalDistanceKm", "expectedDistanceKm"]),
    },
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  await pool.end();
}
