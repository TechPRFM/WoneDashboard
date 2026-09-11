import { NextRequest } from "next/server";

import { callMainApp } from "../../../../../../lib/main-app";
import { forwardMainApp, requireOpsApi } from "../../../../../../lib/ops-api";
import { validateOpsRequest } from "../../../../../../lib/ops-request";

const OUTCOMES = new Set(["DNS", "DNF", "NON_TIMED"]);

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = await requireOpsApi();
  if (denied) return denied;
  const { id } = await context.params;
  const validated = validateOpsRequest("outcome", await request.json().catch(() => null));
  if (!validated.ok) return Response.json(validated, { status: 422 });
  const body = validated.body;
  const outcome = body.outcome == null ? null : String(body.outcome).toUpperCase();
  if (outcome !== null && !OUTCOMES.has(outcome)) {
    return Response.json(
      { ok: false, error: { code: "VALIDATION", message: "Outcome must be DNS, DNF, NON_TIMED, or null." } },
      { status: 422 },
    );
  }
  return forwardMainApp(await callMainApp(`/api/admin/entries/${encodeURIComponent(id)}/outcome`, {
    method: "POST",
    body: {
      outcome,
      ...(typeof body.note === "string" && body.note.trim() ? { note: body.note.trim() } : {}),
    },
  }));
}
