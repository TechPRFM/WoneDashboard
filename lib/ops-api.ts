import { NextResponse } from "next/server";

import { getOpsActor } from "./ops-auth";
import type { MainAppResponse } from "./main-app";

export async function requireOpsApi() {
  const actor = await getOpsActor();
  if (actor.ok) return null;
  return NextResponse.json(
    { ok: false, error: { code: actor.code, message: actor.status === 401 ? "Sign in is required." : "Administrator access is required." } },
    { status: actor.status, headers: { "Cache-Control": "no-store" } },
  );
}

export function forwardMainApp(result: MainAppResponse) {
  return NextResponse.json(result.payload, {
    status: result.status,
    headers: { "Cache-Control": "no-store" },
  });
}
