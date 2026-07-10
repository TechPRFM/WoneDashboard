import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(appRoot, "..");
const asOfDate = process.argv[2] || new Date().toISOString().slice(0, 10);
const outPath =
  process.argv[3] ||
  path.join(repoRoot, "db_adapter_event_exports", `upcoming_races_cleanup_report_${asOfDate}.json`);

loadEnv(path.join(appRoot, ".env.local"));

const pool = new Pool({
  connectionString:
    process.env.PG_REJECT_UNAUTHORIZED === "false"
      ? stripSslMode(process.env.DATABASE_URL)
      : process.env.DATABASE_URL,
  ssl:
    process.env.PGSSL === "disable"
      ? false
      : { rejectUnauthorized: process.env.PG_REJECT_UNAUTHORIZED !== "false" },
  max: 3,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 20_000,
});

const GENERIC_TOKENS = new Set([
  "a",
  "an",
  "and",
  "at",
  "by",
  "for",
  "from",
  "in",
  "india",
  "of",
  "on",
  "run",
  "runner",
  "runners",
  "running",
  "race",
  "marathon",
  "half",
  "ultra",
  "trail",
  "challenge",
  "event",
  "events",
  "edition",
  "championship",
  "championships",
]);

const PLACE_ALIASES = {
  bangalore: "bengaluru",
  banglore: "bengaluru",
  mysore: "mysuru",
  panchmarhi: "pachmarhi",
  tiruppur: "tirupur",
  trivandrum: "thiruvananthapuram",
  vizag: "visakhapatnam",
};

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = rawValue.replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function stripSslMode(value) {
  if (!value) return value;
  try {
    const url = new URL(value);
    url.searchParams.delete("sslmode");
    return url.toString();
  } catch {
    return value.replace(/([?&])sslmode=[^&]+&?/, "$1").replace(/[?&]$/, "");
  }
}

function ascii(value) {
  return String(value ?? "")
    .replace(/[–—]/g, "-")
    .replace(/[‘’]/g, "'")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

function tokens(value) {
  const text = ascii(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b20\d{2}\b/g, " ")
    .replace(/\b2k\d{2}\b/g, " ")
    .replace(/\b(\d+(?:\.\d+)?)\s*k\b/g, "$1k")
    .replace(/\b(\d+)(st|nd|rd|th)\b/g, " ")
    .replace(/\bedition\s*[-:]?\s*\d+\b/g, " ")
    .replace(/\bseason\s*[-:]?\s*\d+\b/g, " ")
    .replace(/[^a-z0-9.]+/g, " ");

  return text
    .split(/\s+/)
    .map((token) => token.replace(/^\.+|\.+$/g, ""))
    .filter(Boolean)
    .map((token) => PLACE_ALIASES[token] ?? token);
}

function normalize(value) {
  return tokens(value).join(" ");
}

function coreTokens(value) {
  return new Set(tokens(value).filter((token) => !GENERIC_TOKENS.has(token)));
}

function sequenceRatio(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j];
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

function overlap(a, b) {
  if (!a.size || !b.size) return null;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function yearsInText(value) {
  return Array.from(String(value ?? "").matchAll(/\b(20\d{2})\b/g)).map((match) => Number(match[1]));
}

function eventYear(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getUTCFullYear();
}

function isAgeGroupLabel(value) {
  return (
    /^(m|f|male|female|women|men)\s*\d{2}\s*[-–]\s*\d{2}$/i.test(value.trim()) ||
    /^(m|f)\s*\d{2}[-–]\d{2}$/i.test(value.trim()) ||
    /^no age$/i.test(value.trim())
  );
}

function expectedDistanceKm(label) {
  const text = label.toLowerCase();
  if (isAgeGroupLabel(label)) return null;
  if (/\bhalf\s+marathon\b/.test(text)) return 21.1;
  if (/\bmarathon\b/.test(text) && !/\bhalf\b/.test(text) && !/\bultra\b/.test(text)) return 42.195;
  const kmMatch = text.match(/\b(\d+(?:\.\d+)?)\s*k(?:m)?\b/);
  if (kmMatch) return Number(kmMatch[1]);
  const mileMatch = text.match(/\b(\d+(?:\.\d+)?)\s*(?:mi|mile|miles)\b/);
  if (mileMatch) return round3(Number(mileMatch[1]) * 1.609344);
  return null;
}

function scoreMatch(raceTitle, editionTitle) {
  const raceNorm = normalize(raceTitle);
  const editionNorm = normalize(editionTitle);
  const raceCore = coreTokens(raceTitle);
  const editionCore = coreTokens(editionTitle);
  const seq = sequenceRatio(raceNorm, editionNorm);
  const coreOverlap = overlap(raceCore, editionCore);
  const raceCoreSubset = raceCore.size >= 2 && Array.from(raceCore).every((token) => editionCore.has(token));
  const contained =
    raceNorm === editionNorm ||
    (raceNorm.length > 0 && editionNorm.length > 0 && (raceNorm.includes(editionNorm) || editionNorm.includes(raceNorm)));
  const autoLooksOkay = contained || raceCoreSubset || seq >= 0.97;
  return {
    sequenceRatio: round3(seq),
    coreTokenOverlap: coreOverlap == null ? null : round3(coreOverlap),
    autoLooksOkay,
  };
}

function cleanDate(value) {
  if (!value) return null;
  return new Date(value).toISOString().slice(0, 10);
}

function unique(values) {
  return Array.from(new Set(values.filter((value) => value != null && value !== ""))).sort();
}

function countBy(rows, keyFn) {
  const out = {};
  for (const row of rows) {
    const key = keyFn(row) ?? "UNKNOWN";
    out[key] = (out[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => String(a).localeCompare(String(b))));
}

function issue(type, severity, detail, action = "review") {
  return { type, severity, detail, action };
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is missing in admin-dashboard/.env.local");
  const client = await pool.connect();
  try {
    const editionsResult = await client.query(
      `
        select
          r.id as "raceId",
          r.title as "raceTitle",
          r.location as "raceLocation",
          r.sport as "sport",
          r."raceType" as "raceType",
          r.source as "raceSource",
          e.id as "raceEditionId",
          e.title as "raceEditionTitle",
          e.location as "raceEditionLocation",
          e.city,
          e.state,
          e.country,
          e.year,
          e."eventDate",
          e."eventEndDate",
          e.source as "editionSource"
        from public.race_editions e
        join public.races r on r.id = e."raceId"
        where
          (e."eventDate" is not null and e."eventDate"::date >= $1::date)
          or (e."eventDate" is null and e.year >= extract(year from $1::date)::int)
        order by e."eventDate" asc nulls last, e.year asc, r.title asc, e.title asc
      `,
      [asOfDate],
    );

    const editionIds = editionsResult.rows.map((row) => row.raceEditionId);
    const raceIds = unique(editionsResult.rows.map((row) => row.raceId));
    const categoriesResult = await client.query(
      `
          select id, "raceEditionId", category, title, "totalDistanceKm", "formatType", source
          from public.race_categories
          where "raceEditionId" = any($1::text[])
          order by "raceEditionId", category nulls last, title nulls last
        `,
      [editionIds],
    );
    const mappingsResult = await client.query(
      `
          select id, "raceEditionId", "raceId", "rawName", year, "adapterKey", "externalEventKey"
          from public.race_edition_mappings
          where "raceEditionId" = any($1::text[])
          order by "raceEditionId", "adapterKey", "rawName"
        `,
      [editionIds],
    );
    const countsResult = await client.query(
      `
          with result_counts as (
            select c."raceEditionId", count(res.id)::int as result_count
            from public.race_categories c
            left join public.results res on res."raceCategoryId" = c.id
            where c."raceEditionId" = any($1::text[])
            group by c."raceEditionId"
          ),
          registration_counts as (
            select "raceEditionId", count(*)::int as registration_count
            from public.registrations
            where "raceEditionId" = any($1::text[])
            group by "raceEditionId"
          )
          select
            e.id as "raceEditionId",
            coalesce(rc.result_count, 0)::int as "resultCount",
            coalesce(reg.registration_count, 0)::int as "registrationCount"
          from public.race_editions e
          left join result_counts rc on rc."raceEditionId" = e.id
          left join registration_counts reg on reg."raceEditionId" = e.id
          where e.id = any($1::text[])
        `,
      [editionIds],
    );
    const canonicalRacesResult = await client.query(
      `
          select id, title
          from public.races
          where id <> all($1::text[])
        `,
      [raceIds],
    );

    const categoriesByEdition = new Map();
    for (const category of categoriesResult.rows) {
      const bucket = categoriesByEdition.get(category.raceEditionId) ?? [];
      bucket.push({
        categoryId: category.id,
        category: category.category,
        title: category.title,
        totalDistanceKm: category.totalDistanceKm == null ? null : Number(category.totalDistanceKm),
        formatType: category.formatType,
        source: category.source,
      });
      categoriesByEdition.set(category.raceEditionId, bucket);
    }

    const mappingsByEdition = new Map();
    for (const mapping of mappingsResult.rows) {
      const bucket = mappingsByEdition.get(mapping.raceEditionId) ?? [];
      bucket.push({
        mappingId: mapping.id,
        rawName: mapping.rawName,
        year: mapping.year,
        adapterKey: mapping.adapterKey,
        externalEventKey: mapping.externalEventKey,
      });
      mappingsByEdition.set(mapping.raceEditionId, bucket);
    }

    const countsByEdition = new Map(
      countsResult.rows.map((row) => [
        row.raceEditionId,
        {
          resultCount: Number(row.resultCount ?? 0),
          registrationCount: Number(row.registrationCount ?? 0),
        },
      ]),
    );

    const canonicalRaceByNormalized = new Map();
    for (const race of canonicalRacesResult.rows) {
      const key = normalize(race.title);
      if (!key) continue;
      const bucket = canonicalRaceByNormalized.get(key) ?? [];
      bucket.push({ raceId: race.id, raceTitle: race.title });
      canonicalRaceByNormalized.set(key, bucket);
    }

    const allRows = editionsResult.rows.map((row) => {
      const categories = categoriesByEdition.get(row.raceEditionId) ?? [];
      const mappings = mappingsByEdition.get(row.raceEditionId) ?? [];
      const counts = countsByEdition.get(row.raceEditionId) ?? { resultCount: 0, registrationCount: 0 };
      const issues = [];
      const raceYears = yearsInText(row.raceTitle);
      const editionYears = yearsInText(row.raceEditionTitle);
      const uniqueEditionYears = unique(editionYears);
      const dateYear = eventYear(row.eventDate);
      const match = scoreMatch(row.raceTitle, row.raceEditionTitle);
      const adapterKeys = unique(mappings.map((mapping) => mapping.adapterKey));
      const rawNames = unique(mappings.map((mapping) => mapping.rawName));

      if (raceYears.length) {
        const canonicalKey = normalize(row.raceTitle);
        issues.push(
          issue(
            "race_title_has_year",
            "medium",
            `Race title contains year ${raceYears.join(", ")}.`,
            canonicalRaceByNormalized.has(canonicalKey) ? "move_edition_to_existing_yearless_race_then_delete_duplicate_race" : "rename_race_yearless",
          ),
        );
      }
      if (!match.autoLooksOkay && (match.coreTokenOverlap == null || match.coreTokenOverlap < 0.75) && match.sequenceRatio < 0.82) {
        issues.push(
          issue(
            "suspect_edition_match",
            "high",
            `Race title "${row.raceTitle}" and edition title "${row.raceEditionTitle}" do not look like the same event.`,
            "move_or_split_wrong_edition_not_blind_delete",
          ),
        );
      }
      if (editionYears.length > uniqueEditionYears.length) {
        issues.push(issue("edition_title_duplicate_year", "high", "Edition title repeats the same year.", "rename_edition"));
      }
      const mismatchedTitleYear = uniqueEditionYears.find((year) => Number(year) !== Number(row.year));
      if (mismatchedTitleYear) {
        issues.push(
          issue(
            "edition_title_year_mismatch",
            "high",
            `Edition title contains ${mismatchedTitleYear}, but edition.year is ${row.year}.`,
            "fix_year_or_title",
          ),
        );
      }
      if (dateYear && dateYear !== Number(row.year)) {
        issues.push(
          issue(
            "edition_year_date_mismatch",
            "high",
            `eventDate is in ${dateYear}, but edition.year is ${row.year}.`,
            "fix_year_or_date",
          ),
        );
      }
      if (!row.eventDate) {
        issues.push(issue("missing_event_date", "medium", "No eventDate, only year is available.", "find_date_or_exclude_from_upcoming"));
      }
      if (!row.raceEditionLocation && !row.city) {
        issues.push(issue("missing_location", "low", "No edition location/city.", "enrich_location"));
      }
      if (!categories.length) {
        issues.push(issue("edition_without_categories", "medium", "No race categories attached.", "add_categories_or_delete_placeholder"));
      }
      if (!mappings.length) {
        issues.push(issue("edition_without_mapping", "low", "No adapter mapping attached.", "add_mapping_or_mark_manual"));
      }

      for (const category of categories) {
        if (isAgeGroupLabel(category.category)) {
          issues.push(
            issue(
              "age_group_as_category",
              "medium",
              `Category "${category.category}" looks like age group, not race distance.`,
              "fix_category",
            ),
          );
        }
        const expected = expectedDistanceKm(`${category.category ?? ""} ${category.title ?? ""}`);
        if (category.totalDistanceKm == null && expected != null) {
          issues.push(
            issue(
              "category_missing_distance",
              "high",
              `Category "${category.category}" suggests ${expected} km but totalDistanceKm is null.`,
              "fill_totalDistanceKm",
            ),
          );
        }
        if (category.totalDistanceKm != null && expected != null) {
          const tolerance = expected >= 40 ? 0.6 : 0.25;
          if (Math.abs(Number(category.totalDistanceKm) - expected) > tolerance) {
            issues.push(
              issue(
                "category_distance_mismatch",
                "high",
                `Category "${category.category}" suggests ${expected} km but totalDistanceKm is ${category.totalDistanceKm}.`,
                "fix_totalDistanceKm",
              ),
            );
          }
        }
      }

      for (const mapping of mappings) {
        if (Number(mapping.year) !== Number(row.year)) {
          issues.push(
            issue(
              "mapping_year_mismatch",
              "high",
              `Mapping year is ${mapping.year}, but edition.year is ${row.year}.`,
              "fix_mapping_or_edition_year",
            ),
          );
        }
        const mappingMatch = scoreMatch(row.raceTitle, mapping.rawName);
        if (!mappingMatch.autoLooksOkay && mappingMatch.sequenceRatio < 0.68) {
          issues.push(
            issue(
              "mapping_title_mismatch",
              "medium",
              `Mapping rawName "${mapping.rawName}" does not look like race "${row.raceTitle}".`,
              "fix_mapping",
            ),
          );
        }
      }

      const shouldReviewForDelete =
        issues.some((item) =>
          [
            "suspect_edition_match",
            "race_title_has_year",
            "edition_year_date_mismatch",
            "edition_title_year_mismatch",
            "edition_without_categories",
          ].includes(item.type),
        ) && counts.resultCount === 0;

      return {
        raceId: row.raceId,
        raceName: row.raceTitle,
        raceSport: row.sport,
        raceType: row.raceType,
        raceSource: row.raceSource,
        raceEditionId: row.raceEditionId,
        raceEditionTitle: row.raceEditionTitle,
        raceEditionYear: Number(row.year),
        eventDate: cleanDate(row.eventDate),
        eventEndDate: cleanDate(row.eventEndDate),
        raceEditionLocation: row.raceEditionLocation,
        city: row.city,
        state: row.state,
        country: row.country,
        editionSource: row.editionSource,
        adapterKeys,
        rawNames,
        categoryCount: categories.length,
        mappingCount: mappings.length,
        resultCount: counts.resultCount,
        registrationCount: counts.registrationCount,
        categories,
        issues,
        reviewStatus: issues.length ? (shouldReviewForDelete ? "delete_or_cleanup_review" : "cleanup_review") : "looks_ok",
      };
    });

    const upcomingWithDate = allRows.filter((row) => row.eventDate);
    const yearOnlyFuture = allRows.filter((row) => !row.eventDate);
    const cleanupCandidates = allRows.filter((row) => row.reviewStatus !== "looks_ok");
    const deleteOrCleanupReviewCandidates = cleanupCandidates.filter((row) => row.reviewStatus === "delete_or_cleanup_review");

    const issueCounts = {};
    for (const row of cleanupCandidates) {
      for (const item of row.issues) {
        issueCounts[item.type] = (issueCounts[item.type] ?? 0) + 1;
      }
    }

    const report = {
      generatedAt: new Date().toISOString(),
      asOfDate,
      definition: {
        upcomingWithDate: `race_editions.eventDate >= ${asOfDate}`,
        yearOnlyFuture: `race_editions.eventDate is null and race_editions.year >= ${asOfDate.slice(0, 4)}`,
        deleteNote:
          "Rows are not deleted automatically. delete_or_cleanup_review means no results are attached and the row has a high-confidence cleanup signal.",
      },
      counts: {
        totalFutureRowsIncludingYearOnly: allRows.length,
        upcomingWithDate: upcomingWithDate.length,
        yearOnlyFutureNoDate: yearOnlyFuture.length,
        cleanupCandidates: cleanupCandidates.length,
        deleteOrCleanupReviewCandidates: deleteOrCleanupReviewCandidates.length,
        looksOk: allRows.length - cleanupCandidates.length,
      },
      breakdowns: {
        byYear: countBy(allRows, (row) => row.raceEditionYear),
        bySport: countBy(allRows, (row) => row.raceSport),
        byAdapter: countBy(
          allRows.flatMap((row) => (row.adapterKeys.length ? row.adapterKeys.map((adapterKey) => ({ adapterKey })) : [{ adapterKey: "NO_MAPPING" }])),
          (row) => row.adapterKey,
        ),
        cleanupIssueCounts: Object.fromEntries(Object.entries(issueCounts).sort(([a], [b]) => a.localeCompare(b))),
      },
      deleteOrCleanupReviewCandidates,
      cleanupCandidates,
      upcoming: upcomingWithDate,
      yearOnlyFuture,
    };

    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(
      JSON.stringify(
        {
          outPath,
          counts: report.counts,
          cleanupIssueCounts: report.breakdowns.cleanupIssueCounts,
        },
        null,
        2,
      ),
    );
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(async (error) => {
  await pool.end().catch(() => {});
  console.error(error);
  process.exitCode = 1;
});
