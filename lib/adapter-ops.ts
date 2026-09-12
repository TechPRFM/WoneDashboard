import "server-only";

import type { Pool } from "pg";

export type AdapterCapability = {
  adapterKey: string;
  adapterName: string;
  categorySearch: "all_event_categories" | "division_wide" | "event_wide" | "unknown";
  usesAgeToFind: boolean;
  usesGenderToFind: boolean;
  capturesAge: boolean;
  capturesGender: boolean;
  supportsBib: boolean;
  supportsName: boolean;
  note: string;
};

export type AdapterReliability = {
  adapterKey: string;
  calls: number;
  success: number;
  failure: number;
  successRate: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  statusCounts: Record<string, number>;
};

export type AdapterQueueSignal = {
  adapterKey: string;
  queueRows: number;
  linkedRows: number;
  linksWithoutStructuredData: number;
  openDecisionRows: number;
  dnsRows: number;
  dnfRows: number;
  dqRows: number;
  rowsWithAgeEvidence: number;
  rowsWithGenderEvidence: number;
};

export type AdapterRunSummary = {
  configured: boolean;
  status: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  adaptersChecked: number;
  eventsSeen: number;
  newEvents: number;
  proposals: number;
  errors: number;
  source: string;
};

export type AdapterOperationsData = {
  discovery: AdapterRunSummary;
  stress: AdapterRunSummary & {
    calls: number;
    successRate: number | null;
  };
  capabilities: AdapterCapability[];
  reliability: AdapterReliability[];
  queueSignals: AdapterQueueSignal[];
};

const CAPABILITIES: AdapterCapability[] = [
  ["myraceindia", "MyRace India", "event_wide", true, true, "Event-wide name/bib lookup; age and gender are corroboration fields, not query inputs."],
  ["sportstiming", "Sports Timing Solutions", "event_wide", true, true, "Event-wide participant lookup across the event's published categories."],
  ["mysamay", "MySamay", "event_wide", true, true, "Event-level lookup; category is read from the returned participant record."],
  ["racetime", "App RaceTime", "all_event_categories", true, true, "Searches the race event list and hydrates the selected result detail."],
  ["ifinish", "iFinish", "event_wide", true, true, "Searches the event result source; non-finish statuses must be preserved from raw rows."],
  ["longrun", "Long Run Timings", "all_event_categories", true, true, "Searches all result tabs/categories exposed for the event."],
  ["runizen", "Runizen", "event_wide", true, true, "Event-wide participant lookup with category captured after matching."],
  ["hirox", "HYROX", "division_wide", false, true, "Searches every published division instead of assuming a default division."],
  ["hyresult", "HYRESULT", "division_wide", false, true, "Scans all ranking links/divisions for the athlete name."],
  ["roxcoach", "RoxCoach", "division_wide", false, true, "Scans all division result URLs, including doubles and relay team members."],
  ["itra", "ITRA", "event_wide", true, true, "Searches the full race-year result set and then matches runner identity."],
  ["novarace", "NovaRace", "event_wide", true, true, "Event-wide name/bib lookup."],
  ["alpharacing", "Alpha Racing Solution", "event_wide", true, true, "Event-wide name/bib lookup."],
  ["chronos", "Chronos India", "event_wide", true, true, "Event-wide name/bib lookup."],
  ["timekeeper", "TimeKeeper", "event_wide", true, true, "Event-wide name/bib lookup."],
  ["athlinks", "Athlinks", "all_event_categories", true, true, "Searches the event and resolves the athlete's actual course/category."],
].map(([adapterKey, adapterName, categorySearch, capturesAge, capturesGender, note]) => ({
  adapterKey: String(adapterKey),
  adapterName: String(adapterName),
  categorySearch: categorySearch as AdapterCapability["categorySearch"],
  usesAgeToFind: false,
  usesGenderToFind: false,
  capturesAge: Boolean(capturesAge),
  capturesGender: Boolean(capturesGender),
  supportsBib: !["hirox", "hyresult", "roxcoach"].includes(String(adapterKey)),
  supportsName: true,
  note: String(note),
}));

function iso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function nextNightlyRun(): string {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 20, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

function emptySignal(adapterKey: string): AdapterQueueSignal {
  return {
    adapterKey,
    queueRows: 0,
    linkedRows: 0,
    linksWithoutStructuredData: 0,
    openDecisionRows: 0,
    dnsRows: 0,
    dnfRows: 0,
    dqRows: 0,
    rowsWithAgeEvidence: 0,
    rowsWithGenderEvidence: 0,
  };
}

export async function loadAdapterOperations(pool: Pool): Promise<AdapterOperationsData> {
  const tableCheck = await pool.query<{
    upcoming: string | null;
    runs: string | null;
    results: string | null;
  }>(`
    select
      to_regclass('public.adapter_upcoming_events')::text as upcoming,
      to_regclass('public.adapter_ops_runs')::text as runs,
      to_regclass('public.adapter_ops_adapter_results')::text as results
  `);
  const tables = tableCheck.rows[0];

  const queueResult = await pool.query<{
    adapterKey: string | null;
    queueRows: number;
    linkedRows: number;
    linksWithoutStructuredData: number;
    openDecisionRows: number;
    dnsRows: number;
    dnfRows: number;
    dqRows: number;
    rowsWithAgeEvidence: number;
    rowsWithGenderEvidence: number;
  }>(`
    with queue as (
      select
        entry.*,
        coalesce(nullif(entry."verificationDiagnostics"->>'adapter', ''), mapping."adapterKey", 'unmapped') as adapter_key,
        lower(concat_ws(' ', entry."verificationFailureCode", entry."verificationError", entry."verificationUserAction", entry."rawRowData"::text, entry."verificationCandidates"::text)) as evidence
      from public.unmatched_race_entries entry
      left join lateral (
        select rem."adapterKey"
        from public.race_edition_mappings rem
        where rem."raceEditionId" = entry."matchedRaceEditionId"
        order by rem."adapterKey"
        limit 1
      ) mapping on true
    )
    select
      adapter_key as "adapterKey",
      count(*)::int as "queueRows",
      count(*) filter (where "timingLink" is not null and trim("timingLink") <> '')::int as "linkedRows",
      count(*) filter (
        where "timingLink" is not null and trim("timingLink") <> ''
          and coalesce(jsonb_array_length(case when jsonb_typeof("verificationCandidates") = 'array' then "verificationCandidates" else '[]'::jsonb end), 0) = 0
      )::int as "linksWithoutStructuredData",
      count(*) filter (where "verificationFailureCode" = 'LINK_OPEN_DECISION' or "verificationUserAction" = 'OPEN_RESULT_LINK')::int as "openDecisionRows",
      count(*) filter (where evidence ~ '(^|[^a-z])dns([^a-z]|$)|did not start')::int as "dnsRows",
      count(*) filter (where evidence ~ '(^|[^a-z])dnf([^a-z]|$)|did not finish')::int as "dnfRows",
      count(*) filter (where evidence ~ '(^|[^a-z])dq([^a-z]|$)|disqualif')::int as "dqRows",
      count(*) filter (where "verificationCandidates"::text ~* 'age_group|"age"')::int as "rowsWithAgeEvidence",
      count(*) filter (where "verificationCandidates"::text ~* 'gender|sex')::int as "rowsWithGenderEvidence"
    from queue
    group by adapter_key
    order by adapter_key
  `);

  const queueSignals = new Map<string, AdapterQueueSignal>();
  for (const row of queueResult.rows) {
    const adapterKey = row.adapterKey || "unmapped";
    queueSignals.set(adapterKey, {
      adapterKey,
      queueRows: Number(row.queueRows),
      linkedRows: Number(row.linkedRows),
      linksWithoutStructuredData: Number(row.linksWithoutStructuredData),
      openDecisionRows: Number(row.openDecisionRows),
      dnsRows: Number(row.dnsRows),
      dnfRows: Number(row.dnfRows),
      dqRows: Number(row.dqRows),
      rowsWithAgeEvidence: Number(row.rowsWithAgeEvidence),
      rowsWithGenderEvidence: Number(row.rowsWithGenderEvidence),
    });
  }
  for (const capability of CAPABILITIES) {
    if (!queueSignals.has(capability.adapterKey)) queueSignals.set(capability.adapterKey, emptySignal(capability.adapterKey));
  }

  let discovery: AdapterRunSummary = {
    configured: Boolean(tables?.upcoming),
    status: tables?.upcoming ? "STAGING_READY" : "SCHEMA_REQUIRED",
    lastRunAt: null,
    nextRunAt: nextNightlyRun(),
    adaptersChecked: 0,
    eventsSeen: 0,
    newEvents: 0,
    proposals: 0,
    errors: 0,
    source: tables?.upcoming ? "adapter_upcoming_events" : "not configured",
  };

  if (tables?.upcoming) {
    const upcoming = await pool.query<{
      lastRunAt: string | null;
      adaptersChecked: number;
      eventsSeen: number;
      newEvents: number;
      proposals: number;
    }>(`
      select
        max("updatedAt")::text as "lastRunAt",
        count(distinct "adapterKey")::int as "adaptersChecked",
        count(*)::int as "eventsSeen",
        count(*) filter (where coalesce("catalogStatus", 'NEW') in ('NEW', 'REVIEW_REQUIRED'))::int as "newEvents",
        count(*) filter (where "catalogStatus" = 'REVIEW_REQUIRED')::int as proposals
      from public.adapter_upcoming_events
      where "eventDate" is null or "eventDate" >= current_date
    `).catch(async () => pool.query(`
      select
        max("updatedAt")::text as "lastRunAt",
        count(distinct "adapterKey")::int as "adaptersChecked",
        count(*)::int as "eventsSeen",
        count(*)::int as "newEvents",
        0::int as proposals
      from public.adapter_upcoming_events
      where "eventDate" is null or "eventDate" >= current_date
    `));
    const row = upcoming.rows[0];
    discovery = {
      ...discovery,
      status: row?.lastRunAt ? "COMPLETED" : "NEVER_RUN",
      lastRunAt: iso(row?.lastRunAt),
      adaptersChecked: Number(row?.adaptersChecked || 0),
      eventsSeen: Number(row?.eventsSeen || 0),
      newEvents: Number(row?.newEvents || 0),
      proposals: Number(row?.proposals || 0),
    };
  }

  let reliability: AdapterReliability[] = [];
  let stress: AdapterOperationsData["stress"] = {
    configured: Boolean(tables?.runs && tables?.results),
    status: "NEVER_RUN",
    lastRunAt: null,
    nextRunAt: null,
    adaptersChecked: 0,
    eventsSeen: 0,
    newEvents: 0,
    proposals: 0,
    errors: 0,
    source: "No DB-backed stress run",
    calls: 0,
    successRate: null,
  };

  if (tables?.runs && tables?.results) {
    const latestRun = await pool.query<{
      id: string;
      status: string;
      startedAt: string;
      adapterCount: number;
      totalCalls: number;
      successCount: number;
      failureCount: number;
    }>(`
      select id,status,"startedAt"::text as "startedAt","adapterCount","totalCalls","successCount","failureCount"
      from public.adapter_ops_runs
      where operation = 'STRESS'
      order by "startedAt" desc
      limit 1
    `);
    const run = latestRun.rows[0];
    if (run) {
      const resultRows = await pool.query<{
        adapterKey: string;
        calls: number;
        success: number;
        failure: number;
        successRate: number | null;
        p50LatencyMs: number | null;
        p95LatencyMs: number | null;
        statusCounts: Record<string, number> | null;
      }>(`
        select "adapterKey",calls,success,failure,"successRate","p50LatencyMs","p95LatencyMs","statusCounts"
        from public.adapter_ops_adapter_results
        where "runId" = $1
        order by "adapterKey"
      `, [run.id]);
      reliability = resultRows.rows.map((row) => ({
        ...row,
        calls: Number(row.calls),
        success: Number(row.success),
        failure: Number(row.failure),
        successRate: row.successRate == null ? null : Number(row.successRate),
        p50LatencyMs: row.p50LatencyMs == null ? null : Number(row.p50LatencyMs),
        p95LatencyMs: row.p95LatencyMs == null ? null : Number(row.p95LatencyMs),
        statusCounts: row.statusCounts || {},
      }));
      stress = {
        configured: true,
        status: run.status,
        lastRunAt: iso(run.startedAt),
        nextRunAt: null,
        adaptersChecked: Number(run.adapterCount),
        eventsSeen: 0,
        newEvents: 0,
        proposals: 0,
        errors: Number(run.failureCount),
        source: "adapter_ops_runs",
        calls: Number(run.totalCalls),
        successRate: Number(run.totalCalls) ? Number(run.successCount) / Number(run.totalCalls) : null,
      };
    }
  }

  discovery.configured = Boolean(tables?.upcoming && tables?.runs && tables?.results && process.env.ADAPTER_DISCOVERY_URL && process.env.ADAPTER_SERVICE_TOKEN && process.env.ADAPTER_OPS_DATABASE_URL);
  stress.configured = Boolean(tables?.runs && tables?.results && process.env.ADAPTER_STRESS_URL && process.env.ADAPTER_SERVICE_TOKEN && process.env.ADAPTER_OPS_DATABASE_URL);
  if (!discovery.configured) discovery.status = "SERVICE_NOT_CONFIGURED";
  discovery.nextRunAt = discovery.configured && process.env.CRON_SECRET ? nextNightlyRun() : null;
  if (!stress.configured) stress.status = "SERVICE_NOT_CONFIGURED";
  return {
    discovery,
    stress,
    capabilities: CAPABILITIES,
    reliability,
    queueSignals: Array.from(queueSignals.values()).sort((a, b) => a.adapterKey.localeCompare(b.adapterKey)),
  };
}
