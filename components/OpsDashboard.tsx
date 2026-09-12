"use client";

import { useMemo, useState } from "react";
import type { OpsDashboardData, OpsQueueItem } from "../lib/ops-db";
import type { DashboardIssue, RaceEditionGroup } from "../lib/quality";
import { hasOpenDecision, verificationFailureCode } from "../lib/verification-state";

type View = "dashboard" | "results" | "races" | "upcoming" | "adapters" | "flags" | "users" | "logs";

const VIEWS: Array<{ id: View; label: string; mark: string }> = [
  { id: "dashboard", label: "Dashboard", mark: "DB" },
  { id: "results", label: "Results queue", mark: "RQ" },
  { id: "races", label: "Race catalog", mark: "RC" },
  { id: "upcoming", label: "Upcoming", mark: "UP" },
  { id: "adapters", label: "Adapters", mark: "AD" },
  { id: "flags", label: "Quality flags", mark: "FL" },
  { id: "users", label: "Users", mark: "US" },
  { id: "logs", label: "Activity", mark: "LG" },
];

const VIEW_COPY: Record<View, { title: string; subtitle: string }> = {
  dashboard: { title: "Operations overview", subtitle: "What needs attention across the production database" },
  results: { title: "Results queue", subtitle: "Every imported race entry, its verification state, and the evidence available" },
  races: { title: "Race catalog", subtitle: "Race to edition to category to adapter mapping, in one place" },
  upcoming: { title: "Upcoming radar", subtitle: "What is already in the DB and what adapters have discovered outside it" },
  adapters: { title: "Adapter coverage", subtitle: "Coverage, mappings, failures, and races depending on each timing provider" },
  flags: { title: "Data quality", subtitle: "Rule-based issues detected from the live race hierarchy" },
  users: { title: "Runner coverage", subtitle: "Onboarding, claims, personal bests, imports, and unresolved race history" },
  logs: { title: "System activity", subtitle: "Recent production outbox processing and failures" },
};

const ISSUE_LABELS: Record<string, string> = {
  suspect_edition_match: "Wrong race grouping",
  race_title_has_year: "Race title has year",
  edition_title_duplicate_year: "Duplicate year in title",
  edition_title_year_mismatch: "Title year mismatch",
  edition_year_date_mismatch: "Year/date mismatch",
  missing_event_date: "Missing event date",
  missing_location: "Missing location",
  missing_structured_city: "Missing city",
  edition_without_categories: "No categories",
  edition_without_mapping: "No adapter mapping",
  category_missing_distance: "Missing distance",
  category_distance_mismatch: "Distance mismatch",
  age_group_as_category: "Age group as category",
  mapping_year_mismatch: "Mapping year mismatch",
  mapping_title_mismatch: "Mapping title mismatch",
};

function count(value: number | undefined) {
  return String(value ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function date(value: string | null | undefined) {
  if (!value) return "No date";
  const match = value.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return value.slice(0, 10);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(match[3])} ${months[Number(match[2]) - 1]} ${match[1]}`;
}

function stamp(value: string | null | undefined) {
  if (!value) return "Unknown";
  return `${date(value)} ${value.slice(11, 16)}`.trim();
}

function words(value: string | null | undefined) {
  return String(value ?? "UNKNOWN")
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function apiMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const value = payload as { error?: string | { message?: string }; outcome?: { failureMessage?: string } };
  if (typeof value.error === "string") return value.error;
  if (value.error?.message) return value.error.message;
  if (value.outcome?.failureMessage) return value.outcome.failureMessage;
  return fallback;
}

function initials(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function raceBlob(group: RaceEditionGroup) {
  return [
    group.race.title,
    group.race.location,
    group.race.sport,
    ...group.editions.flatMap((edition) => [
      edition.title,
      edition.location,
      edition.city,
      edition.country,
      ...edition.categories.flatMap((category) => [category.category, category.title]),
      ...edition.mappings.flatMap((mapping) => [mapping.rawName, mapping.adapterKey, mapping.externalEventKey]),
    ]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function queueBlob(item: OpsQueueItem) {
  return [
    item.raceName,
    item.userName,
    item.participantName,
    item.bib,
    item.category,
    item.source,
    item.status,
    item.verificationStatus,
    item.failureCode,
    ...item.adapterKeys,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function Pill({ children, tone = "neutral" }: { children: React.ReactNode; tone?: string }) {
  return <span className={`ops-pill ops-pill-${tone}`}>{children}</span>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="ops-empty">{children}</div>;
}

function Metric({
  value,
  label,
  note,
  tone,
  onClick,
}: {
  value: number;
  label: string;
  note: string;
  tone: string;
  onClick: () => void;
}) {
  return (
    <button className={`ops-metric ops-metric-${tone}`} type="button" onClick={onClick}>
      <span className="ops-metric-icon">{label.slice(0, 2).toUpperCase()}</span>
      <strong>{count(value)}</strong>
      <b>{label}</b>
      <small>{note}</small>
      <i>Open view</i>
    </button>
  );
}

function DashboardView({ data, go }: { data: OpsDashboardData; go: (view: View) => void }) {
  const { catalog } = data;
  const activeQueue = data.breakdowns.queueStatus.filter((item) => ["IN_REVIEW", "PENDING"].includes(item.key)).reduce((sum, item) => sum + item.count, 0);
  const failedQueue = data.breakdowns.verificationStatus.find((item) => item.key === "FAILED")?.count || 0;
  const outboxFailed = data.logs.filter((item) => item.status === "FAILED").length;
  const incompleteUsers = data.users.filter((user) => user.onboardingStatus !== "COMPLETED").length;

  return (
    <>
      <section className="ops-command-banner">
        <div>
          <p className="ops-eyebrow">LIVE PRODUCTION CONTROL ROOM</p>
          <h2>One clear place to see what is healthy, what is blocked, and why.</h2>
          <span>
            Generated {stamp(catalog.generatedAt)}. Every number below is calculated from Postgres during this request.
          </span>
        </div>
        <div className="ops-health-ring">
          <strong>{catalog.issueSummary.total ? Math.max(0, 100 - Math.round(catalog.issueSummary.total / 50)) : 100}</strong>
          <span>catalog signal</span>
        </div>
      </section>

      <p className="ops-section-label">Needs attention</p>
      <section className="ops-metric-grid">
        <Metric value={activeQueue} label="Open results" note="Pending or in review" tone="orange" onClick={() => go("results")} />
        <Metric value={failedQueue} label="Verification failed" note="Adapter or mapping diagnosis" tone="red" onClick={() => go("results")} />
        <Metric value={catalog.issueSummary.total} label="Quality flags" note="Across the race hierarchy" tone="gold" onClick={() => go("flags")} />
        <Metric value={catalog.adapterUpcoming.needsAddOrReviewCount} label="Adapter discoveries" note="Not confidently found in DB" tone="blue" onClick={() => go("upcoming")} />
        <Metric value={outboxFailed} label="System failures" note="Recent failed outbox events" tone="red" onClick={() => go("logs")} />
        <Metric value={incompleteUsers} label="Onboarding open" note="Users still in progress" tone="gold" onClick={() => go("users")} />
      </section>

      <p className="ops-section-label">Catalog</p>
      <section className="ops-metric-grid ops-metric-grid-catalog">
        <Metric value={catalog.counts.races} label="Races" note="Canonical race objects" tone="ink" onClick={() => go("races")} />
        <Metric value={catalog.counts.race_editions} label="Editions" note="Year and date instances" tone="green" onClick={() => go("races")} />
        <Metric value={catalog.counts.race_categories} label="Categories" note="Distance and division buckets" tone="blue" onClick={() => go("races")} />
        <Metric value={catalog.counts.results} label="Results" note="Structured performances" tone="orange" onClick={() => go("results")} />
        <Metric value={data.users.length} label="Users" note="Runner accounts" tone="ink" onClick={() => go("users")} />
        <Metric value={catalog.upcomingReview.total} label="Upcoming in DB" note="Future dated editions" tone="green" onClick={() => go("upcoming")} />
      </section>

      <section className="ops-overview-row">
        <div className="ops-card">
          <div className="ops-card-head">
            <div>
              <p className="ops-eyebrow">QUEUE STATE</p>
              <h3>Result verification</h3>
            </div>
            <button type="button" onClick={() => go("results")}>View queue</button>
          </div>
          <div className="ops-breakdown">
            {data.breakdowns.queueStatus.map((item) => (
              <div key={item.key}>
                <span>{words(item.key)}</span>
                <strong>{count(item.count)}</strong>
              </div>
            ))}
          </div>
        </div>
        <div className="ops-card">
          <div className="ops-card-head">
            <div>
              <p className="ops-eyebrow">ADAPTER COVERAGE</p>
              <h3>Most connected providers</h3>
            </div>
            <button type="button" onClick={() => go("adapters")}>All adapters</button>
          </div>
          <div className="ops-adapter-mini">
            {catalog.adapterSummary.slice(0, 6).map((adapter) => (
              <div key={adapter.adapterKey}>
                <span><i />{adapter.adapterKey}</span>
                <b>{count(adapter.editions)} editions</b>
                <strong>{count(adapter.mappings)}</strong>
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}

type ResultLane = "all" | "open_decision" | "non_finisher" | "no_locator" | "no_adapter" | "no_data" | "waiting_runner" | "verified";
type TatLane = "all" | "breached" | "soon" | "ok" | "paused";
type QueueMode = "race" | "runner";

type VerificationCandidate = {
  confidence?: number;
  review_note?: string;
  corroborated_by?: string[];
  result?: {
    bib?: string;
    athlete_name?: string;
    category?: string;
    chip_time?: string;
    gun_time?: string;
    total_time?: string;
    distance_km?: number;
    result_link?: string;
    external_event_key?: string;
    status?: string;
    finish_status?: string;
    outcome?: string;
  };
  ranks?: {
    overall_rank?: number;
    gender_rank?: number;
    age_group_label?: string;
    age_group_rank?: number;
  };
};

type QueueGroup = {
  id: string;
  name: string;
  year: number | null;
  location: string | null;
  source: string;
  lane: ResultLane;
  items: OpsQueueItem[];
};

const RESULT_LANES: Array<{ id: ResultLane; label: string }> = [
  { id: "all", label: "All lanes" },
  { id: "open_decision", label: "Open decision" },
  { id: "non_finisher", label: "DNS / DNF / Untimed / DQ" },
  { id: "no_locator", label: "No unique link" },
  { id: "no_adapter", label: "No adapter" },
  { id: "no_data", label: "No data" },
  { id: "waiting_runner", label: "Waiting on runner" },
  { id: "verified", label: "Verified" },
];

const TAT_LANES: Array<{ id: TatLane; label: string }> = [
  { id: "all", label: "Any" },
  { id: "breached", label: "Breached" },
  { id: "soon", label: "Due <=12h" },
  { id: "ok", label: "On track" },
  { id: "paused", label: "Paused" },
];

function candidateRows(item: OpsQueueItem): VerificationCandidate[] {
  return Array.isArray(item.candidates) ? (item.candidates as VerificationCandidate[]) : [];
}

type OfficialOutcome = "DNS" | "DNF" | "NON_TIMED" | "DQ" | "FINISHED" | "UNKNOWN";

function officialOutcome(item: OpsQueueItem): OfficialOutcome {
  if (item.participationOutcome) return item.participationOutcome;
  const candidate = candidateRows(item)[0];
  const evidence = [
    candidate?.result?.status,
    candidate?.result?.finish_status,
    candidate?.result?.outcome,
    candidate?.review_note,
    item.failureCode,
    item.verificationError,
    item.candidates == null ? "" : JSON.stringify(item.candidates),
  ].join(" ").toUpperCase();
  if (/(^|\W)DNS(\W|$)|DID NOT START/.test(evidence)) return "DNS";
  if (/(^|\W)DNF(\W|$)|DID NOT FINISH/.test(evidence)) return "DNF";
  if (/(^|\W)DQ(\W|$)|DISQUALIF/.test(evidence)) return "DQ";
  if (candidate?.result?.chip_time || candidate?.result?.gun_time || candidate?.result?.total_time) return "FINISHED";
  return "UNKNOWN";
}

function isOpenDecision(item: OpsQueueItem) {
  return hasOpenDecision(item);
}

function laneFor(item: OpsQueueItem): ResultLane {
  if (item.verificationStatus === "VERIFIED" || item.status === "MATCHED") return "verified";
  if (["DNS", "DNF", "NON_TIMED", "DQ"].includes(officialOutcome(item))) return "non_finisher";
  if (isOpenDecision(item)) return "open_decision";
  if (item.userAction === "PROVIDE_LINK" && /ATHLETE_NOT|BIB_MISMATCH/.test(item.failureCode || "")) return "no_locator";
  if (/MAPPING_MISS|MAPPING_AMBIGUOUS/.test(item.failureCode || "") || (!item.adapterKeys.length && !item.source)) return "no_adapter";
  if (/ADAPTER_BUG|INTERNAL_ERROR|CATEGORY_NOT|RACE_MISMATCH/.test(item.failureCode || "") || item.verificationStatus === "FAILED") return "no_data";
  if (item.userAction === "PROVIDE_LINK") return "waiting_runner";
  return "no_data";
}

function laneLabel(lane: ResultLane) {
  return RESULT_LANES.find((item) => item.id === lane)?.label || words(lane);
}

function tatHours(item: OpsQueueItem) {
  if (item.participationOutcome) return null;
  if (item.verificationStatus === "VERIFIED" || item.status === "MATCHED") return null;
  const start = new Date(item.updatedAt || item.createdAt).getTime();
  if (Number.isNaN(start)) return null;
  return Math.round(48 - (Date.now() - start) / 3_600_000);
}

function tatLane(item: OpsQueueItem): TatLane {
  if (item.userAction === "PROVIDE_LINK" && item.status === "REJECTED") return "paused";
  const hours = tatHours(item);
  if (hours == null) return "paused";
  if (hours <= 0) return "breached";
  if (hours <= 12) return "soon";
  return "ok";
}

function resultName(item: OpsQueueItem) {
  return item.userName || item.participantName || candidateRows(item)[0]?.result?.athlete_name || "Unknown runner";
}

function sourceFor(item: OpsQueueItem) {
  return item.adapterKeys.join(", ") || item.source || "No adapter";
}

function queueGroupKey(item: OpsQueueItem) {
  return item.matchedRaceEditionId || `${String(item.raceName || "unnamed").toLowerCase()}|${item.year || "unknown"}`;
}

function groupQueue(items: OpsQueueItem[]): QueueGroup[] {
  const groups = new Map<string, QueueGroup>();
  for (const item of items) {
    const id = queueGroupKey(item);
    const existing = groups.get(id);
    if (existing) {
      existing.items.push(item);
      if (existing.lane === "verified") existing.lane = laneFor(item);
      continue;
    }
    groups.set(id, {
      id,
      name: item.raceName || "Unnamed race",
      year: item.year,
      location: item.location,
      source: sourceFor(item),
      lane: laneFor(item),
      items: [item],
    });
  }
  return Array.from(groups.values()).sort((left, right) => {
    const leftTat = Math.min(...left.items.map((item) => tatHours(item) ?? 99999));
    const rightTat = Math.min(...right.items.map((item) => tatHours(item) ?? 99999));
    return leftTat - rightTat || left.name.localeCompare(right.name);
  });
}

function TatChip({ item }: { item: OpsQueueItem }) {
  const lane = tatLane(item);
  const hours = tatHours(item);
  if (item.participationOutcome) return <span className="ops-result-sla ops-sla-paused">{words(item.participationOutcome)} / recorded</span>;
  if (item.verificationStatus === "VERIFIED") return <span className="ops-result-tier ops-tier-verified">Verified / embedded</span>;
  if (lane === "paused") return <span className="ops-result-sla ops-sla-paused">Paused / runner</span>;
  if (lane === "breached") return <span className="ops-result-sla ops-sla-breach">{Math.abs(hours || 0)}h past TAT</span>;
  if (lane === "soon") return <span className="ops-result-sla ops-sla-warn">{hours}h left</span>;
  return <span className="ops-result-sla ops-sla-ok">{hours}h left</span>;
}

function CandidateBlock({ item }: { item: OpsQueueItem }) {
  const candidates = candidateRows(item);
  if (!candidates.length) return null;
  return (
    <div className="ops-result-candidates">
      {candidates.map((candidate, index) => (
        <div className={index === 0 ? "match" : ""} key={`${candidate.result?.bib || "candidate"}-${index}`}>
          <b>{candidate.result?.bib || "No bib"}</b>
          <span>
            <strong>{candidate.result?.athlete_name || "Unknown athlete"}</strong>
            <small>{candidate.result?.category || "No category"} / {candidate.result?.distance_km ?? "?"} km</small>
          </span>
          <em>{candidate.ranks?.age_group_label || "No age group"}</em>
          <strong>{candidate.result?.chip_time || candidate.result?.gun_time || candidate.result?.total_time || "No time"}</strong>
          <i>{candidate.confidence == null ? "" : `${Math.round(candidate.confidence * 100)}% match`}</i>
        </div>
      ))}
      {candidates[0]?.review_note && <p>{candidates[0].review_note}</p>}
    </div>
  );
}

function RunnerActionBar({ item, notify }: { item: OpsQueueItem; notify: (message: string) => void }) {
  const candidate = candidateRows(item)[0];
  const [link, setLink] = useState(item.timingLink || candidate?.result?.result_link || "");
  const [busy, setBusy] = useState(false);
  const [inlineError, setInlineError] = useState("");
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [edit, setEdit] = useState({
    raceName: item.raceName || "",
    date: item.eventDate?.slice(0, 10) || "",
    bib: item.bib || "",
    time: item.requestedTime || "",
    category: item.category || "",
    distanceKm: item.distanceKm == null ? "" : String(item.distanceKm),
    sport: item.sport || "",
    location: item.location || "",
  });
  const isStravaLinked = Boolean(item.stravaActivityId || /STRAVA/.test(item.source || ""));

  const decide = async (outcome: "DNS" | "DNF" | "NON_TIMED" | null) => {
    setBusy(true);
    setInlineError("");
    try {
      const response = await fetch(`/api/ops/entries/${item.id}/outcome`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome, note: "Updated from the WONE operations dashboard." }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(apiMessage(payload, "Outcome could not be saved."));
      notify(`${outcome ? outcome.replaceAll("_", " ") : "Outcome cleared"} saved and audited.`);
      window.setTimeout(() => window.location.reload(), 650);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Outcome could not be saved.";
      setInlineError(message);
      notify(message);
    } finally {
      setBusy(false);
    }
  };
  const fetchResult = async () => {
    setBusy(true);
    setInlineError("");
    try {
      const hasLink = Boolean(link.trim());
      const response = await fetch(
        hasLink ? `/api/ops/entries/${item.id}/verify-link` : `/api/ops/entries/${item.id}/rearm`,
        {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(hasLink
          ? { url: link.trim(), keepOnFailure: false, note: "Result link supplied by operations." }
          : { runNow: true, note: "Flow A re-armed and run by operations." }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(apiMessage(payload, "Verification could not be started."));
      const outcome = payload?.outcome;
      setDetail(payload);
      if (outcome?.ok === false) {
        const message = apiMessage(payload, "Verification finished without a match.");
        setInlineError(message);
        notify(message);
        return;
      }
      notify("Verification request completed. Refreshing the entry state.");
      window.setTimeout(() => window.location.reload(), 900);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Verification could not be started.";
      setInlineError(message);
      notify(message);
    } finally {
      setBusy(false);
    }
  };
  const saveEdit = async () => {
    if (isStravaLinked && edit.sport && edit.sport !== item.sport) {
      const confirmed = window.confirm("Changing sport may detach the linked Strava activity. Continue?");
      if (!confirmed) return;
    }
    setBusy(true);
    setInlineError("");
    try {
      const response = await fetch(`/api/ops/entries/${item.id}/edit`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          raceName: edit.raceName.trim(),
          date: edit.date || null,
          bib: edit.bib.trim() || null,
          time: edit.time.trim() || null,
          category: edit.category.trim() || null,
          distanceKm: edit.distanceKm === "" ? null : Number(edit.distanceKm),
          sport: edit.sport || null,
          location: edit.location.trim() || null,
          note: "Entry fields corrected from the WONE operations dashboard.",
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(apiMessage(payload, "Entry could not be updated."));
      notify(`Saved ${Array.isArray(payload.changed) ? payload.changed.join(", ") : "entry changes"} and recorded the audit.`);
      window.setTimeout(() => window.location.reload(), 650);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Entry could not be updated.";
      setInlineError(message);
      notify(message);
    } finally {
      setBusy(false);
    }
  };
  const rearmOnly = async () => {
    setBusy(true);
    setInlineError("");
    try {
      const response = await fetch(`/api/ops/entries/${item.id}/rearm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runNow: false, clearLink: false, note: "Re-armed by operations without an inline verification run." }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(apiMessage(payload, "Entry could not be re-armed."));
      setDetail(payload);
      const mappingMissing = payload.mapping?.found === false || payload.mapping?.kind === "miss";
      notify(mappingMissing ? "Re-armed, but no mapping was found. Review the catalog before verification." : "Re-armed. Eligible entries may be picked up by the verification scheduler.");
    } catch (error) {
      setInlineError(error instanceof Error ? error.message : "Entry could not be re-armed.");
    } finally {
      setBusy(false);
    }
  };
  const loadDetail = async () => {
    setBusy(true);
    setInlineError("");
    try {
      const response = await fetch(`/api/ops/entries/${item.id}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(apiMessage(payload, "Evidence could not be loaded."));
      setDetail(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Evidence could not be loaded.";
      setInlineError(message);
      notify(message);
    } finally {
      setBusy(false);
    }
  };
  if (item.verificationStatus === "VERIFIED" || item.matchedResultId || item.status === "MATCHED") return null;
  return (
    <div className="ops-result-actions-wrap">
      {isStravaLinked && <div className="ops-entry-state-chip">Strava activity attached</div>}
      {!isOpenDecision(item) && (verificationFailureCode(item) || item.verificationError) && (
        <div className="ops-open-decision" role="status">
          <b>{(verificationFailureCode(item) || "Verification failed").replaceAll("_", " ")}</b>
          <span>{item.verificationError || "Inspect evidence for the recorded failure before retrying."}</span>
        </div>
      )}
      {isOpenDecision(item) && (
        <div className="ops-open-decision">
          <b>Open decision</b>
          <span>The official link exists, but no structured finisher row was returned. Open the source and classify it as DNS, DNF, untimed, or retry extraction.</span>
        </div>
      )}
      <div className="ops-result-actions">
      {item.timingLink || candidate?.result?.result_link ? (
        <a href={item.timingLink || candidate?.result?.result_link} target="_blank" rel="noreferrer">Open result link</a>
      ) : (
        <label>
          <span>LINK</span>
          <input value={link} onChange={(event) => setLink(event.target.value)} aria-label={`Result link for ${resultName(item)}`} placeholder={`Paste ${resultName(item).split(" ")[0]}'s unique result link...`} />
        </label>
      )}
      <button type="button" disabled={busy} className="primary" onClick={fetchResult}>{link.trim() ? "Fetch & pull" : "Run mapped adapter"}</button>
      <button type="button" disabled title="Runner messaging is not connected to a backend endpoint yet. No message will be sent.">Ask runner (not connected)</button>
      <button type="button" disabled={busy} onClick={loadDetail}>Inspect evidence</button>
      <button type="button" disabled={busy} onClick={rearmOnly}>Re-arm only</button>
      <details>
        <summary>Mark as</summary>
        <div>
          <button type="button" disabled={busy} onClick={() => decide("DNF")}>DNF / did not finish</button>
          <button type="button" disabled={busy} onClick={() => decide("DNS")}>DNS / did not start</button>
          <button type="button" disabled={busy} onClick={() => decide("NON_TIMED")}>Untimed / no official clock</button>
          <button type="button" disabled={busy} onClick={() => decide(null)}>Clear outcome</button>
        </div>
      </details>
      </div>
      <details className="ops-entry-edit">
        <summary>Edit unverified entry</summary>
        <div>
          <label>Race<input value={edit.raceName} onChange={(event) => setEdit({ ...edit, raceName: event.target.value })} /></label>
          <label>Date<input type="date" value={edit.date} onChange={(event) => setEdit({ ...edit, date: event.target.value })} /></label>
          <label>Bib<input value={edit.bib} onChange={(event) => setEdit({ ...edit, bib: event.target.value })} /></label>
          <label>Time<input value={edit.time} onChange={(event) => setEdit({ ...edit, time: event.target.value })} placeholder="HH:MM:SS" /></label>
          <label>Category<input value={edit.category} onChange={(event) => setEdit({ ...edit, category: event.target.value })} /></label>
          <label>Distance km<input type="number" min="0" step="0.001" value={edit.distanceKm} onChange={(event) => setEdit({ ...edit, distanceKm: event.target.value })} /></label>
          <label>Sport<input value={edit.sport} onChange={(event) => setEdit({ ...edit, sport: event.target.value.toUpperCase() })} /></label>
          <label>Location<input value={edit.location} onChange={(event) => setEdit({ ...edit, location: event.target.value })} /></label>
          <button type="button" disabled={busy} onClick={saveEdit}>Save changes</button>
        </div>
      </details>
      {detail && (
        <details className="ops-entry-evidence" open>
          <summary>Private evidence and audit</summary>
          <pre>{JSON.stringify(detail, null, 2)}</pre>
        </details>
      )}
      {inlineError && <p className="ops-inline-error">{inlineError}</p>}
    </div>
  );
}

function QueueRunnerRow({ item, notify }: { item: OpsQueueItem; notify: (message: string) => void }) {
  const age = item.ageAtEvent;
  const candidate = candidateRows(item)[0];
  return (
    <div className="ops-result-runner">
      <div className="ops-result-runner-main">
        <div className="ops-result-avatar">{initials(resultName(item))}</div>
        <div className="ops-result-runner-info">
          <h4>{resultName(item)}</h4>
          <p>
            <span>{item.gender ? words(item.gender) : "Gender unknown"}</span>
            <i />
            <span>{age == null ? "DOB unknown" : `age ${age} on race day`}</span>
            <i />
            <span className={!item.bib ? "missing" : ""}>{item.bib ? `bib ${item.bib}` : "bib missing"}</span>
            <i />
            <span>{item.requestedTime ? `Import ${item.requestedTime}` : "no imported time"}</span>
            {officialOutcome(item) !== "UNKNOWN" && <><i /><span className="outcome">Official: {officialOutcome(item)}</span></>}
          </p>
        </div>
        <div className="ops-result-runner-state">
          <TatChip item={item} />
          {candidate && item.verificationStatus !== "VERIFIED" && (
            <button type="button" onClick={() => notify("Review-only mode: candidate confirmation was not saved.")}>Confirm &amp; embed</button>
          )}
        </div>
      </div>
      <CandidateBlock item={item} />
      <RunnerActionBar item={item} notify={notify} />
    </div>
  );
}

function RaceQueueCard({
  group,
  open,
  onToggle,
  notify,
}: {
  group: QueueGroup;
  open: boolean;
  onToggle: () => void;
  notify: (message: string) => void;
}) {
  const pending = group.items.filter((item) => item.verificationStatus !== "VERIFIED" && item.status !== "MATCHED").length;
  const nearest = group.items
    .map((item) => ({ item, hours: tatHours(item) }))
    .filter((entry) => entry.hours != null)
    .sort((left, right) => (left.hours ?? 99999) - (right.hours ?? 99999))[0]?.item;
  const distance = group.items.find((item) => item.distanceKm != null)?.distanceKm;
  return (
    <article className={`ops-result-race-card ${open ? "open" : ""}`}>
      <button type="button" className="ops-result-race-head" onClick={onToggle}>
        <span className="ops-result-race-icon">RUN</span>
        <span className="ops-result-race-info">
          <strong>{group.name} {group.year && !group.name.includes(String(group.year)) ? group.year : ""}</strong>
          <small>
            <Pill tone={group.lane === "no_data" ? "danger" : group.lane === "verified" ? "success" : "warning"}>{laneLabel(group.lane)}</Pill>
            <i />{group.source}<i />{distance == null ? "Distance missing" : `${distance} km`}<i />{group.location || "No location"}
          </small>
        </span>
        <span className="ops-result-race-right">
          {nearest ? <TatChip item={nearest} /> : <Pill tone="success">Complete</Pill>}
          <b>{pending}<small>{pending === 1 ? "runner" : "runners"}</small></b>
          <em>{open ? "UP" : "DOWN"}</em>
        </span>
      </button>
      {open && (
        <div className="ops-result-race-body">
          <div className="ops-result-recommendation">
            <b>Likely timed by {group.source}</b>
            <span>
              {group.items.some((item) => candidateRows(item).length)
                ? "Candidate evidence is already available. Review bib, distance, time, and confidence before confirming."
                : "No usable candidate is stored yet. Check the mapping or ask the runner for their unique result link."}
            </span>
          </div>
          {group.items.map((item) => <QueueRunnerRow key={item.id} item={item} notify={notify} />)}
        </div>
      )}
    </article>
  );
}

function RunnerQueueCard({
  name,
  items,
  notify,
}: {
  name: string;
  items: OpsQueueItem[];
  notify: (message: string) => void;
}) {
  const pending = items.filter((item) => item.verificationStatus !== "VERIFIED").length;
  return (
    <article className="ops-result-race-card open">
      <div className="ops-result-race-head static">
        <span className="ops-result-avatar large">{initials(name)}</span>
        <span className="ops-result-race-info"><strong>{name}</strong><small>{items.length} results in the queue</small></span>
        <span className="ops-result-race-right"><b>{pending}<small>pending</small></b></span>
      </div>
      <div className="ops-result-race-body">
        {items.map((item) => (
          <div className="ops-result-by-runner" key={item.id}>
            <div className="ops-result-race-icon">RUN</div>
            <div><h4>{item.raceName} {item.year}</h4><p>{laneLabel(laneFor(item))} / {sourceFor(item)} / bib {item.bib || "missing"}</p></div>
            <TatChip item={item} />
            <CandidateBlock item={item} />
            <RunnerActionBar item={item} notify={notify} />
          </div>
        ))}
      </div>
    </article>
  );
}

function ResultsView({ data, query }: { data: OpsDashboardData; query: string }) {
  const [lane, setLane] = useState<ResultLane>("all");
  const [tat, setTat] = useState<TatLane>("all");
  const [mode, setMode] = useState<QueueMode>("race");
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [shown, setShown] = useState(40);
  const [toast, setToast] = useState("");

  const items = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return data.queue.filter((item) => {
      if (needle && !queueBlob(item).includes(needle)) return false;
      if (lane !== "all" && laneFor(item) !== lane) return false;
      if (tat !== "all" && tatLane(item) !== tat) return false;
      return true;
    });
  }, [data.queue, lane, query, tat]);
  const groups = useMemo(() => groupQueue(items), [items]);
  const runnerGroups = useMemo(() => {
    const grouped = new Map<string, OpsQueueItem[]>();
    for (const item of items) {
      const name = resultName(item);
      grouped.set(name, [...(grouped.get(name) || []), item]);
    }
    return Array.from(grouped.entries()).sort((left, right) => right[1].length - left[1].length);
  }, [items]);
  const laneCounts = useMemo(() => {
    const counts: Record<ResultLane, number> = { all: data.queue.length, open_decision: 0, non_finisher: 0, no_locator: 0, no_adapter: 0, no_data: 0, waiting_runner: 0, verified: 0 };
    for (const item of data.queue) counts[laneFor(item)] += 1;
    return counts;
  }, [data.queue]);
  const breached = items.filter((item) => tatLane(item) === "breached").length;
  const paused = items.filter((item) => tatLane(item) === "paused").length;
  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  };

  return (
    <section className="ops-results-exact">
      <div className="ops-result-statstrip">
        <div><strong>{count(groups.length)}</strong><span>Races</span></div>
        <div><strong>{count(items.length)}</strong><span>Runners</span></div>
        <div className={breached ? "danger" : ""}><strong>{count(breached)}</strong><span>TAT breached</span></div>
        <div className="teal"><strong>{count(paused)}</strong><span>On runner</span></div>
      </div>
      {data.queuePage.total > data.queuePage.loaded && (
        <p className="ops-queue-window">
          Showing the newest {count(data.queuePage.loaded)} of {count(data.queuePage.total)} queue rows. Use search and status filters for the loaded operational window.
        </p>
      )}
      <div className="ops-result-controls">
        <div className="ops-result-chips">
          {RESULT_LANES.map((item) => (
            <button type="button" className={lane === item.id ? "active" : ""} key={item.id} onClick={() => { setLane(item.id); setShown(40); }}>
              {item.label}<span>{count(laneCounts[item.id])}</span>
            </button>
          ))}
        </div>
        <div className="ops-result-segment">
          <button type="button" className={mode === "race" ? "active" : ""} onClick={() => setMode("race")}>By race</button>
          <button type="button" className={mode === "runner" ? "active" : ""} onClick={() => setMode("runner")}>By runner</button>
        </div>
      </div>
      <div className="ops-result-tat-filter">
        <span>TAT</span>
        {TAT_LANES.map((item) => <button type="button" className={tat === item.id ? "active" : ""} key={item.id} onClick={() => setTat(item.id)}>{item.label}</button>)}
      </div>
      <div className="ops-result-list">
        {mode === "race" && groups.slice(0, shown).map((group, index) => (
          <RaceQueueCard
            key={group.id}
            group={group}
            open={openGroup === group.id || (!!query && index < 8)}
            onToggle={() => setOpenGroup((current) => current === group.id ? null : group.id)}
            notify={notify}
          />
        ))}
        {mode === "runner" && runnerGroups.slice(0, shown).map(([name, runnerItems]) => (
          <RunnerQueueCard key={name} name={name} items={runnerItems} notify={notify} />
        ))}
        {!items.length && <Empty>Nothing matches. Clear the search or filters to see the full queue.</Empty>}
      </div>
      {shown < (mode === "race" ? groups.length : runnerGroups.length) && (
        <button className="ops-load" type="button" onClick={() => setShown((value) => value + 40)}>Show 40 more</button>
      )}
      {toast && <div className="ops-result-toast">{toast}</div>}
    </section>
  );
}

function RaceDetail({ group }: { group: RaceEditionGroup | null }) {
  if (!group) return <Empty>Select a race object to inspect it.</Empty>;
  return (
    <aside className="ops-race-detail">
      <header>
        <p className="ops-eyebrow">RACE OBJECT</p>
        <h2>{group.race.title}</h2>
        <span>{group.race.location || "No race location"} / {group.race.sport || group.race.raceType || "No sport"}</span>
      </header>
      <div className="ops-detail-stats">
        <Pill>{group.summary.editionCount} editions</Pill>
        <Pill>{group.summary.categoryCount} categories</Pill>
        <Pill>{group.summary.mappingCount} mappings</Pill>
        <Pill tone={group.summary.issueCount ? "danger" : "success"}>{group.summary.issueCount} flags</Pill>
      </div>
      <div className="ops-editions">
        {group.editions.map((edition) => (
          <details key={edition.id} open={group.editions.length <= 4}>
            <summary>
              <div><b>{edition.year}</b><strong>{edition.title}</strong></div>
              <span>{date(edition.eventDate)} / {edition.city || edition.location || "No location"}</span>
            </summary>
            <div className="ops-edition-body">
              <section>
                <h4>Categories ({edition.categories.length})</h4>
                {edition.categories.map((category) => (
                  <div className="ops-object-row" key={category.id}>
                    <span>{category.category}</span>
                    <b>{category.totalDistanceKm == null ? "Distance missing" : `${category.totalDistanceKm} km`}</b>
                    <small>{category.resultCount ?? 0} results</small>
                  </div>
                ))}
                {!edition.categories.length && <p>No categories attached.</p>}
              </section>
              <section>
                <h4>Mappings ({edition.mappings.length})</h4>
                {edition.mappings.map((mapping) => (
                  <div className="ops-object-row" key={mapping.id}>
                    <Pill tone="info">{mapping.adapterKey}</Pill>
                    <span>{mapping.rawName}</span>
                    <small>{mapping.year}</small>
                  </div>
                ))}
                {!edition.mappings.length && <p>No adapter mapping attached.</p>}
              </section>
              {!!edition.issues.length && (
                <section>
                  <h4>Edition flags</h4>
                  {edition.issues.map((issue) => (
                    <div className="ops-object-row" key={issue.id}>
                      <Pill tone={issue.severity === "high" || issue.severity === "critical" ? "danger" : "warning"}>{issue.severity}</Pill>
                      <span>{ISSUE_LABELS[issue.type] || words(issue.type)}</span>
                    </div>
                  ))}
                </section>
              )}
            </div>
          </details>
        ))}
      </div>
    </aside>
  );
}

function RacesView({ data, query }: { data: OpsDashboardData; query: string }) {
  const [sport, setSport] = useState("ALL");
  const [adapter, setAdapter] = useState("ALL");
  const [year, setYear] = useState("ALL");
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [shown, setShown] = useState(100);
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return data.catalog.groups.filter((group) => {
      if (needle && !raceBlob(group).includes(needle)) return false;
      if (sport !== "ALL" && (group.race.sport || "UNKNOWN") !== sport) return false;
      if (adapter !== "ALL" && !group.summary.adapterKeys.includes(adapter)) return false;
      if (year !== "ALL" && !group.summary.years.includes(Number(year))) return false;
      if (issuesOnly && !group.summary.issueCount) return false;
      return true;
    });
  }, [adapter, data.catalog.groups, issuesOnly, query, sport, year]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = groups.find((group) => group.race.id === selectedId) || groups[0] || null;

  return (
    <>
      <div className="ops-selectbar">
        <select value={sport} onChange={(event) => setSport(event.target.value)}>
          <option value="ALL">All sports</option>
          {data.catalog.facets.sports.map((value) => <option key={value}>{value}</option>)}
        </select>
        <select value={adapter} onChange={(event) => setAdapter(event.target.value)}>
          <option value="ALL">All adapters</option>
          {data.catalog.facets.adapterKeys.map((value) => <option key={value}>{value}</option>)}
        </select>
        <select value={year} onChange={(event) => setYear(event.target.value)}>
          <option value="ALL">All years</option>
          {data.catalog.facets.years.map((value) => <option key={value}>{value}</option>)}
        </select>
        <button className={issuesOnly ? "active" : ""} type="button" onClick={() => setIssuesOnly((value) => !value)}>Issues only</button>
        <span>{count(groups.length)} race objects</span>
      </div>
      <section className="ops-race-workspace">
        <div className="ops-race-list">
          {groups.slice(0, shown).map((group) => (
            <button
              type="button"
              className={selected?.race.id === group.race.id ? "selected" : ""}
              key={group.race.id}
              onClick={() => setSelectedId(group.race.id)}
            >
              <div>
                <Pill tone={group.summary.issueCount ? "warning" : "success"}>
                  {group.summary.issueCount ? `${group.summary.issueCount} flags` : "clean"}
                </Pill>
                <Pill>{group.race.sport || "UNKNOWN"}</Pill>
              </div>
              <h3>{group.race.title}</h3>
              <p>{group.race.location || "No race location"}</p>
              <span>{group.summary.editionCount} editions / {group.summary.categoryCount} categories / {group.summary.resultCount} results</span>
              <small>{group.summary.years.slice(0, 6).join(", ")} {group.summary.adapterKeys.join(", ")}</small>
            </button>
          ))}
          {shown < groups.length && <button className="ops-load" type="button" onClick={() => setShown((value) => value + 100)}>Show 100 more</button>}
        </div>
        <RaceDetail group={selected} />
      </section>
    </>
  );
}

function UpcomingView({ data, query }: { data: OpsDashboardData; query: string }) {
  const [mode, setMode] = useState<"db" | "adapter">("db");
  const dbItems = data.catalog.upcomingReview.items.filter((item) =>
    [item.raceTitle, item.editionTitle, item.location, ...item.adapterKeys].join(" ").toLowerCase().includes(query.toLowerCase()),
  );
  const adapterItems = data.catalog.adapterUpcoming.items
    .filter((item) => !item.matchedInDb)
    .filter((item) => [item.eventName, item.adapterName, item.location, item.categoriesText].join(" ").toLowerCase().includes(query.toLowerCase()));
  const items = mode === "db" ? dbItems : adapterItems;

  return (
    <>
      <div className="ops-toolbar">
        <button className={mode === "db" ? "active" : ""} type="button" onClick={() => setMode("db")}>
          In DB: {count(data.catalog.upcomingReview.total)}
        </button>
        <button className={mode === "adapter" ? "active" : ""} type="button" onClick={() => setMode("adapter")}>
          Adapter discovered, not in DB: {count(data.catalog.adapterUpcoming.needsAddOrReviewCount)}
        </button>
        <span>{count(items.length)} visible</span>
      </div>
      <section className="ops-upcoming-grid">
        {mode === "db" && dbItems.map((item) => (
          <article key={item.raceEditionId}>
            <div className="ops-date-box"><strong>{date(item.eventDate).split(" ")[0]}</strong><span>{date(item.eventDate).split(" ")[1] || item.daysUntil}</span></div>
            <div>
              <p>{item.daysUntil == null ? "DATE REVIEW" : `${item.daysUntil} DAYS`}</p>
              <h3>{item.raceTitle}</h3>
              <span>{item.city || item.location || "No location"} / {item.categoryCount} categories</span>
              <div className="ops-pills"><Pill tone={item.reviewLevel === "ready" ? "success" : "warning"}>{words(item.reviewLevel)}</Pill>{item.adapterKeys.map((key) => <Pill key={key}>{key}</Pill>)}</div>
            </div>
          </article>
        ))}
        {mode === "adapter" && adapterItems.map((item) => (
          <article key={`${item.adapterKey}-${item.sourceId}-${item.eventName}`}>
            <div className="ops-date-box"><strong>{date(item.eventDate).split(" ")[0]}</strong><span>{date(item.eventDate).split(" ")[1] || item.editionYear}</span></div>
            <div>
              <p>CHECK AND ADD</p>
              <h3>{item.eventName}</h3>
              <span>{item.location || item.city || "No location"} / {item.categoriesText || "Categories not captured"}</span>
              <div className="ops-pills">
                <Pill tone="danger">Not found in DB</Pill>
                <Pill tone={item.catalogStatus === "REVIEW_REQUIRED" ? "warning" : "neutral"}>{words(item.catalogStatus || "NEW")}</Pill>
                <Pill>{item.adapterName}</Pill>
                {item.lastSeenAt && <Pill>Seen {date(item.lastSeenAt)}</Pill>}
              </div>
              {item.proposalPayload != null && <small>Race / Edition / Category / Mapping proposal is ready for admin review.</small>}
            </div>
          </article>
        ))}
        {!items.length && <Empty>No upcoming races match this search.</Empty>}
      </section>
    </>
  );
}

function AdaptersView({ data, query }: { data: OpsDashboardData; query: string }) {
  const [busy, setBusy] = useState<"discovery" | "stress" | null>(null);
  const [message, setMessage] = useState("");
  const failureCounts = data.catalog.unverifiedFailed.items.reduce<Record<string, number>>((acc, item) => {
    for (const key of item.adapterKeys) acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const summaryByKey = new Map(data.catalog.adapterSummary.map((item) => [item.adapterKey, item]));
  const reliabilityByKey = new Map(data.adapterOperations.reliability.map((item) => [item.adapterKey, item]));
  const signalsByKey = new Map(data.adapterOperations.queueSignals.map((item) => [item.adapterKey, item]));
  const rows = data.adapterOperations.capabilities
    .map((capability) => ({
      capability,
      summary: summaryByKey.get(capability.adapterKey),
      reliability: reliabilityByKey.get(capability.adapterKey),
      signals: signalsByKey.get(capability.adapterKey),
    }))
    .filter(({ capability, summary }) => summary || capability.adapterKey.toLowerCase().includes(query.toLowerCase()))
    .filter(({ capability }) => [capability.adapterKey, capability.adapterName, capability.note].join(" ").toLowerCase().includes(query.toLowerCase()));
  const discovery = data.adapterOperations.discovery;
  const stress = data.adapterOperations.stress;
  const runOperation = async (operation: "discovery" | "stress") => {
    setBusy(operation);
    setMessage("");
    try {
      const response = await fetch(operation === "discovery" ? "/api/admin/adapters/discover" : "/api/admin/adapters/stress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: operation === "stress" ? JSON.stringify({ callsPerAdapter: 30, concurrencyPerAdapter: 2 }) : "{}",
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `${operation} failed`);
      setMessage(operation === "discovery" ? "Discovery completed. Refreshing live data." : "Reliability run completed. Refreshing live data.");
      window.setTimeout(() => window.location.reload(), 900);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `${operation} failed`);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <section className="ops-adapter-control-grid">
        <article>
          <p className="ops-eyebrow">NIGHTLY DISCOVERY</p>
          <h3>{discovery.status.replaceAll("_", " ")}</h3>
          <span>Last run: {stamp(discovery.lastRunAt)} / Next: {stamp(discovery.nextRunAt)}</span>
          <div><b>{count(discovery.adaptersChecked)}</b><small>adapters</small><b>{count(discovery.eventsSeen)}</b><small>upcoming seen</small><b>{count(discovery.newEvents)}</b><small>need review</small></div>
          {!discovery.configured && <p>Discovery service is not connected. Listed events are stored DB records, not a fresh scan.</p>}
          <button type="button" disabled={busy !== null || !discovery.configured} onClick={() => runOperation("discovery")}>{busy === "discovery" ? "Running..." : "Run discovery now"}</button>
        </article>
        <article>
          <p className="ops-eyebrow">RELIABILITY</p>
          <h3>{stress.successRate == null ? "No run" : `${(stress.successRate * 100).toFixed(1)}% success`}</h3>
          <span>{count(stress.calls)} controlled calls / {count(stress.errors)} failures / {stress.source}</span>
          <div><b>{count(stress.adaptersChecked)}</b><small>adapters</small><b>{count(stress.calls)}</b><small>calls</small><b>{count(stress.errors)}</b><small>failures</small></div>
          {!stress.configured && <p>Stress-test service is not connected. Any displayed run is historical.</p>}
          <button type="button" disabled={busy !== null || !stress.configured} onClick={() => runOperation("stress")}>{busy === "stress" ? "Testing..." : "Run safe stress test"}</button>
        </article>
        <article className="ops-adapter-policy">
          <p className="ops-eyebrow">MATCH POLICY</p>
          <h3>Name and bib first</h3>
          <span>Age and gender are not sent as hard search filters. They are used only to rank or reject ambiguous candidates after the adapter returns them.</span>
          <div><b>ALL</b><small>categories searched</small><b>0</b><small>age-filtered</small><b>0</b><small>gender-filtered</small></div>
        </article>
      </section>
      {message && <div className="ops-adapter-message">{message}</div>}
      <section className="ops-adapter-matrix">
        <div className="ops-adapter-matrix-head">
          <span>Adapter and search behavior</span><span>Catalog</span><span>Age / gender</span><span>Official outcomes</span><span>Reliability</span><span>State</span>
        </div>
        {rows.map(({ capability, summary, reliability, signals }) => {
          const failures = failureCounts[capability.adapterKey] || 0;
          const nonFinishers = (signals?.dnsRows || 0) + (signals?.dnfRows || 0) + (signals?.dqRows || 0);
          const successRate = reliability?.successRate;
          const signalTone = successRate == null ? "warning" : successRate >= 0.98 && !failures ? "success" : successRate >= 0.9 ? "warning" : "danger";
        return (
          <article key={capability.adapterKey}>
            <div className="ops-adapter-identity">
              <strong><i className={failures ? "warn" : ""} />{capability.adapterName}</strong>
              <small>{capability.adapterKey} / {words(capability.categorySearch)}</small>
              <p>{capability.note}</p>
            </div>
            <div><b>{count(summary?.mappings)}</b><small>mappings</small><span>{count(summary?.editions)} editions / {count(summary?.races)} races</span></div>
            <div><b>No / No</b><small>used to find</small><span>{capability.capturesAge ? "Age captured" : "No age"} / {capability.capturesGender ? "gender captured" : "no gender"}</span></div>
            <div><b>{count(nonFinishers)}</b><small>DNS/DNF/DQ found</small><span>{count(signals?.linksWithoutStructuredData)} linked no-data / {count(signals?.openDecisionRows)} open</span></div>
            <div><b>{successRate == null ? "Not tested" : `${(successRate * 100).toFixed(1)}%`}</b><small>{count(reliability?.calls)} calls</small><span>{reliability?.p95LatencyMs == null ? "No latency" : `p95 ${(reliability.p95LatencyMs / 1000).toFixed(1)}s`}</span></div>
            <div><Pill tone={signalTone}>{signalTone === "success" ? "Healthy" : signalTone === "danger" ? "At risk" : "Review"}</Pill><small>{count(failures)} verification failures</small></div>
          </article>
        );
      })}
      {!rows.length && <Empty>No adapters match this search.</Empty>}
      </section>
    </>
  );
}

function FlagsView({ data, query }: { data: OpsDashboardData; query: string }) {
  const [severity, setSeverity] = useState("ALL");
  const [type, setType] = useState("ALL");
  const [shown, setShown] = useState(100);
  const items = data.catalog.issues.filter((issue) => {
    const blob = [issue.raceTitle, issue.editionTitle, issue.categoryTitle, issue.adapterKey, issue.title, issue.detail].join(" ").toLowerCase();
    if (query && !blob.includes(query.toLowerCase())) return false;
    if (severity !== "ALL" && issue.severity !== severity) return false;
    if (type !== "ALL" && issue.type !== type) return false;
    return true;
  });
  return (
    <>
      <div className="ops-selectbar">
        <select value={severity} onChange={(event) => setSeverity(event.target.value)}>
          <option value="ALL">All severities</option>
          {Object.keys(data.catalog.issueSummary.bySeverity).map((value) => <option key={value} value={value}>{words(value)}</option>)}
        </select>
        <select value={type} onChange={(event) => setType(event.target.value)}>
          <option value="ALL">All issue types</option>
          {Object.keys(data.catalog.issueSummary.byType).map((value) => <option key={value} value={value}>{ISSUE_LABELS[value] || words(value)}</option>)}
        </select>
        <span>{count(items.length)} matching flags</span>
      </div>
      <section className="ops-flag-list">
        {items.slice(0, shown).map((issue) => <Flag key={issue.id} issue={issue} />)}
        {!items.length && <Empty>No quality flags match these filters.</Empty>}
      </section>
      {shown < items.length && <button className="ops-load" type="button" onClick={() => setShown((value) => value + 100)}>Show 100 more</button>}
    </>
  );
}

function Flag({ issue }: { issue: DashboardIssue }) {
  return (
    <article>
      <Pill tone={issue.severity === "critical" || issue.severity === "high" ? "danger" : issue.severity === "medium" ? "warning" : "info"}>
        {issue.severity}
      </Pill>
      <div>
        <h3>{ISSUE_LABELS[issue.type] || issue.title}</h3>
        <p>{issue.detail}</p>
        <span>{issue.raceTitle || "Unknown race"} {issue.year ? `/ ${issue.year}` : ""} {issue.editionTitle ? `/ ${issue.editionTitle}` : ""}</span>
      </div>
    </article>
  );
}

function UsersView({ data, query }: { data: OpsDashboardData; query: string }) {
  const users = data.users.filter((user) =>
    [user.name, user.location, user.onboardingStatus].join(" ").toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <section className="ops-user-grid">
      {users.map((user) => (
        <article key={user.id}>
          <div className="ops-avatar">{initials(user.name)}</div>
          <div className="ops-user-title">
            <h3>{user.name}</h3>
            <p>{user.location || "No location"}</p>
          </div>
          <Pill tone={user.onboardingStatus === "COMPLETED" ? "success" : "warning"}>{words(user.onboardingStatus)}</Pill>
          <div className="ops-user-stats">
            <span><b>{user.claimCount}</b>claims</span>
            <span><b>{user.personalBestCount}</b>PBs</span>
            <span><b>{user.unmatchedCount}</b>imports</span>
            <span><b>{user.verifiedCount}</b>verified</span>
            <span><b>{user.gmailImportCount}</b>Gmail</span>
            <span><b>{user.stravaImportCount}</b>Strava</span>
          </div>
        </article>
      ))}
      {!users.length && <Empty>No users match this search.</Empty>}
    </section>
  );
}

function LogsView({ data, query }: { data: OpsDashboardData; query: string }) {
  const logs = data.logs.filter((log) =>
    [log.eventType, log.status, log.lastError].join(" ").toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <section className="ops-log-list">
      {logs.map((log) => (
        <article key={log.id}>
          <i className={log.status === "FAILED" ? "failed" : log.status === "PROCESSING" ? "working" : ""} />
          <div><h3>{words(log.eventType)}</h3><p>{log.lastError || `${words(log.status)} without a recorded error`}</p></div>
          <Pill tone={log.status === "FAILED" ? "danger" : log.status === "PROCESSING" ? "warning" : "success"}>{words(log.status)}</Pill>
          <span>{stamp(log.createdAt)} / {log.attempts} attempt{log.attempts === 1 ? "" : "s"}</span>
        </article>
      ))}
      {!logs.length && <Empty>No activity matches this search.</Empty>}
    </section>
  );
}

export default function OpsDashboard({ data }: { data: OpsDashboardData }) {
  const [view, setView] = useState<View>("dashboard");
  const [query, setQuery] = useState("");
  const counts: Partial<Record<View, number>> = {
    results: data.breakdowns.queueStatus.filter((item) => ["IN_REVIEW", "PENDING"].includes(item.key)).reduce((sum, item) => sum + item.count, 0),
    races: data.catalog.counts.races,
    upcoming: data.catalog.upcomingReview.total + data.catalog.adapterUpcoming.needsAddOrReviewCount,
    adapters: data.catalog.adapterSummary.length,
    flags: data.catalog.issueSummary.total,
    users: data.users.length,
  };
  const copy = VIEW_COPY[view];
  const go = (next: View) => {
    setView(next);
    setQuery("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className="ops-shell">
      <aside className="ops-sidebar">
        <div className="ops-brand">
          <div>W</div>
          <span><strong>W<i>O</i>NE</strong><small>Ops console</small></span>
        </div>
        <nav>
          {VIEWS.map((item) => (
            <button className={view === item.id ? "active" : ""} type="button" key={item.id} onClick={() => go(item.id)}>
              <b>{item.mark}</b><span>{item.label}</span>{counts[item.id] != null && <em>{count(counts[item.id])}</em>}
            </button>
          ))}
        </nav>
        <div className="ops-sidebar-foot">
          <div>PR</div><span><strong>Production</strong><small>Audited admin actions</small></span>
        </div>
      </aside>
      <main className={`ops-main ${view === "results" ? "ops-results-mode" : ""}`}>
        <header className="ops-topbar">
          <div><h1>{copy.title}</h1><p>{copy.subtitle}</p></div>
          {view !== "dashboard" && (
            <label className="ops-search">
              <span>Search</span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Race, runner, bib, category, adapter..." />
              {query && <button type="button" onClick={() => setQuery("")}>Clear</button>}
            </label>
          )}
        </header>
        <div className={`ops-content ${view === "results" ? "ops-results-content" : ""}`}>
          {view === "dashboard" && <DashboardView data={data} go={go} />}
          {view === "results" && <ResultsView data={data} query={query} />}
          {view === "races" && <RacesView data={data} query={query} />}
          {view === "upcoming" && <UpcomingView data={data} query={query} />}
          {view === "adapters" && <AdaptersView data={data} query={query} />}
          {view === "flags" && <FlagsView data={data} query={query} />}
          {view === "users" && <UsersView data={data} query={query} />}
          {view === "logs" && <LogsView data={data} query={query} />}
        </div>
      </main>
    </div>
  );
}
