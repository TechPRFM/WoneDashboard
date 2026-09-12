import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { AdapterServiceError, executeDiscovery } from "../../../../lib/adapter-discovery";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const supplied = Buffer.from(request.headers.get("authorization") || "");
  const expected = Buffer.from(`Bearer ${secret || ""}`);
  if (!secret || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json(await executeDiscovery("CRON"), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Discovery failed." }, {
      status: error instanceof AdapterServiceError ? error.status : 502,
    });
  }
}
export async function POST(request: NextRequest) { return GET(request); }
