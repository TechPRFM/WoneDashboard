import "server-only";

import { getDashboardData, getPool } from "./db";
import { loadAdapterOperations, type AdapterOperationsData } from "./adapter-ops";
import type { DashboardData } from "./quality";

export type OpsUser = {
  id: string;
  name: string;
  location: string | null;
  onboardingStatus: string | null;
  isAdmin: boolean;
  createdAt: string;
  claimCount: number;
  personalBestCount: number;
  unmatchedCount: number;
  verifiedCount: number;
  gmailImportCount: number;
  stravaImportCount: number;
};

export type OpsQueueItem = {
  id: string;
  userId: string | null;
  userName: string | null;
  raceName: string | null;
  year: number | null;
  bib: string | null;
  participantName: string | null;
  category: string | null;
  requestedTime: string | null;
  distanceKm: number | null;
  eventDate: string | null;
  location: string | null;
  gender: string | null;
  ageAtEvent: number | null;
  stravaActivityId: string | null;
  sport: string | null;
  source: string | null;
  status: string | null;
  verificationStatus: string | null;
  participationOutcome: "DNS" | "DNF" | "NON_TIMED" | null;
  failureCode: string | null;
  verificationError: string | null;
  userAction: string | null;
  attempts: number;
  scrapeCount: number;
  timingLink: string | null;
  matchedRaceEditionId: string | null;
  matchedResultId: string | null;
  verifiedBib: string | null;
  verifiedTime: string | null;
  verifiedLink: string | null;
  adapterKeys: string[];
  candidates: unknown;
  createdAt: string;
  updatedAt: string;
  retryAfter: string | null;
};

export type OpsLog = {
  id: string;
  eventType: string;
  status: string;
  attempts: number;
  createdAt: string;
  processedAt: string | null;
  lastError: string | null;
};

export type OpsBreakdown = {
  key: string;
  count: number;
};

export type OpsDashboardData = {
  catalog: DashboardData;
  adapterOperations: AdapterOperationsData;
  users: OpsUser[];
  queue: OpsQueueItem[];
  logs: OpsLog[];
  queuePage: { loaded: number; total: number; limit: number };
  breakdowns: {
    queueStatus: OpsBreakdown[];
    verificationStatus: OpsBreakdown[];
    gmailMatchStatus: OpsBreakdown[];
    stravaMatchStatus: OpsBreakdown[];
    outboxStatus: OpsBreakdown[];
    onboardingStatus: OpsBreakdown[];
  };
};

function iso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function breakdown(rows: Array<{ key: string | null; count: number }>): OpsBreakdown[] {
  return rows.map((row) => ({ key: row.key ?? "UNKNOWN", count: Number(row.count) }));
}

export async function getOpsDashboardData(): Promise<OpsDashboardData> {
  const pool = getPool();
  const [catalog, operations, adapterOperations] = await Promise.all([
    getDashboardData(),
    loadOperationsData(),
    loadAdapterOperations(pool),
  ]);
  return { catalog, adapterOperations, ...operations };
}

async function loadOperationsData(): Promise<Omit<OpsDashboardData, "catalog" | "adapterOperations">> {
  const pool = getPool();
  const [
      usersResult,
      queueResult,
      logsResult,
      queueStatusResult,
      verificationStatusResult,
      gmailStatusResult,
      stravaStatusResult,
      outboxStatusResult,
      onboardingStatusResult,
    ] = await Promise.all([
      pool.query<OpsUser>(`
        with
          claims as (
            select "userId", count(*)::int as count
            from public."ResultClaim"
            group by "userId"
          ),
          bests as (
            select "userId", count(*)::int as count
            from public.personal_bests
            group by "userId"
          ),
          unmatched as (
            select
              "userId",
              count(*)::int as count,
              count(*) filter (where "verificationStatus"::text = 'VERIFIED')::int as verified
            from public.unmatched_race_entries
            group by "userId"
          ),
          gmail as (
            select "userId", count(*)::int as count
            from public.gmail_import_results
            group by "userId"
          ),
          strava as (
            select "userId", count(*)::int as count
            from public.strava_import_results
            group by "userId"
          )
        select
          u.id,
          trim(concat_ws(' ', u."firstName", u."middleName", u."lastName")) as name,
          nullif(concat_ws(', ', u.city, u.state, u.country), '') as location,
          u."onboardingStatus"::text as "onboardingStatus",
          coalesce(u."isAdmin", false) as "isAdmin",
          u."createdAt"::text as "createdAt",
          coalesce(claims.count, 0)::int as "claimCount",
          coalesce(bests.count, 0)::int as "personalBestCount",
          coalesce(unmatched.count, 0)::int as "unmatchedCount",
          coalesce(unmatched.verified, 0)::int as "verifiedCount",
          coalesce(gmail.count, 0)::int as "gmailImportCount",
          coalesce(strava.count, 0)::int as "stravaImportCount"
        from public.users u
        left join claims on claims."userId" = u.id
        left join bests on bests."userId" = u.id
        left join unmatched on unmatched."userId" = u.id
        left join gmail on gmail."userId" = u.id
        left join strava on strava."userId" = u.id
        order by "unmatchedCount" desc, u."createdAt" desc
        limit 500
      `),
      pool.query<OpsQueueItem>(`
        select
          entry.id,
          entry."userId",
          nullif(trim(concat_ws(' ', usr."firstName", usr."middleName", usr."lastName")), '') as "userName",
          entry."raceName",
          entry.year,
          entry.bib,
          entry.name as "participantName",
          entry.category,
          entry.time as "requestedTime",
          entry."distanceKm",
          entry.date::text as "eventDate",
          max(coalesce(entry.location, matched_edition.location, matched_race.location)) as location,
          usr.gender::text as gender,
          case
            when usr."dateOfBirth" is not null and entry.date is not null
            then extract(year from age(entry.date::date, usr."dateOfBirth"::date))::int
            else null
          end as "ageAtEvent",
          entry."stravaActivityId",
          entry.sport::text as sport,
          entry.source::text as source,
          entry.status::text as status,
          entry."verificationStatus"::text as "verificationStatus",
          entry."participationOutcome"::text as "participationOutcome",
          entry."verificationFailureCode" as "failureCode",
          entry."verificationError",
          entry."verificationUserAction" as "userAction",
          coalesce(entry."verificationAttempts", 0)::int as attempts,
          coalesce(entry."scrapeCount", 0)::int as "scrapeCount",
          entry."timingLink",
          entry."matchedRaceEditionId",
          entry."matchedResultId",
          max(verified_result."bibNumber") as "verifiedBib",
          max(coalesce(verified_result."chipTime", verified_result."totalTime")) as "verifiedTime",
          max(verified_result."timingLink") as "verifiedLink",
          coalesce(array_remove(array_agg(distinct mapping."adapterKey"), null), '{}') as "adapterKeys",
          entry."verificationCandidates" as candidates,
          entry."createdAt"::text as "createdAt",
          entry."updatedAt"::text as "updatedAt",
          entry."verificationRetryAfter"::text as "retryAfter"
        from public.unmatched_race_entries entry
        left join public.results verified_result on verified_result.id = entry."matchedResultId"
        left join public.users usr on usr.id = entry."userId"
        left join public.race_editions matched_edition on matched_edition.id = entry."matchedRaceEditionId"
        left join public.races matched_race on matched_race.id = matched_edition."raceId"
        left join public.race_edition_mappings mapping
          on mapping."raceEditionId" = entry."matchedRaceEditionId"
        group by entry.id, usr.id
        order by entry."updatedAt" desc, entry.id
        limit 500
      `),
      pool.query<OpsLog>(`
        select
          id,
          "eventType",
          status::text as status,
          attempts,
          "createdAt"::text as "createdAt",
          "processedAt"::text as "processedAt",
          "lastError"
        from public.outbox_events
        order by "createdAt" desc
        limit 250
      `),
      pool.query<{ key: string | null; count: number }>(`
        select status::text as key, count(*)::int as count
        from public.unmatched_race_entries group by status order by count desc
      `),
      pool.query<{ key: string | null; count: number }>(`
        select "verificationStatus"::text as key, count(*)::int as count
        from public.unmatched_race_entries group by "verificationStatus" order by count desc
      `),
      pool.query<{ key: string | null; count: number }>(`
        select "matchStatus"::text as key, count(*)::int as count
        from public.gmail_import_results group by "matchStatus" order by count desc
      `),
      pool.query<{ key: string | null; count: number }>(`
        select "matchStatus"::text as key, count(*)::int as count
        from public.strava_import_results group by "matchStatus" order by count desc
      `),
      pool.query<{ key: string | null; count: number }>(`
        select status::text as key, count(*)::int as count
        from public.outbox_events group by status order by count desc
      `),
      pool.query<{ key: string | null; count: number }>(`
        select "onboardingStatus"::text as key, count(*)::int as count
        from public.users group by "onboardingStatus" order by count desc
      `),
    ]);

  return {
      users: usersResult.rows.map((user) => ({
        ...user,
        name: user.name || "Unnamed user",
        createdAt: iso(user.createdAt) ?? "",
        claimCount: Number(user.claimCount),
        personalBestCount: Number(user.personalBestCount),
        unmatchedCount: Number(user.unmatchedCount),
        verifiedCount: Number(user.verifiedCount),
        gmailImportCount: Number(user.gmailImportCount),
        stravaImportCount: Number(user.stravaImportCount),
      })),
      queue: queueResult.rows.map((item) => ({
        ...item,
        attempts: Number(item.attempts),
        scrapeCount: Number(item.scrapeCount),
        adapterKeys: Array.isArray(item.adapterKeys) ? item.adapterKeys : [],
        eventDate: iso(item.eventDate),
        createdAt: iso(item.createdAt) ?? "",
        updatedAt: iso(item.updatedAt) ?? "",
        retryAfter: iso(item.retryAfter),
      })),
      logs: logsResult.rows.map((log) => ({
        ...log,
        attempts: Number(log.attempts),
        createdAt: iso(log.createdAt) ?? "",
        processedAt: iso(log.processedAt),
      })),
      queuePage: {
        loaded: queueResult.rows.length,
        total: queueStatusResult.rows.reduce((sum, row) => sum + Number(row.count), 0),
        limit: 500,
      },
      breakdowns: {
        queueStatus: breakdown(queueStatusResult.rows),
        verificationStatus: breakdown(verificationStatusResult.rows),
        gmailMatchStatus: breakdown(gmailStatusResult.rows),
        stravaMatchStatus: breakdown(stravaStatusResult.rows),
        outboxStatus: breakdown(outboxStatusResult.rows),
        onboardingStatus: breakdown(onboardingStatusResult.rows),
      },
    };
}
