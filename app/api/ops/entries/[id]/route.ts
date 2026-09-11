import { NextRequest, NextResponse } from "next/server";

import { getPool } from "../../../../../lib/db";
import { requireOpsApi } from "../../../../../lib/ops-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = await requireOpsApi();
  if (denied) return denied;
  const { id } = await context.params;
  const pool = getPool();
  const entryResult = await pool.query(`
    select
      entry.id,
      entry."raceName",
      entry.year,
      entry."verificationError",
      entry."verificationCandidates",
      entry."verificationDiagnostics",
      entry."rawRowData",
      entry."timingLink",
      entry."matchedRaceEditionId",
      entry."stravaActivityId",
      usr.email,
      usr."dateOfBirth"::date::text as "dateOfBirth"
    from public.unmatched_race_entries entry
    left join public.users usr on usr.id = entry."userId"
    where entry.id = $1
    limit 1
  `, [id]);
  const entry = entryResult.rows[0];
  if (!entry) {
    return NextResponse.json(
      { ok: false, error: { code: "ENTRY_NOT_FOUND", message: "Queue entry was not found." } },
      { status: 404 },
    );
  }

  const mappingResult = await pool.query(`
        select id,"rawName",year,"adapterKey","externalEventKey","raceEditionId"
        from public.race_edition_mappings
        where
          ($1::text is not null and "raceEditionId" = $1)
          or (
            $1::text is null
            and year = $2
            and lower(trim("rawName")) = lower(trim($3))
          )
        order by "updatedAt" desc
      `, [entry.matchedRaceEditionId, entry.year, entry.raceName]);
  const auditTable = await pool.query<{ tableName: string | null }>(
    `select to_regclass('public.admin_actions')::text as "tableName"`,
  );
  const actionResult = auditTable.rows[0]?.tableName
    ? await pool.query(`
        select id,"actorUserId","actorLabel","authMode",action,before,after,outcome,note,"createdAt"::text as "createdAt"
        from public.admin_actions
        where "targetType" = 'unmatched_race_entry' and "targetId" = $1
        order by "createdAt" desc
        limit 20
      `, [id])
    : { rows: [] };

  return NextResponse.json({
    ok: true,
    entry,
    mappings: mappingResult.rows,
    recentActions: actionResult.rows,
  }, { headers: { "Cache-Control": "private, no-store" } });
}
