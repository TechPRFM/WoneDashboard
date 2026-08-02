"use client";

import { useMemo, useState, type ReactNode } from "react";
import type { DashboardData, DashboardIssue, IssueType, RaceEditionGroup, Severity } from "../lib/quality";

const SEVERITIES: Array<Severity | "all"> = ["all", "critical", "high", "medium", "low", "info"];
const UPCOMING_REVIEW_LEVELS: Array<DashboardData["upcomingReview"]["items"][number]["reviewLevel"] | "all"> = [
  "all",
  "new_adapter_race",
  "needs_mapping",
  "needs_categories",
  "watch",
  "ready",
];

const ISSUE_LABELS: Record<IssueType, string> = {
  age_group_as_category: "Age group as category",
  category_distance_mismatch: "Distance mismatch",
  category_missing_distance: "Missing distance",
  edition_title_duplicate_year: "Duplicate year in title",
  edition_title_year_mismatch: "Title year mismatch",
  edition_without_categories: "No categories",
  edition_without_mapping: "No adapter mapping",
  edition_year_date_mismatch: "Year/date mismatch",
  mapping_title_mismatch: "Mapping title mismatch",
  mapping_year_mismatch: "Mapping year mismatch",
  missing_event_date: "Missing event date",
  missing_location: "Missing location",
  missing_structured_city: "Missing city",
  race_title_has_year: "Race title has year",
  suspect_edition_match: "Wrong race grouping",
};

function number(value: number | undefined) {
  return new Intl.NumberFormat("en-IN").format(value ?? 0);
}

function dateOnly(value: string | null | undefined) {
  if (!value) return "No date";
  return value.slice(0, 10);
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (value == null) return [];
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [String(value)].filter(Boolean);
}

function severityClass(value: Severity | null | undefined) {
  return value ? `severity severity-${value}` : "severity severity-clean";
}

function issueLabel(issue: DashboardIssue) {
  return ISSUE_LABELS[issue.type] ?? issue.type;
}

function textBlob(group: RaceEditionGroup) {
  return [
    group.race.title,
    group.race.location,
    group.race.sport,
    group.race.raceType,
    ...group.editions.flatMap((edition) => [
      edition.title,
      edition.location,
      edition.city,
      edition.state,
      ...edition.categories.map((category) => `${category.category} ${category.title ?? ""}`),
      ...edition.mappings.map((mapping) => `${mapping.rawName} ${mapping.adapterKey}`),
    ]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function upcomingBlob(item: DashboardData["upcomingReview"]["items"][number]) {
  return [
    item.raceTitle,
    item.editionTitle,
    item.location,
    item.city,
    item.state,
    item.country,
    item.sport,
    item.raceType,
    item.reviewLevel,
    item.reviewMessage,
    ...list(item.adapterKeys),
    ...list(item.mappingRawNames),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function adapterUpcomingBlob(item: DashboardData["adapterUpcoming"]["items"][number]) {
  return [
    item.eventName,
    item.adapterKey,
    item.adapterName,
    item.location,
    item.city,
    item.eventDate,
    item.editionYear,
    item.categoriesText,
    item.matchReason,
    item.matchedRaceTitle,
    item.matchedEditionTitle,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function failedBlob(item: DashboardData["unverifiedFailed"]["items"][number]) {
  return [
    item.raceName,
    item.name,
    item.bib,
    item.category,
    item.source,
    item.status,
    item.verificationStatus,
    item.verificationFailureCode,
    item.verificationError,
    item.diagnosis,
    item.action,
    item.matchedRaceTitle,
    item.matchedEditionTitle,
    item.candidateRaceTitle,
    item.candidateEditionTitle,
    ...list(item.adapterKeys),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function useFilteredGroups(data: DashboardData, filters: Filters) {
  return useMemo(() => {
    const query = filters.query.trim().toLowerCase();
    return data.groups
      .filter((group) => {
        if (query && !textBlob(group).includes(query)) return false;
        if (filters.sport !== "all" && (group.race.sport ?? "UNKNOWN") !== filters.sport) return false;
        if (filters.adapter !== "all" && !group.summary.adapterKeys.includes(filters.adapter)) return false;
        if (filters.year !== "all" && !group.summary.years.includes(Number(filters.year))) return false;
        if (filters.onlyIssues && group.summary.issueCount === 0) return false;
        if (filters.severity !== "all" && !group.issues.some((issue) => issue.severity === filters.severity)) {
          return false;
        }
        if (filters.issueType !== "all" && !group.issues.some((issue) => issue.type === filters.issueType)) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (a.summary.issueCount !== b.summary.issueCount) return b.summary.issueCount - a.summary.issueCount;
        return b.summary.resultCount - a.summary.resultCount;
      });
  }, [data.groups, filters]);
}

function useFilteredUpcoming(data: DashboardData, filters: Filters) {
  return useMemo(() => {
    return data.upcomingReview.items
      .filter((item) => {
        if (filters.upcomingStatus !== "all" && item.reviewLevel !== filters.upcomingStatus) return false;
        return true;
      })
      .sort((a, b) => {
        const rank = { new_adapter_race: 0, needs_mapping: 1, needs_categories: 2, watch: 3, ready: 4 };
        return rank[a.reviewLevel] - rank[b.reviewLevel] || (a.daysUntil ?? 9999) - (b.daysUntil ?? 9999);
      });
  }, [data.upcomingReview.items, filters.upcomingStatus]);
}

function useFilteredAdapterUpcoming(data: DashboardData) {
  return useMemo(() => {
    return data.adapterUpcoming.items
      .filter((item) => !item.matchedInDb)
      .sort((a, b) => String(a.eventDate ?? "9999-12-31").localeCompare(String(b.eventDate ?? "9999-12-31")));
  }, [data.adapterUpcoming.items]);
}

function useFilteredFailed(data: DashboardData, filters: Filters) {
  return useMemo(() => {
    return data.unverifiedFailed.items
      .filter((item) => {
        if (filters.failedDiagnosis !== "all" && item.diagnosis !== filters.failedDiagnosis) return false;
        return true;
      })
      .sort((a, b) => String(a.diagnosis).localeCompare(String(b.diagnosis)) || String(a.raceName).localeCompare(String(b.raceName)));
  }, [data.unverifiedFailed.items, filters.failedDiagnosis]);
}

type Filters = {
  query: string;
  severity: Severity | "all";
  issueType: IssueType | "all";
  sport: string;
  adapter: string;
  year: string;
  upcomingStatus: DashboardData["upcomingReview"]["items"][number]["reviewLevel"] | "all";
  failedDiagnosis: string;
  onlyIssues: boolean;
};

function MetricCard({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone: "ink" | "ember" | "fern" | "sky" | "gold";
}) {
  return (
    <article className={`metric metric-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function FilterChip({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button className={active ? "filter-chip active" : "filter-chip"} type="button" onClick={onClick}>
      {children}
    </button>
  );
}

function FilterBar({
  data,
  filters,
  setFilters,
}: {
  data: DashboardData;
  filters: Filters;
  setFilters: (next: Filters) => void;
}) {
  const issueTypes = Object.keys(data.issueSummary.byType).sort() as IssueType[];
  const raceFiltersActive = Boolean(
    filters.query ||
    filters.severity !== "all" ||
    filters.issueType !== "all" ||
    filters.sport !== "all" ||
    filters.adapter !== "all" ||
    filters.year !== "all" ||
    filters.onlyIssues
  );
  return (
    <section className="filter-bar">
      <label className="search-field">
        <span>Race object filters</span>
        <input
          value={filters.query}
          onChange={(event) => setFilters({ ...filters, query: event.target.value })}
          placeholder="Search race, edition, category, or adapter..."
        />
      </label>
      <div className="filter-grid">
        <label>
          Severity
          <select
            value={filters.severity}
            onChange={(event) => setFilters({ ...filters, severity: event.target.value as Filters["severity"] })}
          >
            {SEVERITIES.map((severity) => (
              <option key={severity} value={severity}>
                {severity === "all" ? "All severities" : severity}
              </option>
            ))}
          </select>
        </label>
        <label>
          Issue
          <select
            value={filters.issueType}
            onChange={(event) => setFilters({ ...filters, issueType: event.target.value as Filters["issueType"] })}
          >
            <option value="all">All issue types</option>
            {issueTypes.map((type) => (
              <option key={type} value={type}>
                {ISSUE_LABELS[type] ?? type}
              </option>
            ))}
          </select>
        </label>
        <label>
          Sport
          <select value={filters.sport} onChange={(event) => setFilters({ ...filters, sport: event.target.value })}>
            <option value="all">All sports</option>
            {data.facets.sports.map((sport) => (
              <option key={sport} value={sport}>
                {sport}
              </option>
            ))}
          </select>
        </label>
        <label>
          Adapter
          <select value={filters.adapter} onChange={(event) => setFilters({ ...filters, adapter: event.target.value })}>
            <option value="all">All adapters</option>
            {data.facets.adapterKeys.map((adapter) => (
              <option key={adapter} value={adapter}>
                {adapter}
              </option>
            ))}
          </select>
        </label>
        <label>
          Year
          <select value={filters.year} onChange={(event) => setFilters({ ...filters, year: event.target.value })}>
            <option value="all">All years</option>
            {data.facets.years.map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </select>
        </label>
        <label>
          Race visibility
          <select
            value={filters.onlyIssues ? "issues" : "all"}
            onChange={(event) => setFilters({ ...filters, onlyIssues: event.target.value === "issues" })}
          >
            <option value="all">All race objects</option>
            <option value="issues">Issues only</option>
          </select>
        </label>
        <button
          className={raceFiltersActive ? "toggle active" : "toggle"}
          disabled={!raceFiltersActive}
          onClick={() =>
            setFilters({
              ...filters,
              query: "",
              severity: "all",
              issueType: "all",
              sport: "all",
              adapter: "all",
              year: "all",
              onlyIssues: false,
            })
          }
          type="button"
        >
          {raceFiltersActive ? "Clear race filters" : "All races selected"}
        </button>
      </div>
    </section>
  );
}

function IssueSummary({ data }: { data: DashboardData }) {
  const topTypes = Object.entries(data.issueSummary.byType)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 9);
  return (
    <section className="issue-board">
      <div>
        <p className="eyebrow">Quality radar</p>
        <h2>{number(data.issueSummary.total)} flags</h2>
      </div>
      <div className="severity-stack">
        {SEVERITIES.filter((item) => item !== "all").map((severity) => (
          <span key={severity} className={severityClass(severity as Severity)}>
            {severity}: {number(data.issueSummary.bySeverity[severity] ?? 0)}
          </span>
        ))}
      </div>
      <div className="issue-type-grid">
        {topTypes.map(([type, count]) => (
          <span key={type}>
            {ISSUE_LABELS[type as IssueType] ?? type}
            <strong>{number(count)}</strong>
          </span>
        ))}
      </div>
    </section>
  );
}

function AdapterRail({ data }: { data: DashboardData }) {
  return (
    <section className="adapter-rail">
      <div className="section-title">
        <p className="eyebrow">Adapters</p>
        <h2>Routing coverage</h2>
      </div>
      {data.adapterSummary.slice(0, 10).map((adapter) => (
        <article key={adapter.adapterKey}>
          <strong>{adapter.adapterKey}</strong>
          <span>{number(adapter.mappings)} mappings</span>
          <small>
            {number(adapter.races)} races / {number(adapter.editions)} editions
          </small>
        </article>
      ))}
    </section>
  );
}

function reviewTone(level: DashboardData["upcomingReview"]["items"][number]["reviewLevel"]) {
  if (level === "new_adapter_race") return "review-new";
  if (level === "needs_mapping") return "review-missing";
  if (level === "needs_categories") return "review-warn";
  if (level === "watch") return "review-watch";
  return "review-ready";
}

function UpcomingReviewPanel({
  data,
  items,
  adapterItems,
  filters,
  setFilters,
}: {
  data: DashboardData;
  items: DashboardData["upcomingReview"]["items"];
  adapterItems: DashboardData["adapterUpcoming"]["items"];
  filters: Filters;
  setFilters: (next: Filters) => void;
}) {
  const [shownDbItems, setShownDbItems] = useState(30);
  const [shownAdapterItems, setShownAdapterItems] = useState(30);
  const allItems = data.upcomingReview.items;
  const countByStatus = (status: DashboardData["upcomingReview"]["items"][number]["reviewLevel"]) =>
    allItems.filter((item) => item.reviewLevel === status).length;
  const adapterSourceCounts = data.adapterUpcoming.items.reduce<Record<string, number>>((acc, item) => {
    acc[item.adapterKey] = (acc[item.adapterKey] ?? 0) + 1;
    return acc;
  }, {});
  const adaptersWithSourceRows = Object.keys(adapterSourceCounts).length;
  const checkedAdapterCount = data.adapterSummary.length || data.facets.adapterKeys.length;

  return (
    <section className="review-panel upcoming-panel">
      <div className="section-title">
        <div>
          <p className="eyebrow">Upcoming radar</p>
          <h2>{number(items.length)} upcoming races in DB</h2>
          <p className="section-help">
            DB upcoming total: {number(data.upcomingReview.total)}. Adapter-source upcoming in DB: {number(data.adapterUpcoming.total)}.
            Matched: {number(data.adapterUpcoming.matchedInDbCount)}. Missing/add-check: {number(data.adapterUpcoming.needsAddOrReviewCount)}.
          </p>
        </div>
        <div className="click-filter-row">
          <FilterChip
            active={filters.upcomingStatus === "all"}
            onClick={() => setFilters({ ...filters, upcomingStatus: "all" })}
          >
            All upcoming: {number(data.upcomingReview.total)}
          </FilterChip>
          <FilterChip
            active={filters.upcomingStatus === "new_adapter_race"}
            onClick={() => setFilters({ ...filters, upcomingStatus: "new_adapter_race" })}
          >
            Recently mapped: {number(countByStatus("new_adapter_race"))}
          </FilterChip>
          <FilterChip
            active={filters.upcomingStatus === "needs_mapping"}
            onClick={() => setFilters({ ...filters, upcomingStatus: "needs_mapping" })}
          >
            Need mapping: {number(countByStatus("needs_mapping"))}
          </FilterChip>
          <FilterChip
            active={filters.upcomingStatus === "needs_categories"}
            onClick={() => setFilters({ ...filters, upcomingStatus: "needs_categories" })}
          >
            Need categories: {number(countByStatus("needs_categories"))}
          </FilterChip>
          <FilterChip
            active={filters.upcomingStatus === "ready"}
            onClick={() => setFilters({ ...filters, upcomingStatus: "ready" })}
          >
            Ready: {number(countByStatus("ready"))}
          </FilterChip>
        </div>
      </div>
      <div className="review-subsection">
        <div className="review-subtitle">
          <strong>Already in DB</strong>
          <span>Showing all {number(items.length)} rows after filters</span>
        </div>
        <div className="review-list">
          {items.slice(0, shownDbItems).map((item) => (
            <article key={item.raceEditionId} className={`review-row ${reviewTone(item.reviewLevel)}`}>
              <div>
                <span className="review-kicker">
                  {dateOnly(item.eventDate)}
                  {item.daysUntil != null ? ` / ${item.daysUntil} days` : ""}
                </span>
                <strong>{item.editionTitle}</strong>
                <p>{item.reviewMessage}</p>
              </div>
              <div className="review-meta">
                <span>{item.city || item.location || "No location"}</span>
                <span>{list(item.adapterKeys).length ? list(item.adapterKeys).join(", ") : "NO_MAPPING"}</span>
                <span>{number(item.categoryCount)} categories</span>
              </div>
            </article>
          ))}
          {!items.length && <p className="empty">No DB upcoming rows match these filters.</p>}
          {shownDbItems < items.length && (
            <button className="ghost" type="button" onClick={() => setShownDbItems((value) => value + 30)}>
              Show 30 more ({number(items.length - shownDbItems)} remaining)
            </button>
          )}
        </div>
      </div>
      <div className="review-subsection adapter-subsection">
        <div className="review-subtitle">
          <strong>From adapter, not in DB yet</strong>
          <span>
            {number(adapterItems.length)} visible / {number(data.adapterUpcoming.needsAddOrReviewCount)} to check.
            Checked {number(checkedAdapterCount)} DB adapters, {number(adaptersWithSourceRows)} have current source rows
            {data.adapterUpcoming.sourceTable ? ` from ${data.adapterUpcoming.sourceTable}` : " - no DB source table configured"}
          </span>
        </div>
        {data.adapterUpcoming.items.length > 0 && (
          <div className="source-count-row">
            {Object.entries(adapterSourceCounts)
              .sort((a, b) => b[1] - a[1])
              .map(([adapter, count]) => (
                <span key={adapter}>
                  {adapter}: {number(count)}
                </span>
              ))}
          </div>
        )}
        <div className="review-list compact-list">
          {adapterItems.slice(0, shownAdapterItems).map((item) => (
            <article key={`${item.adapterKey}:${item.sourceId ?? item.eventName}:${item.eventDate ?? ""}`} className="review-row adapter-row">
              <div>
                <span className="review-kicker">
                  {dateOnly(item.eventDate)} / {item.adapterName}
                </span>
                <strong>{item.eventName}</strong>
                <p>{item.matchReason}. Add/check race, edition, mapping, and categories before race day.</p>
              </div>
              <div className="review-meta">
                <span>{item.city || item.location || "No location"}</span>
                <span>{item.adapterKey}</span>
                <span>{item.categoriesText || "No categories in feed"}</span>
              </div>
            </article>
          ))}
          {!adapterItems.length && (
            <p className="empty">
              {data.adapterUpcoming.sourceStatus === "not_configured"
                ? "DB-only mode: no public.adapter_upcoming_events table exists yet, so this tab cannot list adapter-only upcoming races."
                : "No unmatched adapter-upcoming rows for these filters."}
            </p>
          )}
          {shownAdapterItems < adapterItems.length && (
            <button className="ghost" type="button" onClick={() => setShownAdapterItems((value) => value + 30)}>
              Show 30 more ({number(adapterItems.length - shownAdapterItems)} remaining)
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function diagnosisLabel(value: string) {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function UnverifiedFailedPanel({
  data,
  items,
  filters,
  setFilters,
}: {
  data: DashboardData;
  items: DashboardData["unverifiedFailed"]["items"];
  filters: Filters;
  setFilters: (next: Filters) => void;
}) {
  const [shownItems, setShownItems] = useState(50);
  const topDiagnosis = Object.entries(data.unverifiedFailed.byDiagnosis)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  return (
    <section className="review-panel failed-panel">
      <div className="section-title">
        <div>
          <p className="eyebrow">Unverified failed</p>
          <h2>{number(items.length)} filtered rows</h2>
          <p className="section-help">
            Total failed/unverified rows: {number(data.unverifiedFailed.total)}. Each row is diagnosed as missing mapping,
            mapping present but adapter failed, or candidate mapping present but not linked.
          </p>
        </div>
        <div className="click-filter-row">
          <FilterChip
            active={filters.failedDiagnosis === "all"}
            onClick={() => setFilters({ ...filters, failedDiagnosis: "all" })}
          >
            All failed: {number(data.unverifiedFailed.total)}
          </FilterChip>
          {topDiagnosis.map(([diagnosis, count]) => (
            <FilterChip
              key={diagnosis}
              active={filters.failedDiagnosis === diagnosis}
              onClick={() => setFilters({ ...filters, failedDiagnosis: diagnosis })}
            >
              {diagnosisLabel(diagnosis)}: {number(count)}
            </FilterChip>
          ))}
        </div>
      </div>
      <div className="review-subtitle standalone">
        <strong>Showing all {number(items.length)} failed rows after filters</strong>
        <span>Use the failed-reason chips above to narrow this list.</span>
      </div>
      <div className="review-list">
        {items.slice(0, shownItems).map((item) => (
          <article key={item.id} className="review-row failed-row">
            <div>
              <span className="review-kicker">
                {item.verificationFailureCode || item.verificationStatus || "FAILED"} / {diagnosisLabel(item.diagnosis)}
              </span>
              <strong>
                {item.raceName || "Unknown race"} {item.year ? `(${item.year})` : ""}
              </strong>
              <p>{item.action}</p>
              {item.verificationError && <p className="error-line">{item.verificationError}</p>}
            </div>
            <div className="review-meta">
              <span>{item.bib ? `Bib ${item.bib}` : "No bib"}</span>
              <span>{item.category || "No category"}</span>
              <span>{list(item.adapterKeys).length ? list(item.adapterKeys).join(", ") : `${number(item.mappingCount)} mappings`}</span>
              <span>{item.matchedEditionTitle ? `Matched: ${item.matchedEditionTitle}` : item.candidateEditionTitle ? `Candidate: ${item.candidateEditionTitle}` : "No edition link"}</span>
            </div>
          </article>
        ))}
        {!items.length && <p className="empty">No failed verification rows match these filters.</p>}
        {shownItems < items.length && (
          <button className="ghost" type="button" onClick={() => setShownItems((value) => value + 50)}>
            Show 50 more ({number(items.length - shownItems)} remaining)
          </button>
        )}
      </div>
    </section>
  );
}

function YearStrip({ data }: { data: DashboardData }) {
  return (
    <section className="year-strip">
      {data.yearSummary.slice(0, 14).map((year) => (
        <article key={year.year}>
          <strong>{year.year}</strong>
          <span>{number(year.editions)} editions</span>
          <small>{number(year.issues)} flags</small>
        </article>
      ))}
    </section>
  );
}

function RaceObjectQuickFilters({
  data,
  filters,
  setFilters,
}: {
  data: DashboardData;
  filters: Filters;
  setFilters: (next: Filters) => void;
}) {
  return (
    <div className="click-filter-row race-filter-row">
      <FilterChip
        active={
          !filters.onlyIssues &&
          filters.severity === "all" &&
          filters.issueType === "all" &&
          !filters.query &&
          filters.sport === "all" &&
          filters.adapter === "all" &&
          filters.year === "all"
        }
        onClick={() =>
          setFilters({
            ...filters,
            query: "",
            severity: "all",
            issueType: "all",
            sport: "all",
            adapter: "all",
            year: "all",
            onlyIssues: false,
          })
        }
      >
        All race objects: {number(data.groups.length)}
      </FilterChip>
      <FilterChip
        active={filters.onlyIssues}
        onClick={() => setFilters({ ...filters, onlyIssues: true })}
      >
        Issues only: {number(data.groups.filter((group) => group.summary.issueCount > 0).length)}
      </FilterChip>
      <FilterChip
        active={!filters.onlyIssues}
        onClick={() => setFilters({ ...filters, onlyIssues: false })}
      >
        Include clean
      </FilterChip>
      {SEVERITIES.filter((severity) => severity !== "all").map((severity) => (
        <FilterChip
          key={severity}
          active={filters.severity === severity}
          onClick={() => setFilters({ ...filters, severity: severity as Filters["severity"], onlyIssues: true })}
        >
          {severity}: {number(data.issueSummary.bySeverity[severity] ?? 0)}
        </FilterChip>
      ))}
    </div>
  );
}

function RaceCard({
  group,
  selected,
  onSelect,
}: {
  group: RaceEditionGroup;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button className={selected ? "race-card selected" : "race-card"} onClick={onSelect} type="button">
      <div className="race-card-top">
        <span className={severityClass(group.summary.highestSeverity)}>{group.summary.highestSeverity ?? "clean"}</span>
        <span>{group.race.sport ?? "UNKNOWN"}</span>
      </div>
      <h3>{group.race.title}</h3>
      <p>{group.race.location || "No race location"}</p>
      <div className="race-card-stats">
        <span>{number(group.summary.editionCount)} editions</span>
        <span>{number(group.summary.categoryCount)} categories</span>
        <span>{number(group.summary.resultCount)} results</span>
        <span>{number(group.summary.issueCount)} flags</span>
      </div>
      <div className="chip-row">
        {group.summary.years.slice(0, 5).map((year) => (
          <span key={year}>{year}</span>
        ))}
        {group.summary.adapterKeys.slice(0, 3).map((adapter) => (
          <span key={adapter}>{adapter}</span>
        ))}
      </div>
    </button>
  );
}

function IssuePill({ issue }: { issue: DashboardIssue }) {
  return (
    <article className="issue-pill">
      <span className={severityClass(issue.severity)}>{issue.severity}</span>
      <div>
        <strong>{issueLabel(issue)}</strong>
        <p>{issue.detail}</p>
      </div>
    </article>
  );
}

function EditionBlock({ edition }: { edition: RaceEditionGroup["editions"][number] }) {
  return (
    <details className="edition-block" open={edition.issues.length > 0}>
      <summary>
        <div>
          <strong>{edition.title}</strong>
          <span>
            {edition.year} / {dateOnly(edition.eventDate)} / {edition.city || edition.location || "No location"}
          </span>
        </div>
        <span className={severityClass(edition.issues[0]?.severity)}>
          {edition.issues.length ? `${edition.issues.length} flags` : "clean"}
        </span>
      </summary>
      {edition.issues.length > 0 && (
        <div className="issue-list compact">
          {edition.issues.map((issue) => (
            <IssuePill key={issue.id} issue={issue} />
          ))}
        </div>
      )}
      <div className="edition-meta">
        <span>{number(edition.resultCount)} results</span>
        <span>{number(edition.registrationCount)} registrations</span>
        <span>{number(edition.unmatchedEntryCount)} matched entries</span>
        <span>{edition.resultsLocked ? "locked" : "open"}</span>
      </div>
      <div className="subgrid">
        <div>
          <h4>Categories</h4>
          {edition.categories.length ? (
            <div className="mini-table">
              {edition.categories.map((category) => (
                <div key={category.id}>
                  <span>{category.category}</span>
                  <span>{category.totalDistanceKm == null ? "null km" : `${category.totalDistanceKm} km`}</span>
                  <span>{number(category.resultCount)} results</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="empty">No categories</p>
          )}
        </div>
        <div>
          <h4>Mappings</h4>
          {edition.mappings.length ? (
            <div className="mini-table">
              {edition.mappings.map((mapping) => (
                <div key={mapping.id}>
                  <span>{mapping.adapterKey}</span>
                  <span>{mapping.year}</span>
                  <span>{mapping.rawName}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="empty">No adapter mapping</p>
          )}
        </div>
      </div>
    </details>
  );
}

function DetailPanel({ group }: { group: RaceEditionGroup | null }) {
  if (!group) {
    return (
      <aside className="detail-panel">
        <p className="empty">Select a race group to inspect editions, categories, mappings, and issue flags.</p>
      </aside>
    );
  }
  return (
    <aside className="detail-panel">
      <div className="detail-hero">
        <p className="eyebrow">Race object</p>
        <h2>{group.race.title}</h2>
        <p>{group.race.location || "No race location"} / {group.race.sport ?? "UNKNOWN"}</p>
      </div>
      <div className="detail-counters">
        <span>{number(group.summary.editionCount)} editions</span>
        <span>{number(group.summary.categoryCount)} categories</span>
        <span>{number(group.summary.mappingCount)} mappings</span>
        <span>{number(group.summary.issueCount)} flags</span>
      </div>
      {group.issues.length > 0 && (
        <section className="issue-list">
          <h3>Flags on this race object</h3>
          {group.issues.slice(0, 12).map((issue) => (
            <IssuePill key={issue.id} issue={issue} />
          ))}
        </section>
      )}
      <section>
        <h3>Edition timeline</h3>
        <div className="edition-list">
          {group.editions.map((edition) => (
            <EditionBlock key={edition.id} edition={edition} />
          ))}
        </div>
      </section>
    </aside>
  );
}

export default function AdminDashboard({ data }: { data: DashboardData }) {
  const [filters, setFilters] = useState<Filters>({
    query: "",
    severity: "all",
    issueType: "all",
    sport: "all",
    adapter: "all",
    year: "all",
    upcomingStatus: "all",
    failedDiagnosis: "all",
    onlyIssues: false,
  });
  const filteredGroups = useFilteredGroups(data, filters);
  const filteredUpcoming = useFilteredUpcoming(data, filters);
  const filteredAdapterUpcoming = useFilteredAdapterUpcoming(data);
  const filteredFailed = useFilteredFailed(data, filters);
  const [shownGroups, setShownGroups] = useState(100);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedGroup = filteredGroups.find((group) => group.race.id === selectedId) ?? filteredGroups[0] ?? null;

  return (
    <main className="dashboard-shell">
      <section className="hero">
        <div>
          <h1>Wone Dashboard Monitoring</h1>
          <p>
            Browse Race to Edition to Category objects, spot fuzzy grouping mistakes, catch missing distances,
            and inspect adapter coverage without opening SQL.
          </p>
        </div>
        <div className="hero-stamp">
          <span>Live DB</span>
          <strong>{new Date(data.generatedAt).toLocaleString("en-IN")}</strong>
        </div>
      </section>

      <section className="metrics-grid">
        <MetricCard label="Races" value={number(data.counts.races)} detail="canonical cards" tone="ink" />
        <MetricCard label="Editions" value={number(data.counts.race_editions)} detail="year/date instances" tone="fern" />
        <MetricCard label="Categories" value={number(data.counts.race_categories)} detail="distance buckets" tone="gold" />
        <MetricCard label="Results" value={number(data.counts.results)} detail="athlete performances" tone="sky" />
        <MetricCard label="Flags" value={number(data.issueSummary.total)} detail="dashboard rule hits" tone="ember" />
        <MetricCard label="Upcoming" value={number(data.upcomingReview.total)} detail="races in DB" tone="fern" />
        <MetricCard label="Adapter new" value={number(data.adapterUpcoming.needsAddOrReviewCount)} detail="to check/add" tone="gold" />
        <MetricCard label="Verify failed" value={number(data.unverifiedFailed.total)} detail="needs diagnosis" tone="ember" />
      </section>

      <FilterBar data={data} filters={filters} setFilters={setFilters} />

      <section className="review-grid">
        <UpcomingReviewPanel
          data={data}
          items={filteredUpcoming}
          adapterItems={filteredAdapterUpcoming}
          filters={filters}
          setFilters={setFilters}
        />
        <UnverifiedFailedPanel data={data} items={filteredFailed} filters={filters} setFilters={setFilters} />
      </section>

      <section className="insight-grid">
        <IssueSummary data={data} />
        <AdapterRail data={data} />
      </section>
      <YearStrip data={data} />

      <section className="workspace">
        <section className="race-list-panel">
          <div className="section-title sticky-title">
            <div>
              <p className="eyebrow">Race objects</p>
              <h2>{number(filteredGroups.length)} groups visible</h2>
            </div>
            <button
              className="ghost"
              type="button"
              onClick={() =>
                setFilters({
                  ...filters,
                  query: "",
                  issueType: "all",
                  severity: "all",
                  sport: "all",
                  adapter: "all",
                  year: "all",
                  upcomingStatus: "all",
                  failedDiagnosis: "all",
                  onlyIssues: false,
                })
              }
            >
              Clear filters
            </button>
          </div>
          <RaceObjectQuickFilters data={data} filters={filters} setFilters={setFilters} />
          <div className="race-list">
            {filteredGroups.slice(0, shownGroups).map((group) => (
              <RaceCard
                key={group.race.id}
                group={group}
                selected={selectedGroup?.race.id === group.race.id}
                onSelect={() => setSelectedId(group.race.id)}
              />
            ))}
            {shownGroups < filteredGroups.length && (
              <button className="ghost" type="button" onClick={() => setShownGroups((value) => value + 100)}>
                Show 100 more race objects ({number(filteredGroups.length - shownGroups)} remaining)
              </button>
            )}
          </div>
        </section>
        <DetailPanel group={selectedGroup} />
      </section>
    </main>
  );
}
