begin;

create extension if not exists pgcrypto;

create table if not exists public.adapter_upcoming_events (
  "dedupeKey" text primary key,
  "adapterKey" text not null,
  "adapterName" text,
  "eventName" text not null,
  "editionYear" integer,
  "eventDate" date,
  location text,
  city text,
  "sourceId" text,
  "externalKeyGuess" text,
  "categoriesText" text,
  "upcomingSource" text,
  "upcomingStatus" text,
  "asOfDate" date,
  "rawPayload" jsonb,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create table if not exists public.adapter_ops_runs (
  id text primary key,
  operation text not null check (operation in ('DISCOVERY', 'STRESS')),
  trigger text not null check (trigger in ('CRON', 'MANUAL', 'CLI')),
  status text not null check (status in ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED')),
  "startedAt" timestamptz not null default now(),
  "finishedAt" timestamptz,
  "adapterCount" integer not null default 0,
  "eventsSeen" integer not null default 0,
  "newEvents" integer not null default 0,
  "totalCalls" integer not null default 0,
  "successCount" integer not null default 0,
  "failureCount" integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  error text
);

create index if not exists adapter_ops_runs_operation_started_idx
  on public.adapter_ops_runs (operation, "startedAt" desc);

create table if not exists public.adapter_ops_adapter_results (
  id bigint generated always as identity primary key,
  "runId" text not null references public.adapter_ops_runs(id) on delete cascade,
  "adapterKey" text not null,
  calls integer not null default 0,
  success integer not null default 0,
  failure integer not null default 0,
  "successRate" double precision,
  "p50LatencyMs" double precision,
  "p95LatencyMs" double precision,
  "statusCounts" jsonb not null default '{}'::jsonb,
  error text,
  unique ("runId", "adapterKey")
);

create index if not exists adapter_ops_adapter_results_adapter_idx
  on public.adapter_ops_adapter_results ("adapterKey");

alter table public.adapter_upcoming_events
  add column if not exists "catalogStatus" text not null default 'NEW',
  add column if not exists "matchedRaceId" text,
  add column if not exists "matchedRaceEditionId" text,
  add column if not exists "proposalPayload" jsonb,
  add column if not exists "lastSeenAt" timestamptz not null default now();

create index if not exists adapter_upcoming_events_catalog_status_idx
  on public.adapter_upcoming_events ("catalogStatus", "eventDate");

comment on column public.adapter_upcoming_events."catalogStatus" is
  'NEW, REVIEW_REQUIRED, AUTO_MAPPED, APPROVED, or IGNORED. Ambiguous discovery rows must not mutate the canonical race hierarchy.';

with exact_matches as (
  select discovered."dedupeKey", matched."raceId", matched."raceEditionId"
  from public.adapter_upcoming_events discovered
  join lateral (
    select mapping."raceId", mapping."raceEditionId"
    from public.race_edition_mappings mapping
    where mapping."adapterKey" = discovered."adapterKey"
      and (
        (nullif(discovered."externalKeyGuess", '') is not null and mapping."externalEventKey" = discovered."externalKeyGuess")
        or (nullif(discovered."sourceId", '') is not null and mapping."externalEventKey" = discovered."sourceId")
        or (lower(trim(mapping."rawName")) = lower(trim(discovered."eventName")) and mapping.year = discovered."editionYear")
      )
    order by mapping."updatedAt" desc
    limit 1
  ) matched on true
)
update public.adapter_upcoming_events discovered
set
  "catalogStatus" = 'AUTO_MAPPED',
  "matchedRaceId" = matched."raceId",
  "matchedRaceEditionId" = matched."raceEditionId",
  "proposalPayload" = null
from exact_matches matched
where discovered."dedupeKey" = matched."dedupeKey";

update public.adapter_upcoming_events
set
  "catalogStatus" = 'REVIEW_REQUIRED',
  "proposalPayload" = jsonb_build_object(
    'race', jsonb_build_object(
      'title', trim(regexp_replace("eventName", '\s+(19|20)\d{2}\s*$', '', 'i')),
      'location', coalesce(city, location),
      'raceType', 'Running'
    ),
    'edition', jsonb_build_object(
      'title', "eventName",
      'year', "editionYear",
      'eventDate', "eventDate",
      'location', location,
      'city', city
    ),
    'categories', coalesce(to_jsonb(string_to_array(nullif("categoriesText", ''), ',')), '[]'::jsonb),
    'mapping', jsonb_build_object(
      'rawName', "eventName",
      'year', "editionYear",
      'adapterKey', "adapterKey",
      'externalEventKey', coalesce("externalKeyGuess", "sourceId")
    )
  )
where "catalogStatus" <> 'AUTO_MAPPED';

commit;
