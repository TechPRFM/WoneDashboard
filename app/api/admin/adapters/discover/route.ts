import { NextResponse } from "next/server";
import { requireOpsApi } from "../../../../../lib/ops-api";
import { AdapterServiceError, executeDiscovery } from "../../../../../lib/adapter-discovery";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST() {
  const denied = await requireOpsApi();
  if (denied) return denied;
  try {
    return NextResponse.json(await executeDiscovery("MANUAL"), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Discovery failed." }, {
      status: error instanceof AdapterServiceError ? error.status : 502,
    });
  }
}
