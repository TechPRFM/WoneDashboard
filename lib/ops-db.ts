import "server-only";

import { getDashboardData, getPool } from "./db";
import type { DashboardData } from "./quality";

export type OpsUser = {
  id: string;
  name: string;
  email: string | null;
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
  dateOfBirth: string | null;
  source: string | null;
  status: string | null;
  verificationStatus: string | null;
  failureCode: string | null;
  verificationError: string | null;
  userAction: string | null;
  attempts: number;
  scrapeCount: number;
  timingLink: string | null;
  matchedRaceEditionId: string | null;
  matchedResultId: string | null;
  adapterKeys: string[];
  candidates: unknown;
  diagnostics: unknown;
  rawRowData: unknown;
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
  users: OpsUser[];
  queue: OpsQueueItem[];
  logs: OpsLog[];
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
  const [catalog, operations] = await Promise.all([getDashboardData(), loadOperationsData()]);
  return { catalog, ...operations };
}

async function loadOperationsData(): Promise<Omit<OpsDashboardData, "catalog">> {
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
          u.email,
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
          usr."dateOfBirth"::text as "dateOfBirth",
          entry.source::text as source,
          entry.status::text as status,
          entry."verificationStatus"::text as "verificationStatus",
          entry."verificationFailureCode" as "failureCode",
          entry."verificationError",
          entry."verificationUserAction" as "userAction",
          coalesce(entry."verificationAttempts", 0)::int as attempts,
          coalesce(entry."scrapeCount", 0)::int as "scrapeCount",
          entry."timingLink",
          entry."matchedRaceEditionId",
          entry."matchedResultId",
          coalesce(array_remove(array_agg(distinct mapping."adapterKey"), null), '{}') as "adapterKeys",
          entry."verificationCandidates" as candidates,
          entry."verificationDiagnostics" as diagnostics,
          entry."rawRowData",
          entry."createdAt"::text as "createdAt",
          entry."updatedAt"::text as "updatedAt",
          entry."verificationRetryAfter"::text as "retryAfter"
        from public.unmatched_race_entries entry
        left join public.users usr on usr.id = entry."userId"
        left join public.race_editions matched_edition on matched_edition.id = entry."matchedRaceEditionId"
        left join public.races matched_race on matched_race.id = matched_edition."raceId"
        left join public.race_edition_mappings mapping
          on mapping."raceEditionId" = entry."matchedRaceEditionId"
        group by entry.id, usr.id
        order by
          case entry."verificationStatus"::text
            when 'FAILED' then 0
            when 'IDLE' then 1
            else 2
          end,
          entry."updatedAt" desc
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
        name: user.name || user.email || "Unnamed user",
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
        dateOfBirth: iso(item.dateOfBirth),
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
