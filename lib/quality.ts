export type Severity = "critical" | "high" | "medium" | "low" | "info";

export type IssueType =
  | "suspect_edition_match"
  | "race_title_has_year"
  | "edition_title_duplicate_year"
  | "edition_title_year_mismatch"
  | "edition_year_date_mismatch"
  | "missing_event_date"
  | "missing_location"
  | "missing_structured_city"
  | "edition_without_categories"
  | "edition_without_mapping"
  | "category_missing_distance"
  | "category_distance_mismatch"
  | "age_group_as_category"
  | "mapping_year_mismatch"
  | "mapping_title_mismatch";

export interface RaceRow {
  id: string;
  title: string;
  location: string | null;
  raceType: string | null;
  sport: string | null;
  source: string | null;
  createdBy: string | null;
}

export interface RaceEditionRow {
  id: string;
  raceId: string;
  title: string;
  location: string | null;
  city: string | null;
  state: string | null;
  stateCode: string | null;
  country: string | null;
  year: number;
  eventDate: string | null;
  eventEndDate: string | null;
  source: string | null;
  createdBy: string | null;
  resultsLocked: boolean;
  resultsScrapedAt: string | null;
}

export interface RaceCategoryRow {
  id: string;
  raceEditionId: string;
  category: string;
  title: string;
  totalDistanceKm: number | null;
  itraPoint: number | null;
  formatType: string | null;
  date: string | null;
  source: string | null;
  createdBy: string | null;
  resultCount?: number;
}

export interface RaceEditionMappingRow {
  id: string;
  rawName: string;
  year: number;
  raceId: string;
  raceEditionId: string;
  adapterKey: string;
  externalEventKey: string | null;
  notes: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface UpcomingReviewItem {
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
  adapterKeys: string[];
  mappingRawNames: string[];
  latestMappingCreatedAt: string | null;
  latestMappingUpdatedAt: string | null;
  daysUntil: number | null;
  reviewLevel: "new_adapter_race" | "needs_mapping" | "needs_categories" | "ready" | "watch";
  reviewMessage: string;
}

export interface AdapterUpcomingReviewItem {
  adapterKey: string;
  adapterName: string;
  eventName: string;
  editionYear: number | null;
  eventDate: string | null;
  location: string | null;
  city: string | null;
  sourceId: string | null;
  externalKeyGuess: string | null;
  categoriesText: string | null;
  matchedInDb: boolean;
  matchReason: string;
  matchedRaceTitle: string | null;
  matchedEditionTitle: string | null;
  matchedRaceEditionId: string | null;
  action: "already_in_db" | "needs_add_or_review";
}

export interface UnverifiedFailedDiagnostic {
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
  adapterKeys: string[];
  mappingCount: number;
  diagnosis:
    | "mapping_missing"
    | "matched_edition_missing_mapping"
    | "mapping_present_adapter_failed"
    | "candidate_mapping_present_not_linked"
    | "candidate_missing_mapping"
    | "already_matched_result"
    | "unknown";
  action: string;
}

export interface DashboardIssue {
  id: string;
  type: IssueType;
  severity: Severity;
  title: string;
  detail: string;
  entity: "race" | "edition" | "category" | "mapping";
  raceId?: string;
  raceTitle?: string;
  editionId?: string;
  editionTitle?: string;
  categoryId?: string;
  categoryTitle?: string;
  mappingId?: string;
  adapterKey?: string;
  year?: number;
  meta?: unknown;
}

export interface RaceEditionGroup {
  race: RaceRow;
  editions: RaceEditionNode[];
  summary: {
    editionCount: number;
    categoryCount: number;
    mappingCount: number;
    resultCount: number;
    registrationCount: number;
    unmatchedEntryCount: number;
    years: number[];
    adapterKeys: string[];
    issueCount: number;
    highestSeverity: Severity | null;
  };
  issues: DashboardIssue[];
}

export interface RaceEditionNode extends RaceEditionRow {
  categories: RaceCategoryRow[];
  mappings: RaceEditionMappingRow[];
  resultCount: number;
  registrationCount: number;
  unmatchedEntryCount: number;
  issues: DashboardIssue[];
  score: EditionScore;
}

export interface EditionScore {
  raceNormalizedTitle: string;
  editionNormalizedTitle: string;
  raceCoreTokens: string[];
  editionCoreTokens: string[];
  sequenceRatio: number;
  coreTokenOverlap: number | null;
  autoLooksOkay: boolean;
  reasons: string[];
}

export interface DashboardData {
  generatedAt: string;
  counts: Record<string, number>;
  issueSummary: {
    total: number;
    bySeverity: Record<string, number>;
    byType: Record<string, number>;
  };
  facets: {
    sports: string[];
    adapterKeys: string[];
    years: number[];
  };
  groups: RaceEditionGroup[];
  issues: DashboardIssue[];
  adapterSummary: Array<{ adapterKey: string; mappings: number; editions: number; races: number }>;
  yearSummary: Array<{ year: number; editions: number; categories: number; results: number; issues: number }>;
  upcomingReview: {
    total: number;
    newAdapterCount: number;
    needsMappingCount: number;
    needsCategoryCount: number;
    items: UpcomingReviewItem[];
  };
  adapterUpcoming: {
    sourceTable: string | null;
    sourceStatus: "loaded" | "not_configured";
    total: number;
    matchedInDbCount: number;
    needsAddOrReviewCount: number;
    items: AdapterUpcomingReviewItem[];
  };
  unverifiedFailed: {
    total: number;
    byDiagnosis: Record<string, number>;
    byFailureCode: Record<string, number>;
    items: UnverifiedFailedDiagnostic[];
  };
}

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

const PLACE_ALIASES: Record<string, string> = {
  bangalore: "bengaluru",
  banglore: "bengaluru",
  mysore: "mysuru",
  panchmarhi: "pachmarhi",
  tiruppur: "tirupur",
  trivandrum: "thiruvananthapuram",
  vizag: "visakhapatnam",
};

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

function ascii(value: unknown): string {
  return String(value ?? "")
    .replace(/[–—]/g, "-")
    .replace(/[‘’]/g, "'")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

function tokens(value: unknown): string[] {
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

function normalize(value: unknown): string {
  return tokens(value).join(" ");
}

function coreTokens(value: unknown): Set<string> {
  return new Set(tokens(value).filter((token) => !GENERIC_TOKENS.has(token)));
}

function sequenceRatio(a: string, b: string): number {
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
  const distance = previous[b.length];
  return 1 - distance / Math.max(a.length, b.length);
}

function overlap(a: Set<string>, b: Set<string>): number | null {
  if (!a.size || !b.size) return null;
  let shared = 0;
  a.forEach((token) => {
    if (b.has(token)) shared += 1;
  });
  return shared / Math.min(a.size, b.size);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function scoreEditionMatch(race: RaceRow, edition: RaceEditionRow): EditionScore {
  const raceNorm = normalize(race.title);
  const editionNorm = normalize(edition.title);
  const raceCore = coreTokens(race.title);
  const editionCore = coreTokens(edition.title);
  const seq = sequenceRatio(raceNorm, editionNorm);
  const coreOverlap = overlap(raceCore, editionCore);
  const raceCoreSubset =
    raceCore.size >= 2 && Array.from(raceCore).every((token) => editionCore.has(token));
  const contained =
    raceNorm === editionNorm ||
    (raceNorm.length > 0 && editionNorm.length > 0 && (raceNorm.includes(editionNorm) || editionNorm.includes(raceNorm)));

  const autoLooksOkay = contained || raceCoreSubset || seq >= 0.97;
  const reasons: string[] = [];
  if (!autoLooksOkay && (coreOverlap == null || coreOverlap < 0.75) && seq < 0.82) {
    reasons.push("Edition title only partially matches race title; likely fuzzy-link cleanup candidate.");
  }

  return {
    raceNormalizedTitle: raceNorm,
    editionNormalizedTitle: editionNorm,
    raceCoreTokens: Array.from(raceCore).sort(),
    editionCoreTokens: Array.from(editionCore).sort(),
    sequenceRatio: round3(seq),
    coreTokenOverlap: coreOverlap == null ? null : round3(coreOverlap),
    autoLooksOkay: autoLooksOkay && reasons.length === 0,
    reasons,
  };
}

function makeIssue(
  type: IssueType,
  severity: Severity,
  title: string,
  detail: string,
  entity: DashboardIssue["entity"],
  refs: Partial<DashboardIssue>,
): DashboardIssue {
  const idParts = [type, refs.raceId, refs.editionId, refs.categoryId, refs.mappingId]
    .filter(Boolean)
    .join(":");
  return { id: idParts, type, severity, title, detail, entity, ...refs };
}

function yearsInText(value: string): number[] {
  return Array.from(value.matchAll(/\b(20\d{2})\b/g)).map((match) => Number(match[1]));
}

function eventYear(value: string | null): number | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getUTCFullYear();
}

function isAgeGroupLabel(value: string): boolean {
  return /^(m|f|male|female|women|men)\s*\d{2}\s*[-–]\s*\d{2}$/i.test(value.trim()) ||
    /^(m|f)\s*\d{2}[-–]\d{2}$/i.test(value.trim()) ||
    /^no age$/i.test(value.trim());
}

function expectedDistanceKm(label: string): number | null {
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

function highestSeverity(issues: DashboardIssue[]): Severity | null {
  let best: Severity | null = null;
  for (const issue of issues) {
    if (!best || SEVERITY_RANK[issue.severity] > SEVERITY_RANK[best]) best = issue.severity;
  }
  return best;
}

export function analyzeRaceGroup(group: Omit<RaceEditionGroup, "issues" | "summary">): RaceEditionGroup {
  const groupIssues: DashboardIssue[] = [];
  const raceYears = yearsInText(group.race.title);
  if (raceYears.length) {
    groupIssues.push(
      makeIssue(
        "race_title_has_year",
        "medium",
        "Race title contains an edition year",
        "Canonical race cards should usually be yearless so future editions group under the same race.",
        "race",
        { raceId: group.race.id, raceTitle: group.race.title, year: raceYears[0] },
      ),
    );
  }

  const editions = group.editions.map((edition) => {
    const issues: DashboardIssue[] = [];
    const score = scoreEditionMatch(group.race, edition);
    if (score.reasons.length) {
      issues.push(
        makeIssue(
          "suspect_edition_match",
          "medium",
          "Edition may be under the wrong race",
          score.reasons.join(" "),
          "edition",
          {
            raceId: group.race.id,
            raceTitle: group.race.title,
            editionId: edition.id,
            editionTitle: edition.title,
            year: edition.year,
            meta: score,
          },
        ),
      );
    }

    const titleYears = yearsInText(edition.title);
    const uniqueTitleYears = Array.from(new Set(titleYears));
    if (titleYears.length > uniqueTitleYears.length) {
      issues.push(
        makeIssue(
          "edition_title_duplicate_year",
          "high",
          "Edition title repeats the same year",
          "This often comes from seed/import code appending a year to a title that already had it.",
          "edition",
          {
            raceId: group.race.id,
            raceTitle: group.race.title,
            editionId: edition.id,
            editionTitle: edition.title,
            year: edition.year,
          },
        ),
      );
    }
    const mismatchedTitleYear = uniqueTitleYears.find((year) => year !== edition.year);
    if (mismatchedTitleYear) {
      issues.push(
        makeIssue(
          "edition_title_year_mismatch",
          "high",
          "Edition title year differs from edition.year",
          `Title contains ${mismatchedTitleYear}, but edition.year is ${edition.year}.`,
          "edition",
          {
            raceId: group.race.id,
            raceTitle: group.race.title,
            editionId: edition.id,
            editionTitle: edition.title,
            year: edition.year,
          },
        ),
      );
    }
    const dateYear = eventYear(edition.eventDate);
    if (dateYear && dateYear !== edition.year) {
      issues.push(
        makeIssue(
          "edition_year_date_mismatch",
          "high",
          "Edition year differs from event date year",
          `eventDate is in ${dateYear}, but edition.year is ${edition.year}.`,
          "edition",
          {
            raceId: group.race.id,
            raceTitle: group.race.title,
            editionId: edition.id,
            editionTitle: edition.title,
            year: edition.year,
          },
        ),
      );
    }
    if (!edition.eventDate) {
      issues.push(
        makeIssue(
          "missing_event_date",
          "medium",
          "Edition is missing eventDate",
          "Date-based grouping and upcoming/past flows need eventDate.",
          "edition",
          {
            raceId: group.race.id,
            raceTitle: group.race.title,
            editionId: edition.id,
            editionTitle: edition.title,
            year: edition.year,
          },
        ),
      );
    }
    if (!edition.location && !edition.city) {
      issues.push(
        makeIssue(
          "missing_location",
          "low",
          "Edition has no location",
          "The dashboard can still show it, but user-facing matching/search becomes weaker.",
          "edition",
          {
            raceId: group.race.id,
            raceTitle: group.race.title,
            editionId: edition.id,
            editionTitle: edition.title,
            year: edition.year,
          },
        ),
      );
    } else if (!edition.city) {
      issues.push(
        makeIssue(
          "missing_structured_city",
          "low",
          "Edition has display location but no structured city",
          "City-level filters and geo matching need the city column.",
          "edition",
          {
            raceId: group.race.id,
            raceTitle: group.race.title,
            editionId: edition.id,
            editionTitle: edition.title,
            year: edition.year,
          },
        ),
      );
    }
    if (!edition.categories.length) {
      issues.push(
        makeIssue(
          "edition_without_categories",
          "medium",
          "Edition has no categories",
          "Users cannot anchor registrations/results to a distance until at least one category exists.",
          "edition",
          {
            raceId: group.race.id,
            raceTitle: group.race.title,
            editionId: edition.id,
            editionTitle: edition.title,
            year: edition.year,
          },
        ),
      );
    }
    if (!edition.mappings.length) {
      issues.push(
        makeIssue(
          "edition_without_mapping",
          "low",
          "Edition has no adapter mapping",
          "Flow A cannot deterministically route this edition to a timing adapter.",
          "edition",
          {
            raceId: group.race.id,
            raceTitle: group.race.title,
            editionId: edition.id,
            editionTitle: edition.title,
            year: edition.year,
          },
        ),
      );
    }

    for (const category of edition.categories) {
      if (isAgeGroupLabel(category.category)) {
        issues.push(
          makeIssue(
            "age_group_as_category",
            "medium",
            "Category looks like an age group, not a race category",
            "This usually happens when an external source's age-group bucket was imported as the category.",
            "category",
            {
              raceId: group.race.id,
              raceTitle: group.race.title,
              editionId: edition.id,
              editionTitle: edition.title,
              categoryId: category.id,
              categoryTitle: category.category,
              year: edition.year,
            },
          ),
        );
      }
      const expected = expectedDistanceKm(`${category.category} ${category.title ?? ""}`);
      if (category.totalDistanceKm == null && expected != null) {
        issues.push(
          makeIssue(
            "category_missing_distance",
            "high",
            "Distance category is missing totalDistanceKm",
            `Category label suggests ${expected} km.`,
            "category",
            {
              raceId: group.race.id,
              raceTitle: group.race.title,
              editionId: edition.id,
              editionTitle: edition.title,
              categoryId: category.id,
              categoryTitle: category.category,
              year: edition.year,
              meta: { expectedDistanceKm: expected },
            },
          ),
        );
      }
      if (category.totalDistanceKm != null && expected != null) {
        const tolerance = expected >= 40 ? 0.6 : 0.25;
        if (Math.abs(category.totalDistanceKm - expected) > tolerance) {
          issues.push(
            makeIssue(
              "category_distance_mismatch",
              "high",
              "Category distance does not match label",
              `Label suggests ${expected} km, but totalDistanceKm is ${category.totalDistanceKm}.`,
              "category",
              {
                raceId: group.race.id,
                raceTitle: group.race.title,
                editionId: edition.id,
                editionTitle: edition.title,
                categoryId: category.id,
                categoryTitle: category.category,
                year: edition.year,
                meta: { expectedDistanceKm: expected, actualDistanceKm: category.totalDistanceKm },
              },
            ),
          );
        }
      }
    }

    for (const mapping of edition.mappings) {
      if (mapping.year !== edition.year) {
        issues.push(
          makeIssue(
            "mapping_year_mismatch",
            "high",
            "Adapter mapping year differs from edition year",
            `Mapping year is ${mapping.year}, but edition.year is ${edition.year}.`,
            "mapping",
            {
              raceId: group.race.id,
              raceTitle: group.race.title,
              editionId: edition.id,
              editionTitle: edition.title,
              mappingId: mapping.id,
              adapterKey: mapping.adapterKey,
              year: edition.year,
            },
          ),
        );
      }
      const mappingScore = scoreEditionMatch(group.race, {
        ...edition,
        title: mapping.rawName,
      });
      if (!mappingScore.autoLooksOkay && mappingScore.sequenceRatio < 0.68) {
        issues.push(
          makeIssue(
            "mapping_title_mismatch",
            "medium",
            "Mapping rawName does not look like this race",
            "This can indicate a wrong RaceEditionMapping row or over-aggressive fuzzy alias.",
            "mapping",
            {
              raceId: group.race.id,
              raceTitle: group.race.title,
              editionId: edition.id,
              editionTitle: edition.title,
              mappingId: mapping.id,
              adapterKey: mapping.adapterKey,
              year: edition.year,
              meta: mappingScore,
            },
          ),
        );
      }
    }

    groupIssues.push(...issues);
    return { ...edition, issues, score };
  });

  const adapterKeys = Array.from(new Set(editions.flatMap((edition) => edition.mappings.map((m) => m.adapterKey)))).sort();
  const years = Array.from(new Set(editions.map((edition) => edition.year))).sort((a, b) => b - a);
  return {
    race: group.race,
    editions,
    issues: groupIssues,
    summary: {
      editionCount: editions.length,
      categoryCount: editions.reduce((sum, edition) => sum + edition.categories.length, 0),
      mappingCount: editions.reduce((sum, edition) => sum + edition.mappings.length, 0),
      resultCount: editions.reduce((sum, edition) => sum + edition.resultCount, 0),
      registrationCount: editions.reduce((sum, edition) => sum + edition.registrationCount, 0),
      unmatchedEntryCount: editions.reduce((sum, edition) => sum + edition.unmatchedEntryCount, 0),
      years,
      adapterKeys,
      issueCount: groupIssues.length,
      highestSeverity: highestSeverity(groupIssues),
    },
  };
}

export function summarizeIssues(issues: DashboardIssue[]) {
  const bySeverity: Record<string, number> = {};
  const byType: Record<string, number> = {};
  for (const issue of issues) {
    bySeverity[issue.severity] = (bySeverity[issue.severity] ?? 0) + 1;
    byType[issue.type] = (byType[issue.type] ?? 0) + 1;
  }
  return { total: issues.length, bySeverity, byType };
}

export function sortIssues(issues: DashboardIssue[]): DashboardIssue[] {
  return [...issues].sort((a, b) => {
    const severityDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (severityDiff) return severityDiff;
    return a.title.localeCompare(b.title);
  });
}
