import { NextResponse } from "next/server";
import { getDashboardData } from "../../../../lib/db";
import { requireOpsApi } from "../../../../lib/ops-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const denied = await requireOpsApi();
  if (denied) return denied;
  const data = await getDashboardData();
  return NextResponse.json(data, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
