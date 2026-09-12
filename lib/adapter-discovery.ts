import "server-only";
import { createHash } from "node:crypto";
import { getAdapterOpsWritePool } from "./adapter-ops-write-db";

export class AdapterServiceError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
type DiscoveryEvent = {
  adapterKey: string;
  adapterName?: string;
  eventName: string;
  editionYear?: number;
  eventDate?: string;
  location?: string;
  city?: string;
  sourceId?: string;
  externalEventKey?: string;
  categories?: string[];
  rawPayload?: unknown;
};

function dedupeKey(event: DiscoveryEvent) {
  return [event.adapterKey, event.sourceId || event.externalEventKey, event.eventName, event.editionYear, event.eventDate]
    .map((value) => String(value || "").trim().toLowerCase())
    .join("|");
}

export async function executeDiscovery(trigger: "CRON" | "MANUAL" = "CRON") {
  const endpoint = process.env.ADAPTER_DISCOVERY_URL;
  if (!endpoint) throw new AdapterServiceError("ADAPTER_DISCOVERY_URL is not configured.", 503);
  if (!process.env.ADAPTER_SERVICE_TOKEN) throw new AdapterServiceError("ADAPTER_SERVICE_TOKEN is not configured.", 503);
  const startedAt = new Date();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.ADAPTER_SERVICE_TOKEN ? { Authorization: `Bearer ${process.env.ADAPTER_SERVICE_TOKEN}` } : {}),
    },
    body: JSON.stringify({
      fromDate: startedAt.toISOString().slice(0, 10),
      throughYear: startedAt.getUTCFullYear() + 2,
      includeCategories: true,
      mode: "upcoming",
    }),
    signal: AbortSignal.timeout(240_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new AdapterServiceError(payload.error || `Adapter discovery returned ${response.status}.`, 502);
  if (!Array.isArray(payload.events) || !Array.isArray(payload.adapters) || !payload.adapters.length) {
    throw new AdapterServiceError("Discovery service did not return a valid adapter scan. No data was changed.", 502);
  }
  const events: DiscoveryEvent[] = Array.isArray(payload.events) ? payload.events : [];
  const adapterResults = Array.isArray(payload.adapters) ? payload.adapters : [];
  const pool = getAdapterOpsWritePool();
  const runId = crypto.randomUUID();
  let inserted = 0;

  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const event of events) {
      if (!event.adapterKey || !event.eventName) continue;
      const key = dedupeKey(event);
      const raw = event.rawPayload ?? event;
      const result = await client.query(`
        insert into public.adapter_upcoming_events (
          "dedupeKey","adapterKey","adapterName","eventName","editionYear","eventDate",location,city,
          "sourceId","externalKeyGuess","categoriesText","upcomingSource","upcomingStatus","asOfDate","rawPayload",
          "catalogStatus","lastSeenAt","updatedAt"
        ) values (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
          'nightly-cron','upcoming_date_confirmed',current_date,$12::jsonb,'NEW',now(),now()
        )
        on conflict ("dedupeKey") do update set
          "adapterName"=excluded."adapterName","eventName"=excluded."eventName","editionYear"=excluded."editionYear",
          "eventDate"=excluded."eventDate",location=excluded.location,city=excluded.city,"sourceId"=excluded."sourceId",
          "externalKeyGuess"=excluded."externalKeyGuess","categoriesText"=excluded."categoriesText",
          "asOfDate"=current_date,"rawPayload"=excluded."rawPayload","lastSeenAt"=now(),"updatedAt"=now()
        returning (xmax = 0) as inserted
      `, [
        createHash("sha1").update(key).digest("hex"),
        event.adapterKey,
        event.adapterName || event.adapterKey,
        event.eventName,
        event.editionYear || null,
        event.eventDate || null,
        event.location || null,
        event.city || null,
        event.sourceId || null,
        event.externalEventKey || event.sourceId || null,
        event.categories?.join(", ") || null,
        JSON.stringify(raw),
      ]);
      if (result.rows[0]?.inserted) inserted += 1;
    }

    // Exact external-key/raw-name matches may be linked automatically. Everything else
    // receives a complete proposal for review instead of using fuzzy catalog mutation.
    await client.query(`
      with exact_matches as (
        select discovered."dedupeKey", matched."raceId", matched."raceEditionId"
        from public.adapter_upcoming_events discovered
        join lateral (
          select min(mapping."raceId") as "raceId", min(mapping."raceEditionId") as "raceEditionId"
          from public.race_edition_mappings mapping
          where mapping."adapterKey" = discovered."adapterKey"
            and (
              (nullif(discovered."externalKeyGuess", '') is not null and mapping."externalEventKey" = discovered."externalKeyGuess")
              or (nullif(discovered."sourceId", '') is not null and mapping."externalEventKey" = discovered."sourceId")
              or (lower(trim(mapping."rawName")) = lower(trim(discovered."eventName")) and mapping.year = discovered."editionYear")
            )
          having count(distinct (mapping."raceId", mapping."raceEditionId")) = 1
        ) matched on true
        where discovered."asOfDate" = current_date
      )
      update public.adapter_upcoming_events discovered
      set
        "catalogStatus" = 'AUTO_MAPPED',
        "matchedRaceId" = matched."raceId",
        "matchedRaceEditionId" = matched."raceEditionId",
        "proposalPayload" = null,
        "updatedAt" = now()
      from exact_matches matched
      where discovered."dedupeKey" = matched."dedupeKey"
    `);
    await client.query(`
      update public.adapter_upcoming_events
      set
        "catalogStatus" = 'REVIEW_REQUIRED',
        "proposalPayload" = jsonb_build_object(
          'race', jsonb_build_object(
            'title', trim(regexp_replace("eventName", '\\s+(19|20)\\d{2}\\s*$', '', 'i')),
            'location', coalesce(city, location),
            'raceType', null
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
        ),
        "updatedAt" = now()
      where "asOfDate" = current_date
        and "catalogStatus" <> 'AUTO_MAPPED'
    `);
    const proposalCount = await client.query<{ count: number }>(`
      select count(*)::int as count
      from public.adapter_upcoming_events
      where "asOfDate" = current_date and "catalogStatus" = 'REVIEW_REQUIRED'
    `);

    await client.query(`
      insert into public.adapter_ops_runs (
        id,operation,trigger,status,"startedAt","finishedAt","adapterCount","eventsSeen","newEvents","totalCalls","successCount","failureCount",metadata
      ) values ($1,'DISCOVERY',$8,'COMPLETED',$2,now(),$3,$4,$5,0,0,$6,$7::jsonb)
    `, [runId, startedAt, adapterResults.length, events.length, inserted, adapterResults.filter((item: { success?: boolean }) => item.success === false).length, JSON.stringify({ ...(payload.summary || {}), proposalCount: Number(proposalCount.rows[0]?.count || 0) }), trigger]);
    for (const result of adapterResults) {
      await client.query(`
        insert into public.adapter_ops_adapter_results (
          "runId","adapterKey",calls,success,failure,"successRate","p50LatencyMs","p95LatencyMs","statusCounts",error
        ) values ($1,$2,0,$3,$4,$5,$6,$7,$8::jsonb,$9)
      `, [
        runId,
        result.adapterKey,
        result.success ? 1 : 0,
        result.success ? 0 : 1,
        result.success ? 1 : 0,
        result.latencyMs || null,
        result.latencyMs || null,
        JSON.stringify(result.statusCounts || {}),
        result.error || null,
      ]);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  return { ok: true, runId, adaptersChecked: adapterResults.length, eventsSeen: events.length, newEvents: inserted };
}


