import { NextRequest } from "next/server";

import { callMainApp } from "../../../../../../lib/main-app";
import { forwardMainApp, requireOpsApi } from "../../../../../../lib/ops-api";

const ALLOWED_FIELDS = new Set([
  "raceName",
  "date",
  "bib",
  "time",
  "category",
  "distanceKm",
  "sport",
  "location",
  "note",
]);

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = await requireOpsApi();
  if (denied) return denied;
  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json(
      { ok: false, error: { code: "VALIDATION", message: "A JSON object is required." } },
      { status: 422 },
    );
  }
  const fields = Object.fromEntries(Object.entries(body).filter(([key]) => ALLOWED_FIELDS.has(key)));
  if (!Object.keys(fields).length) {
    return Response.json(
      { ok: false, error: { code: "VALIDATION", message: "No editable fields were supplied." } },
      { status: 422 },
    );
  }
  if (
    fields.distanceKm !== undefined
    && fields.distanceKm !== null
    && (typeof fields.distanceKm !== "number" || !Number.isFinite(fields.distanceKm) || fields.distanceKm < 0)
  ) {
    return Response.json(
      { ok: false, error: { code: "VALIDATION", message: "distanceKm must be a non-negative number or null." } },
      { status: 422 },
    );
  }
  return forwardMainApp(await callMainApp(`/api/admin/entries/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: fields,
  }));
}
