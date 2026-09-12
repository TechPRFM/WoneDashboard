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

  let response: Response;
  try {
    response = await fetch(`${configuredBase}${path}`, {
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
    } catch (error) {
    const timedOut = error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
    return {
      status: timedOut ? 504 : 502,
      payload: { ok: false, error: {
        code: timedOut ? "MAIN_APP_TIMEOUT" : "MAIN_APP_UNREACHABLE",
        message: "The main app did not return a response. The operation may still have completed. Inspect the entry before retrying; do not submit it repeatedly.",
      } },
    };
  }

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

  try {
    const payload = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid response");
    return { status: response.status, payload };
  } catch {
    return { status: 502, payload: { ok: false, error: {
      code: "INVALID_RESPONSE", message: `Main app returned HTTP ${response.status} without a valid JSON object. Inspect the entry before retrying.`,
    } } };
  }
}
