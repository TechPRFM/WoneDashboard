import "server-only";

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import { getPool } from "./db";

export type OpsActor = {
  userId: string;
  email: string | null;
};

export async function getOpsActor(): Promise<
  | { ok: true; actor: OpsActor }
  | { ok: false; status: 401 | 403; code: "UNAUTHENTICATED" | "FORBIDDEN" }
> {
  const session = await auth();
  if (!session.isAuthenticated || !session.userId) {
    return { ok: false, status: 401, code: "UNAUTHENTICATED" };
  }

  const result = await getPool().query<{ id: string; email: string | null }>(
    `select id,email from public.users where "clerkId" = $1 and coalesce("isAdmin", false) = true limit 1`,
    [session.userId],
  );
  const user = result.rows[0];
  if (!user) return { ok: false, status: 403, code: "FORBIDDEN" };
  return { ok: true, actor: { userId: user.id, email: user.email } };
}

export async function requireOpsPage(): Promise<OpsActor> {
  const result = await getOpsActor();
  if (result.ok) return result.actor;
  if (result.status === 401) redirect("/sign-in");
  redirect("/forbidden");
}
