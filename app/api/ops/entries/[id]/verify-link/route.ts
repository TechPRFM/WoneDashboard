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
  const validated = validateOpsRequest("verify-link", await request.json().catch(() => null));
  if (!validated.ok) return Response.json(validated, { status: 422 });
  const body = validated.body;
  if (typeof body.url !== "string" || !body.url.trim()) {
    return Response.json(
      { ok: false, error: { code: "VALIDATION", message: "A result URL is required." } },
      { status: 422 },
    );
  }
  return forwardMainApp(await callMainApp(`/api/admin/entries/${encodeURIComponent(id)}/verify-link`, {
    method: "POST",
    body: {
      url: body.url.trim(),
      force: body.force === true,
      keepOnFailure: body.keepOnFailure === true,
      ...(typeof body.note === "string" && body.note.trim() ? { note: body.note.trim() } : {}),
    },
  }));
}
