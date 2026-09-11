import { NextRequest } from "next/server";

import { callMainApp } from "../../../../../../lib/main-app";
import { forwardMainApp, requireOpsApi } from "../../../../../../lib/ops-api";
import { validateOpsRequest } from "../../../../../../lib/ops-request";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = await requireOpsApi();
  if (denied) return denied;
  const { id } = await context.params;
  const validated = validateOpsRequest("rearm", await request.json().catch(() => null));
  if (!validated.ok) return Response.json(validated, { status: 422 });
  const body = validated.body;
  return forwardMainApp(await callMainApp(`/api/admin/entries/${encodeURIComponent(id)}/rearm`, {
    method: "POST",
    body: {
      clearLink: body.clearLink === true,
      runNow: body.runNow === true,
      ...(typeof body.note === "string" && body.note.trim() ? { note: body.note.trim() } : {}),
    },
  }));
}
