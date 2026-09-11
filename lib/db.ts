import { Pool, type PoolClient } from "pg";
import {
  AdapterUpcomingReviewItem,
  analyzeRaceGroup,
  DashboardData,
  RaceCategoryRow,
  RaceEditionMappingRow,
  RaceEditionNode,
  RaceEditionRow,
  RaceRow,
  UnverifiedFailedDiagnostic,
  UpcomingReviewItem,
  sortIssues,
  summarizeIssues,
} from "./quality";

type CountRow = { id: string; count: number };

type AdapterUpcomingRaw = {
  adapterKey?: string | null;
  adapterName?: string | null;
  eventName?: string | null;
  editionYear?: number | string | null;
  eventDate?: string | null;
  location?: string | null;
  city?: string | null;
  sourceId?: string | null;
  externalKeyGuess?: string | null;
  categoriesText?: string | string[] | null;
  catalogStatus?: string | null;
  proposalPayload?: unknown;
  lastSeenAt?: string | null;
};

type GlobalWithPool = typeof globalThis & {
  __woneAdminPool?: Pool;
};

function connectionString() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const host = process.env.PGHOST;
  const user = process.env.PGUSER;
  const password = process.env.PGPASSWORD;
  const database = process.env.PGDATABASE ?? "postgres";
  const port = process.env.PGPORT ?? "5432";
  if (!host || !user || !password) return null;
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}?sslmode=require`;
}

export function getPool() {
  const globalForPool = globalThis as GlobalWithPool;
  if (globalForPool.__woneAdminPool) return globalForPool.__woneAdminPool;

  const conn = connectionString();
  if (!conn) {
    throw new Error(
      "Missing DATABASE_URL. Copy admin-dashboard/.env.example to .env.local and add the production Supabase pooler URI.",
    );
  }

  const rejectUnauthorized = process.env.PG_REJECT_UNAUTHORIZED !== "false";
  const poolConnectionString = rejectUnauthorized ? conn : stripSslMode(conn);
  const pool = new Pool({
    connectionString: poolConnectionString,
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 20_000,
    ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized },
  });
  globalForPool.__woneAdminPool = pool;
  return pool;
}

function stripSslMode(value: string) {
  try {
    const url = new URL(value);
    url.searchParams.delete("sslmode");
    return url.toString();
  } catch {
    return value.replace(/([?&])sslmode=[^&]+&?/, "$1").replace(/[?&]$/, "");
  }
}

function iso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function countMap(rows: CountRow[]) {
  const out = new Map<string, number>();
  for (const row of rows) out.set(row.id, Number(row.count ?? 0));
  return out;
}

function groupBy<T, K extends string>(rows: T[], key: (row: T) => K) {
  const out = new Map<K, T[]>();
  for (const row of rows) {
    const groupKey = key(row);
    const bucket = out.get(groupKey) ?? [];
    bucket.push(row);
    out.set(groupKey, bucket);
  }
  return out;
}

function daysUntil(value: unknown): number | null {
  if (!value) return null;
  const date = new Date(String(value).slice(0, 10));
  if (Number.isNaN(date.getTime())) return null;
  const today = new Date();
  const utcToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.ceil((date.getTime() - utcToday) / 86_400_000);
}

function splitPgArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isRecent(value: unknown, days = 21): boolean {
  if (!value) return false;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return false;
  return Date.now() - parsed.getTime() <= days * 86_400_000;
}

function classifyUpcoming(row: {
  adapterKeys: string[];
  categoryCount: number;
  latestMappingCreatedAt: string | null;
  raceSource: string | null;
  editionSource: string | null;
}): Pick<UpcomingReviewItem, "reviewLevel" | "reviewMessage"> {
  const adapters = row.adapterKeys.length ? row.adapterKeys.join(", ") : "no adapter";
  if (row.adapterKeys.length && isRecent(row.latestMappingCreatedAt)) {
    return {
      reviewLevel: "new_adapter_race",
      reviewMessage: `New race from ${adapters}. Please check date, location, categories, and mapping before race day.`,
    };
  }
  if (!row.adapterKeys.length) {
    return {
      reviewLevel: "needs_mapping",
      reviewMessage: "Upcoming edition has no adapter mapping yet; add mapping or mark it as manual.",
    };
  }
  if (row.categoryCount === 0) {
    return {
      reviewLevel: "needs_categories",
      reviewMessage: `Adapter mapping exists (${adapters}), but categories are missing.`,
    };
  }
  const source = row.editionSource || row.raceSource || "";
  if (/api|adapter|screenshot|gmail|seed/i.test(source)) {
    return {
      reviewLevel: "watch",
      reviewMessage: `Upcoming edition is sourced from ${source}; quick manual review is recommended.`,
    };
  }
  return {
    reviewLevel: "ready",
    reviewMessage: "Upcoming edition has date, categories, and adapter coverage.",
  };
}

function classifyUnverified(row: {
  matchedResultId: string | null;
  matchedRaceEditionId: string | null;
  candidateRaceEditionId: string | null;
  mappingCount: number;
  adapterKeys: string[];
  verificationFailureCode: string | null;
  verificationError: string | null;
}): Pick<UnverifiedFailedDiagnostic, "diagnosis" | "action"> {
  const adapters = row.adapterKeys.length ? row.adapterKeys.join(", ") : "no adapter";
  if (row.matchedResultId) {
    return {
      diagnosis: "already_matched_result",
      action: "Result is already linked; clear or re-run verification status if the failure flag is stale.",
    };
  }
  if (row.matchedRaceEditionId && row.mappingCount > 0) {
    return {
      diagnosis: "mapping_present_adapter_failed",
      action: `Mapping exists (${adapters}). Check adapter run, external key, bib/name/category search, and error: ${row.verificationError || row.verificationFailureCode || "not captured"}.`,
    };
  }
  if (row.matchedRaceEditionId) {
    return {
      diagnosis: "matched_edition_missing_mapping",
      action: "Matched edition exists, but it has no adapter mapping. Add race_edition_mappings row first.",
    };
  }
  if (row.candidateRaceEditionId && row.mappingCount > 0) {
    return {
      diagnosis: "candidate_mapping_present_not_linked",
      action: `Likely edition has mapping (${adapters}), but the unmatched row is not linked to that edition. Link matchedRaceEditionId and retry verification.`,
    };
  }
  if (row.candidateRaceEditionId) {
    return {
      diagnosis: "candidate_missing_mapping",
      action: "Likely edition exists, but no adapter mapping is attached. Add mapping, then retry verification.",
    };
  }
  if (row.verificationFailureCode === "MAPPING_MISS" || row.verificationFailureCode === "ADAPTER_NOT_FOUND") {
    return {
      diagnosis: "mapping_missing",
      action: "No usable race edition mapping was found for this input. Map the race/year/category to an adapter event.",
    };
  }
  return {
    diagnosis: "unknown",
    action: "Open the row and inspect verificationError/rawRowData; there is not enough mapping evidence yet.",
  };
}

function countBy<T>(rows: T[], key: (row: T) => string | null | undefined): Record<string, number> {
  return rows.reduce<Record<string, number>>((acc, row) => {
    const bucket = key(row) || "UNKNOWN";
    acc[bucket] = (acc[bucket] ?? 0) + 1;
    return acc;
  }, {});
}

function dateKey(value: unknown): string | null {
  if (!value) return null;
  const text = String(value);
  const isoMatch = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (isoMatch) return isoMatch[1];
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeName(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\bbangalore\b/g, "bengaluru")
    .replace(/\bbanglore\b/g, "bengaluru")
    .replace(/\bmysore\b/g, "mysuru")
    .replace(/\b20\d{2}\b/g, " ")
    .replace(/\b2k\d{2}\b/g, " ")
    .replace(/\bedition\s*[-:]?\s*\d+\b/g, " ")
    .replace(/\bseason\s*[-:]?\s*\d+\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const MATCH_STOPWORDS = new Set([
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
  "race",
  "event",
  "edition",
]);

function titleTokens(value: unknown): string[] {
  return normalizeName(value)
    .split(" ")
    .filter((token) => token && !MATCH_STOPWORDS.has(token));
}

function titleLooksSame(left: unknown, right: unknown): boolean {
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 8 && b.includes(a)) return true;
  if (b.length >= 8 && a.includes(b)) return true;

  const aTokens = new Set(titleTokens(a));
  const bTokens = new Set(titleTokens(b));
  if (!aTokens.size || !bTokens.size) return false;
  let shared = 0;
  aTokens.forEach((token) => {
    if (bTokens.has(token)) shared += 1;
  });
  const overlap = shared / Math.min(aTokens.size, bTokens.size);
  return shared >= 2 && overlap >= 0.82;
}

function usableSourceId(value: string | null): boolean {
  if (!value) return false;
  if (value.length < 6) return false;
  if (/^https?:\/\/(www\.)?myraceindia\.com\/home\/?$/i.test(value)) return false;
  return true;
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function firstColumn(columns: Set<string>, candidates: string[]): string | null {
  return candidates.find((candidate) => columns.has(candidate)) ?? null;
}

function textSelect(column: string | null, alias: keyof AdapterUpcomingRaw): string {
  return column ? `${quoteIdent(column)}::text as ${quoteIdent(alias)}` : `null::text as ${quoteIdent(alias)}`;
}

function yearSelect(column: string | null): string {
  if (!column) return `null::int as "editionYear"`;
  return `nullif(regexp_replace(${quoteIdent(column)}::text, '[^0-9]', '', 'g'), '')::int as "editionYear"`;
}

async function loadAdapterUpcomingRowsFromDb(
  client: Pool | PoolClient,
): Promise<{ sourceTable: string | null; sourceStatus: DashboardData["adapterUpcoming"]["sourceStatus"]; rows: AdapterUpcomingRaw[] }> {
  const tableResult = await client.query<{ tableName: string | null }>(
    `select to_regclass('public.adapter_upcoming_events')::text as "tableName"`,
  );
  if (!tableResult.rows[0]?.tableName) {
    return { sourceTable: null, sourceStatus: "not_configured", rows: [] };
  }

  const columnResult = await client.query<{ columnName: string }>(`
    select column_name as "columnName"
    from information_schema.columns
    where table_schema = 'public' and table_name = 'adapter_upcoming_events'
  `);
  const columns = new Set(columnResult.rows.map((row) => row.columnName));
  const adapterKey = firstColumn(columns, ["adapterKey", "adapter_key", "adapter", "source"]);
  const eventName = firstColumn(columns, ["eventName", "event_name", "raceName", "race_name", "rawName", "raw_name", "title"]);
  if (!adapterKey || !eventName) {
    return { sourceTable: "public.adapter_upcoming_events", sourceStatus: "loaded", rows: [] };
  }

  const adapterName = firstColumn(columns, ["adapterName", "adapter_name"]);
  const editionYear = firstColumn(columns, ["editionYear", "edition_year", "year"]);
  const eventDate = firstColumn(columns, ["eventDate", "event_date", "date", "rawDate", "raw_date"]);
  const location = firstColumn(columns, ["location"]);
  const city = firstColumn(columns, ["city"]);
  const sourceId = firstColumn(columns, ["sourceId", "source_id", "eventSlug", "event_slug", "eventUrl", "event_url"]);
  const externalKeyGuess = firstColumn(columns, ["externalEventKey", "external_event_key", "externalKey", "external_key", "sourceId", "source_id"]);
  const categories = firstColumn(columns, ["categoriesText", "categories_text", "categories", "category"]);
  const catalogStatus = firstColumn(columns, ["catalogStatus", "catalog_status"]);
  const proposalPayload = firstColumn(columns, ["proposalPayload", "proposal_payload"]);
  const lastSeenAt = firstColumn(columns, ["lastSeenAt", "last_seen_at", "updatedAt", "updated_at"]);

  const rows = await client.query<AdapterUpcomingRaw>(`
    select
      ${textSelect(adapterKey, "adapterKey")},
      ${textSelect(adapterName, "adapterName")},
      ${textSelect(eventName, "eventName")},
      ${yearSelect(editionYear)},
      ${textSelect(eventDate, "eventDate")},
      ${textSelect(location, "location")},
      ${textSelect(city, "city")},
      ${textSelect(sourceId, "sourceId")},
      ${textSelect(externalKeyGuess, "externalKeyGuess")},
      ${textSelect(categories, "categoriesText")}
      ,${textSelect(catalogStatus, "catalogStatus")}
      ,${proposalPayload ? `${quoteIdent(proposalPayload)} as "proposalPayload"` : `null::jsonb as "proposalPayload"`}
      ,${textSelect(lastSeenAt, "lastSeenAt")}
    from public.adapter_upcoming_events
    order by ${eventDate ? quoteIdent(eventDate) : quoteIdent(eventName)} nulls last
    limit 2000
  `);

  return { sourceTable: "public.adapter_upcoming_events", sourceStatus: "loaded", rows: rows.rows };
}

function categoriesText(value: AdapterUpcomingRaw["categoriesText"]): string | null {
  if (Array.isArray(value)) return value.filter(Boolean).join(", ") || null;
  if (value == null) return null;
  return String(value) || null;
}

function buildAdapterUpcomingReview(params: {
  races: RaceRow[];
  editions: RaceEditionRow[];
  mappings: RaceEditionMappingRow[];
  adapterRows: AdapterUpcomingRaw[];
  sourceTable: string | null;
  sourceStatus: DashboardData["adapterUpcoming"]["sourceStatus"];
}): DashboardData["adapterUpcoming"] {
  const today = todayKey();
  const raceById = new Map(params.races.map((race) => [race.id, race]));
  const editionById = new Map(params.editions.map((edition) => [edition.id, edition]));
  const editionMeta = params.editions.map((edition) => ({
    edition,
    race: raceById.get(edition.raceId) ?? null,
    eventDate: dateKey(edition.eventDate),
  }));

  const seen = new Set<string>();
  const futureRows = params.adapterRows.filter((row) => {
    const eventDate = dateKey(row.eventDate);
    if (eventDate && eventDate < today) return false;
    const dedupeKey = [
      row.adapterKey ?? "",
      row.sourceId ?? row.externalKeyGuess ?? "",
      row.eventName ?? "",
      eventDate ?? "",
    ].join("|");
    if (seen.has(dedupeKey)) return false;
    seen.add(dedupeKey);
    return Boolean(row.adapterKey && row.eventName);
  });

  const items: AdapterUpcomingReviewItem[] = futureRows
    .map((row) => {
      const adapterKey = String(row.adapterKey);
      const adapterName = String(row.adapterName || row.adapterKey);
      const eventName = String(row.eventName || "");
      const editionYear = row.editionYear == null ? null : Number(row.editionYear);
      const eventDate = dateKey(row.eventDate);
      const sourceId = row.sourceId ? String(row.sourceId) : null;
      const externalKeyGuess = row.externalKeyGuess ? String(row.externalKeyGuess) : null;
      const sourceNeedle = [sourceId, externalKeyGuess].filter(Boolean) as string[];

      const mappingMatch = params.mappings.find((mapping) => {
        if (mapping.adapterKey !== adapterKey) return false;
        if (editionYear && Number(mapping.year) !== editionYear) return false;
        const externalEventKey = mapping.externalEventKey || "";
        if (
          sourceNeedle.some((needle) => usableSourceId(needle) && externalEventKey.includes(needle))
        ) {
          return true;
        }
        return titleLooksSame(mapping.rawName, eventName);
      });

      const mappedEdition = mappingMatch ? editionById.get(mappingMatch.raceEditionId) ?? null : null;
      const mappedRace = mappedEdition ? raceById.get(mappedEdition.raceId) ?? null : null;
      let matchedRaceTitle = mappedRace?.title ?? null;
      let matchedEditionTitle = mappedEdition?.title ?? null;
      let matchedRaceEditionId = mappedEdition?.id ?? null;
      let matchReason = mappingMatch ? "adapter mapping matched by source key/name" : "";

      if (!matchedRaceEditionId) {
        const titleDateMatch = editionMeta.find(({ edition, race, eventDate: dbDate }) => {
          if (!race) return false;
          if (editionYear && Number(edition.year) !== editionYear) return false;
          if (eventDate && dbDate && eventDate !== dbDate) return false;
          return titleLooksSame(edition.title, eventName) || titleLooksSame(race.title, eventName);
        });

        if (titleDateMatch) {
          matchedRaceTitle = titleDateMatch.race?.title ?? null;
          matchedEditionTitle = titleDateMatch.edition.title;
          matchedRaceEditionId = titleDateMatch.edition.id;
          matchReason = eventDate
            ? "DB edition matched by year/date/title"
            : "DB edition matched by year/title";
        }
      }

      const matchedInDb = Boolean(matchedRaceEditionId);
      const action: AdapterUpcomingReviewItem["action"] = matchedInDb ? "already_in_db" : "needs_add_or_review";
      return {
        adapterKey,
        adapterName,
        eventName,
        editionYear: Number.isFinite(editionYear) ? editionYear : null,
        eventDate,
        location: row.location ? String(row.location) : null,
        city: row.city ? String(row.city) : null,
        sourceId,
        externalKeyGuess,
        categoriesText: categoriesText(row.categoriesText),
        catalogStatus: row.catalogStatus ? String(row.catalogStatus) : null,
        proposalPayload: row.proposalPayload ?? null,
        lastSeenAt: row.lastSeenAt ? String(row.lastSeenAt) : null,
        matchedInDb,
        matchReason: matchReason || "not found in DB by mapping/title/date",
        matchedRaceTitle,
        matchedEditionTitle,
        matchedRaceEditionId,
        action,
      };
    })
    .sort((a, b) => {
      const dateDiff = String(a.eventDate ?? "9999-12-31").localeCompare(String(b.eventDate ?? "9999-12-31"));
      if (dateDiff) return dateDiff;
      if (a.matchedInDb !== b.matchedInDb) return a.matchedInDb ? 1 : -1;
      return a.eventName.localeCompare(b.eventName);
    });

  return {
    sourceTable: params.sourceTable,
    sourceStatus: params.sourceStatus,
    total: items.length,
    matchedInDbCount: items.filter((item) => item.matchedInDb).length,
    needsAddOrReviewCount: items.filter((item) => !item.matchedInDb).length,
    items,
  };
}

export async function getDashboardData(): Promise<DashboardData> {
  const pool = getPool();
  const client = pool;
  const [
      racesResult,
      editionsResult,
      categoriesResult,
      mappingsResult,
      tableCountsResult,
      categoryResultCountsResult,
      editionResultSourcesResult,
      registrationCountsResult,
      unmatchedCountsResult,
      upcomingResult,
      unverifiedFailedResult,
    ] = await Promise.all([
      client.query<RaceRow>(`
        select id,title,location,"raceType",sport,source,"createdBy"
        from public.races
        order by title nulls last, id
      `),
      client.query<RaceEditionRow>(`
        select id,"raceId",title,location,city,state,"stateCode",country,year,
               "eventDate"::date::text as "eventDate",
               "eventEndDate"::date::text as "eventEndDate",
               source,"createdBy","resultsLocked","resultsScrapedAt"
        from public.race_editions
        order by year desc nulls last, "eventDate" desc nulls last, title nulls last, id
      `),
      client.query<RaceCategoryRow>(`
        select id,"raceEditionId",category,title,"totalDistanceKm","itraPoint","formatType",
               date,source,"createdBy"
        from public.race_categories
        order by "raceEditionId", category nulls last, id
      `),
      client.query<RaceEditionMappingRow>(`
        select id,"rawName",year,"raceId","raceEditionId","adapterKey","externalEventKey",notes,
               "createdAt","updatedAt"
        from public.race_edition_mappings
        order by year desc nulls last, "rawName" nulls last, id
      `),
      client.query<{ table: string; count: number }>(`
        select 'races' as table, count(*)::int as count from public.races
        union all select 'race_editions', count(*)::int from public.race_editions
        union all select 'race_categories', count(*)::int from public.race_categories
        union all select 'race_edition_mappings', count(*)::int from public.race_edition_mappings
        union all select 'results', count(*)::int from public.results
        union all select 'splits', count(*)::int from public.splits
        union all select 'rank_info', count(*)::int from public.rank_info
        union all select 'registrations', count(*)::int from public.registrations
        union all select 'unmatched_race_entries', count(*)::int from public.unmatched_race_entries
      `),
      client.query<CountRow>(`
        select "raceCategoryId" as id, count(*)::int as count
        from public.results
        group by "raceCategoryId"
      `),
      client.query<{ id: string; sources: string[] | null }>(`
        select rc."raceEditionId" as id,
               coalesce(array_remove(array_agg(distinct res.source::text), null), '{}') as sources
        from public.race_categories rc
        join public.results res on res."raceCategoryId" = rc.id
        group by rc."raceEditionId"
      `),
      client.query<CountRow>(`
        select "raceEditionId" as id, count(*)::int as count
        from public.registrations
        group by "raceEditionId"
      `),
      client.query<CountRow>(`
        select "matchedRaceEditionId" as id, count(*)::int as count
        from public.unmatched_race_entries
        where "matchedRaceEditionId" is not null
        group by "matchedRaceEditionId"
      `),
      client.query<{
        raceId: string;
        raceTitle: string;
        sport: string | null;
        raceType: string | null;
        raceSource: string | null;
        raceEditionId: string;
        editionTitle: string;
        editionSource: string | null;
        eventDate: string | null;
        eventEndDate: string | null;
        location: string | null;
        city: string | null;
        state: string | null;
        country: string | null;
        categoryCount: number;
        resultCount: number;
        registrationCount: number;
        adapterKeys: string[] | null;
        mappingRawNames: string[] | null;
        latestMappingCreatedAt: string | null;
        latestMappingUpdatedAt: string | null;
      }>(`
        select
          r.id as "raceId",
          r.title as "raceTitle",
          r.sport::text as sport,
          r."raceType",
          r.source as "raceSource",
          re.id as "raceEditionId",
          re.title as "editionTitle",
          re.source as "editionSource",
          re."eventDate"::date::text as "eventDate",
          re."eventEndDate"::date::text as "eventEndDate",
          re.location,
          re.city,
          re.state,
          re.country,
          count(distinct rc.id)::int as "categoryCount",
          count(distinct res.id)::int as "resultCount",
          count(distinct reg.id)::int as "registrationCount",
          coalesce(array_remove(array_agg(distinct rem."adapterKey" order by rem."adapterKey"), null), '{}') as "adapterKeys",
          coalesce(array_remove(array_agg(distinct rem."rawName" order by rem."rawName"), null), '{}') as "mappingRawNames",
          max(rem."createdAt")::text as "latestMappingCreatedAt",
          max(rem."updatedAt")::text as "latestMappingUpdatedAt"
        from public.race_editions re
        join public.races r on r.id = re."raceId"
        left join public.race_categories rc on rc."raceEditionId" = re.id
        left join public.results res on res."raceCategoryId" = rc.id
        left join public.registrations reg on reg."raceEditionId" = re.id
        left join public.race_edition_mappings rem on rem."raceEditionId" = re.id
        where coalesce(re."eventEndDate", re."eventDate")::date >= current_date
        group by r.id, re.id
        order by re."eventDate" asc nulls last, r.title asc
      `),
      client.query<{
        id: string;
        raceName: string | null;
        year: number | null;
        bib: string | null;
        name: string | null;
        category: string | null;
        source: string | null;
        sport: string | null;
        status: string | null;
        verificationStatus: string | null;
        verificationFailureCode: string | null;
        verificationError: string | null;
        verificationAttempts: number | null;
        scrapeCount: number | null;
        scrapedAt: string | null;
        date: string | null;
        timingLink: string | null;
        matchedRaceEditionId: string | null;
        matchedResultId: string | null;
        matchedRaceTitle: string | null;
        matchedEditionTitle: string | null;
        matchedEventDate: string | null;
        candidateRaceEditionId: string | null;
        candidateRaceTitle: string | null;
        candidateEditionTitle: string | null;
        candidateEventDate: string | null;
        adapterKeys: string[] | null;
        mappingCount: number;
      }>(`
        with failed as (
          select *
          from public.unmatched_race_entries ure
          where ure."verificationStatus"::text = 'FAILED'
             or ure."verificationFailureCode" is not null
          order by ure."updatedAt" desc nulls last, ure."createdAt" desc nulls last
        )
        select
          f.id,
          f."raceName",
          f.year,
          f.bib,
          f.name,
          f.category,
          f.source::text as source,
          f.sport::text as sport,
          f.status::text as status,
          f."verificationStatus"::text as "verificationStatus",
          f."verificationFailureCode",
          f."verificationError",
          f."verificationAttempts",
          f."scrapeCount",
          f."scrapedAt"::text as "scrapedAt",
          f.date::date::text as date,
          f."timingLink",
          f."matchedRaceEditionId",
          f."matchedResultId",
          mr.title as "matchedRaceTitle",
          mre.title as "matchedEditionTitle",
          mre."eventDate"::date::text as "matchedEventDate",
          cand."raceEditionId" as "candidateRaceEditionId",
          cand."raceTitle" as "candidateRaceTitle",
          cand."editionTitle" as "candidateEditionTitle",
          cand."eventDate" as "candidateEventDate",
          coalesce(matched_maps."adapterKeys", cand."adapterKeys", '{}') as "adapterKeys",
          coalesce(matched_maps."mappingCount", cand."mappingCount", 0)::int as "mappingCount"
        from failed f
        left join public.race_editions mre on mre.id = f."matchedRaceEditionId"
        left join public.races mr on mr.id = mre."raceId"
        left join lateral (
          select
            count(rem.id)::int as "mappingCount",
            coalesce(array_remove(array_agg(distinct rem."adapterKey" order by rem."adapterKey"), null), '{}') as "adapterKeys"
          from public.race_edition_mappings rem
          where rem."raceEditionId" = f."matchedRaceEditionId"
        ) matched_maps on f."matchedRaceEditionId" is not null
        left join lateral (
          select
            re2.id as "raceEditionId",
            r2.title as "raceTitle",
            re2.title as "editionTitle",
            re2."eventDate"::date::text as "eventDate",
            count(rem2.id)::int as "mappingCount",
            coalesce(array_remove(array_agg(distinct rem2."adapterKey" order by rem2."adapterKey"), null), '{}') as "adapterKeys"
          from public.race_editions re2
          join public.races r2 on r2.id = re2."raceId"
          left join public.race_edition_mappings rem2 on rem2."raceEditionId" = re2.id
          where f."matchedRaceEditionId" is null
            and re2.year = f.year
            and (
              lower(r2.title) = lower(f."raceName")
              or lower(re2.title) = lower(f."raceName")
              or lower(r2.title) like '%' || lower(f."raceName") || '%'
              or lower(f."raceName") like '%' || lower(r2.title) || '%'
            )
          group by re2.id, r2.id
          order by
            case when lower(r2.title) = lower(f."raceName") then 0 else 1 end,
            count(rem2.id) desc,
            re2."eventDate" desc nulls last
          limit 1
        ) cand on true
      `),
    ]);

    const resultCountsByCategory = countMap(categoryResultCountsResult.rows);
    const resultSourcesByEdition = new Map(
      editionResultSourcesResult.rows.map((row) => [row.id, splitPgArray(row.sources)]),
    );
    const registrationCountsByEdition = countMap(registrationCountsResult.rows);
    const unmatchedCountsByEdition = countMap(unmatchedCountsResult.rows);

    const categories = categoriesResult.rows.map((category) => ({
      ...category,
      date: iso(category.date),
      resultCount: resultCountsByCategory.get(category.id) ?? 0,
    }));
    const editions = editionsResult.rows.map((edition) => ({
      ...edition,
      eventDate: iso(edition.eventDate),
      eventEndDate: iso(edition.eventEndDate),
      resultsScrapedAt: iso(edition.resultsScrapedAt),
    }));

    const categoriesByEdition = groupBy(categories, (row) => row.raceEditionId);
    const mappingsByEdition = groupBy(mappingsResult.rows, (row) => row.raceEditionId);
    const editionsByRace = groupBy(editions, (row) => row.raceId);

    const groups = racesResult.rows.map((race) => {
      const editionNodes = (editionsByRace.get(race.id) ?? []).map((edition) => {
        const editionCategories = categoriesByEdition.get(edition.id) ?? [];
        const mappings = mappingsByEdition.get(edition.id) ?? [];
        const node: RaceEditionNode = {
          ...edition,
          categories: editionCategories,
          mappings,
          resultCount: editionCategories.reduce((sum, category) => sum + (category.resultCount ?? 0), 0),
          resultSources: resultSourcesByEdition.get(edition.id) ?? [],
          registrationCount: registrationCountsByEdition.get(edition.id) ?? 0,
          unmatchedEntryCount: unmatchedCountsByEdition.get(edition.id) ?? 0,
          issues: [],
          score: {
            raceNormalizedTitle: "",
            editionNormalizedTitle: "",
            raceCoreTokens: [],
            editionCoreTokens: [],
            sequenceRatio: 0,
            coreTokenOverlap: null,
            autoLooksOkay: true,
            reasons: [],
          },
        };
        return node;
      });
      return analyzeRaceGroup({ race, editions: editionNodes });
    });

    const issues = sortIssues(groups.flatMap((group) => group.issues));
    const counts = Object.fromEntries(tableCountsResult.rows.map((row) => [row.table, Number(row.count)]));

    const adapterBuckets = mappingsResult.rows.reduce((map, mapping) => {
        const item = map.get(mapping.adapterKey) ?? {
          adapterKey: mapping.adapterKey,
          mappings: 0,
          editions: new Set<string>(),
          races: new Set<string>(),
        };
        item.mappings += 1;
        item.editions.add(mapping.raceEditionId);
        item.races.add(mapping.raceId);
        map.set(mapping.adapterKey, item);
        return map;
      }, new Map<string, { adapterKey: string; mappings: number; editions: Set<string>; races: Set<string> }>());
    const adapterSummary = Array.from(adapterBuckets.values())
      .map((item) => ({
        adapterKey: item.adapterKey,
        mappings: item.mappings,
        editions: item.editions.size,
        races: item.races.size,
      }))
      .sort((a, b) => b.mappings - a.mappings);

    const issueCountByEdition = new Map<string, number>();
    for (const issue of issues) {
      if (!issue.editionId) continue;
      issueCountByEdition.set(issue.editionId, (issueCountByEdition.get(issue.editionId) ?? 0) + 1);
    }
    const categoriesByYear = new Map<number, number>();
    const resultsByYear = new Map<number, number>();
    for (const group of groups) {
      for (const edition of group.editions) {
        categoriesByYear.set(edition.year, (categoriesByYear.get(edition.year) ?? 0) + edition.categories.length);
        resultsByYear.set(edition.year, (resultsByYear.get(edition.year) ?? 0) + edition.resultCount);
      }
    }
    const yearBuckets = editions.reduce((map, edition) => {
        const item = map.get(edition.year) ?? { year: edition.year, editions: 0, issues: 0 };
        item.editions += 1;
        item.issues += issueCountByEdition.get(edition.id) ?? 0;
        map.set(edition.year, item);
        return map;
      }, new Map<number, { year: number; editions: number; issues: number }>());
    const yearSummary = Array.from(yearBuckets.values())
      .map((item) => ({
        ...item,
        categories: categoriesByYear.get(item.year) ?? 0,
        results: resultsByYear.get(item.year) ?? 0,
      }))
      .sort((a, b) => b.year - a.year);

    const upcomingItems: UpcomingReviewItem[] = upcomingResult.rows.map((row) => {
      const adapterKeys = splitPgArray(row.adapterKeys);
      const mappingRawNames = splitPgArray(row.mappingRawNames);
      const base = {
        ...row,
        adapterKeys,
        mappingRawNames,
        eventDate: iso(row.eventDate),
        eventEndDate: iso(row.eventEndDate),
        latestMappingCreatedAt: iso(row.latestMappingCreatedAt),
        latestMappingUpdatedAt: iso(row.latestMappingUpdatedAt),
        daysUntil: daysUntil(row.eventDate),
      };
      return { ...base, ...classifyUpcoming(base) };
    });

    const unverifiedFailedItems: UnverifiedFailedDiagnostic[] = unverifiedFailedResult.rows.map((row) => {
      const adapterKeys = splitPgArray(row.adapterKeys);
      const base = {
        ...row,
        adapterKeys,
        date: iso(row.date),
        scrapedAt: iso(row.scrapedAt),
        matchedEventDate: iso(row.matchedEventDate),
        candidateEventDate: iso(row.candidateEventDate),
        mappingCount: Number(row.mappingCount ?? 0),
      };
      return { ...base, ...classifyUnverified(base) };
    });

    const adapterUpcomingSource = await loadAdapterUpcomingRowsFromDb(client);
    const adapterUpcoming = buildAdapterUpcomingReview({
      races: racesResult.rows,
      editions,
      mappings: mappingsResult.rows,
      adapterRows: adapterUpcomingSource.rows,
      sourceTable: adapterUpcomingSource.sourceTable,
      sourceStatus: adapterUpcomingSource.sourceStatus,
    });

  return {
      generatedAt: new Date().toISOString(),
      counts,
      issueSummary: summarizeIssues(issues),
      facets: {
        sports: Array.from(new Set(racesResult.rows.map((race) => race.sport ?? "UNKNOWN"))).sort(),
        adapterKeys: Array.from(
          new Set([
            ...adapterSummary.map((adapter) => adapter.adapterKey),
            ...adapterUpcoming.items.map((item) => item.adapterKey),
          ]),
        ).sort(),
        years: yearSummary.map((year) => year.year),
      },
      groups,
      issues,
      adapterSummary,
      yearSummary,
      upcomingReview: {
        total: upcomingItems.length,
        newAdapterCount: upcomingItems.filter((item) => item.reviewLevel === "new_adapter_race").length,
        needsMappingCount: upcomingItems.filter((item) => item.reviewLevel === "needs_mapping").length,
        needsCategoryCount: upcomingItems.filter((item) => item.reviewLevel === "needs_categories").length,
        items: upcomingItems,
      },
      adapterUpcoming,
      unverifiedFailed: {
        total: unverifiedFailedItems.length,
        byDiagnosis: countBy(unverifiedFailedItems, (item) => item.diagnosis),
        byFailureCode: countBy(unverifiedFailedItems, (item) => item.verificationFailureCode),
        items: unverifiedFailedItems,
      },
  };
}
