import "server-only";

import { auth } from "@clerk/nextjs/server";

export type MainAppResponse = {
  status: number;
  payload: unknown;
};

export async function callMainApp(
  path: string,
  options: { method: "GET" | "POST" | "PATCH"; body?: unknown },
): Promise<MainAppResponse> {
  const session = await auth();
  if (!session.isAuthenticated) {
    return { status: 401, payload: { ok: false, error: { code: "UNAUTHENTICATED", message: "Sign in is required." } } };
  }
  const token = await session.getToken();
  if (!token) {
    return { status: 401, payload: { ok: false, error: { code: "UNAUTHENTICATED", message: "No Clerk session token was available." } } };
  }

  const configuredBase = process.env.MAIN_APP_URL?.trim().replace(/\/$/, "");
  if (!configuredBase) {
    return { status: 503, payload: { ok: false, error: { code: "NOT_CONFIGURED", message: "MAIN_APP_URL is not configured." } } };
  }

  const response = await fetch(`${configuredBase}${path}`, {
    method: options.method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: "no-store",
    redirect: "manual",
    signal: AbortSignal.timeout(115_000),
  });

  if (response.status >= 300 && response.status < 400) {
    return {
      status: 502,
      payload: {
        ok: false,
        error: {
          code: "MAIN_APP_REDIRECT",
          message: `MAIN_APP_URL redirected to ${response.headers.get("location") || "another host"}. Configure the canonical API origin so the Clerk bearer token is not dropped.`,
        },
      },
    };
  }

  const payload = await response.json().catch(() => ({
    ok: false,
    error: { code: "INVALID_RESPONSE", message: `Main app returned HTTP ${response.status} without JSON.` },
  }));
  return { status: response.status, payload };
}
