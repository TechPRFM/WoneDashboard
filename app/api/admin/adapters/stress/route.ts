import { NextRequest, NextResponse } from "next/server";

import { getAdapterOpsWritePool } from "../../../../../lib/adapter-ops-write-db";
import { requireOpsApi } from "../../../../../lib/ops-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const denied = await requireOpsApi();
  if (denied) return denied;
  const endpoint = process.env.ADAPTER_STRESS_URL;
  if (!endpoint) return NextResponse.json({ error: "ADAPTER_STRESS_URL is not configured." }, { status: 503 });
  const body = await request.json().catch(() => ({}));
  const callsPerAdapter = Math.min(100, Math.max(1, Number(body.callsPerAdapter) || 30));
  const concurrencyPerAdapter = Math.min(3, Math.max(1, Number(body.concurrencyPerAdapter) || 2));
  const startedAt = new Date();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.ADAPTER_SERVICE_TOKEN ? { Authorization: `Bearer ${process.env.ADAPTER_SERVICE_TOKEN}` } : {}),
    },
    body: JSON.stringify({ callsPerAdapter, concurrencyPerAdapter, delayMs: 250, timeoutSeconds: 35 }),
    signal: AbortSignal.timeout(240_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) return NextResponse.json({ error: payload.error || `Stress service returned ${response.status}.` }, { status: response.status });

  const rows = Object.entries(payload.byAdapter || {}) as Array<[string, Record<string, unknown>]>;
  const overall = payload.overall || {};
  const runId = crypto.randomUUID();
  const pool = getAdapterOpsWritePool();
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`
      insert into public.adapter_ops_runs (
        id,operation,trigger,status,"startedAt","finishedAt","adapterCount","eventsSeen","newEvents","totalCalls","successCount","failureCount",metadata
      ) values ($1,'STRESS','MANUAL','COMPLETED',$2,now(),$3,0,0,$4,$5,$6,$7::jsonb)
    `, [runId, startedAt, rows.length, overall.calls || 0, overall.success || 0, overall.failure || 0, JSON.stringify(payload.parameters || {})]);
    for (const [adapterKey, result] of rows) {
      const latency = (result.latencyMs || {}) as Record<string, unknown>;
      await client.query(`
        insert into public.adapter_ops_adapter_results (
          "runId","adapterKey",calls,success,failure,"successRate","p50LatencyMs","p95LatencyMs","statusCounts",error
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
      `, [runId, adapterKey, result.calls || 0, result.success || 0, result.failure || 0, result.successRate || 0, latency.p50 || null, latency.p95 || null, JSON.stringify(result.statusCounts || {}), Array.isArray(result.exampleErrors) ? result.exampleErrors.join(" | ") : null]);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  return NextResponse.json({ ok: true, runId, overall, byAdapter: payload.byAdapter }, { headers: { "Cache-Control": "no-store" } });
}
