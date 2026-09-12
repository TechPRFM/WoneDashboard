import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";

function load(relative, dependencies, globals = {}) {
  const source = fs.readFileSync(new URL(relative, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const module = { exports: {} };
  const require = (name) => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    throw new Error(`Unexpected test dependency: ${name}`);
  };
  new Function("require", "module", "exports", ...Object.keys(globals), outputText)(require, module, module.exports, ...Object.values(globals));
  return module.exports;
}

const validation = load("../lib/ops-request.ts", {});
const prefix = "../../../../../../lib/";
const operations = [
  { name: "edit", method: "PATCH", body: { bib: "TEST" }, suffix: "" },
  { name: "outcome", method: "POST", body: { outcome: "DNS" }, suffix: "/outcome" },
  { name: "rearm", method: "POST", body: { runNow: false }, suffix: "/rearm" },
  { name: "verify-link", method: "POST", body: { url: "https://example.com/test" }, suffix: "/verify-link" },
];
const context = { params: Promise.resolve({ id: "isolated/test" }) };
const request = (body) => new Request("https://ops.wone.one/test", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
function mutation(op, denial = null, reply = { status: 200, payload: { ok: true, audit: { id: "test-audit" } } }) {
  const calls = [];
  const handler = load(`../app/api/ops/entries/[id]/${op.name}/route.ts`, {
    [`${prefix}ops-request`]: validation,
    [`${prefix}ops-api`]: {
      requireOpsApi: async () => denial,
      forwardMainApp: (result) => Response.json(result.payload, { status: result.status, headers: { "Cache-Control": "no-store" } }),
    },
    [`${prefix}main-app`]: { callMainApp: async (...args) => { calls.push(args); return reply; } },
  })[op.method];
  return { handler, calls };
}

for (const op of operations) {
  for (const status of [401, 403]) {
    test(`${op.name}: ${status} denial stops before the main app`, async () => {
      const { handler, calls } = mutation(op, Response.json({ ok: false }, { status }));
      assert.equal((await handler(request(op.body), context)).status, status);
      assert.equal(calls.length, 0);
    });
  }
  test(`${op.name}: invalid JSON never forwards a mutation`, async () => {
    const { handler, calls } = mutation(op);
    const invalid = new Request("https://ops.wone.one/test", { method: "POST", body: "{" });
    assert.equal((await handler(invalid, context)).status, 422);
    assert.equal(calls.length, 0);
  });
  test(`${op.name}: success forwards the approved body and escaped entry ID`, async () => {
    const { handler, calls } = mutation(op);
    const response = await handler(request(op.body), context);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).audit.id, "test-audit");
    assert.equal(calls[0][0], `/api/admin/entries/isolated%2Ftest${op.suffix}`);
    assert.equal(calls[0][1].method, op.method);
    for (const [key, value] of Object.entries(op.body)) assert.deepEqual(calls[0][1].body[key], value);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  });
  test(`${op.name}: main-app conflict is preserved, not shown as success`, async () => {
    const payload = { ok: false, error: { code: "ALREADY_VERIFIED", message: "Already verified" } };
    const { handler } = mutation(op, null, { status: 409, payload });
    const response = await handler(request(op.body), context);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), payload);
  });
}

test("outcome requires explicit null to clear; missing field cannot reach main app", async () => {
  const { handler, calls } = mutation(operations[1]);
  assert.equal((await handler(request({}), context)).status, 422);
  assert.equal(calls.length, 0);
  assert.equal((await handler(request({ outcome: null }), context)).status, 200);
  assert.equal(calls[0][1].body.outcome, null);
});

function mainClient(session, response, url = "https://www.wone.one") {
  const calls = [];
  const client = load("../lib/main-app.ts", {
    "server-only": {},
    "@clerk/nextjs/server": { auth: async () => session },
  }, {
    process: { env: { MAIN_APP_URL: url } },
    fetch: async (...args) => { calls.push(args); return response; },
  });
  return { ...client, calls };
}
const signedIn = { isAuthenticated: true, getToken: async () => "test-session-token" };
test("main client sends the Clerk token server-to-server and does not follow redirects", async () => {
  const { callMainApp, calls } = mainClient(signedIn, Response.json({ ok: true }));
  assert.equal((await callMainApp("/api/admin/entries/test", { method: "PATCH", body: { bib: "TEST" } })).status, 200);
  assert.equal(calls[0][0], "https://www.wone.one/api/admin/entries/test");
  assert.equal(calls[0][1].headers.Authorization, "Bearer test-session-token");
  assert.equal(calls[0][1].redirect, "manual");
});
test("main client rejects missing session and missing token without network traffic", async () => {
  for (const session of [{ isAuthenticated: false }, { isAuthenticated: true, getToken: async () => null }]) {
    const { callMainApp, calls } = mainClient(session, null);
    assert.equal((await callMainApp("/test", { method: "POST" })).status, 401);
    assert.equal(calls.length, 0);
  }
});
test("main client exposes redirect misconfiguration without leaking bearer to another origin", async () => {
  const { callMainApp, calls } = mainClient(signedIn, new Response(null, { status: 307, headers: { Location: "https://example.com" } }));
  const result = await callMainApp("/test", { method: "POST" });
  assert.equal(result.status, 502);
  assert.equal(result.payload.error.code, "MAIN_APP_REDIRECT");
  assert.equal(calls.length, 1);
});

test("malformed main-app success response is a gateway failure", async () => {
  const { callMainApp } = mainClient(signedIn, new Response("<html>error</html>"));
  const result = await callMainApp("/test", { method: "GET" });
  assert.equal(result.status, 502);
  assert.equal(result.payload.error.code, "INVALID_RESPONSE");
});

test("main-app timeout is explicit and does not automatically retry a mutation", async () => {
  let calls = 0;
  const { callMainApp } = load("../lib/main-app.ts", {
    "server-only": {}, "@clerk/nextjs/server": { auth: async () => signedIn },
  }, { process: { env: { MAIN_APP_URL: "https://www.wone.one" } }, fetch: async () => {
    calls++; const error = new Error("timeout"); error.name = "TimeoutError"; throw error;
  } });
  const result = await callMainApp("/test", { method: "POST" });
  assert.equal(result.status, 504); assert.equal(calls, 1);
  assert.match(result.payload.error.message, /Inspect the entry before retrying/);
});

const states = load("../lib/verification-state.ts", {});
const evidence = { failureCode: null, verificationError: null, userAction: null, timingLink: "https://example.com/result", verificationStatus: "FAILED" };
test("a link alone does not prove an open decision", () => {
  assert.equal(states.hasOpenDecision(evidence), false);
});
test("legacy race-mismatch message wins over a stale open-decision action", () => {
  const item = { ...evidence, verificationError: "RACE_MISMATCH: wrong race", userAction: "OPEN_RESULT_LINK" };
  assert.equal(states.verificationFailureCode(item), "RACE_MISMATCH");
  assert.equal(states.hasOpenDecision(item), false);
});
test("explicit open decision is preserved, but never on a verified entry", () => {
  const item = { ...evidence, failureCode: "LINK_OPEN_DECISION" };
  assert.equal(states.hasOpenDecision(item), true);
  assert.equal(states.hasOpenDecision({ ...item, verificationStatus: "VERIFIED" }), false);
});

function manualDiscovery(denial, operation) {
  return load("../app/api/admin/adapters/discover/route.ts", {
    "next/server": { NextResponse: Response },
    "../../../../../lib/ops-api": { requireOpsApi: async () => denial },
    "../../../../../lib/adapter-discovery": { executeDiscovery: operation, AdapterServiceError: Error },
  }).POST;
}
for (const status of [401, 403]) test(`manual discovery denies ${status} before invoking the worker`, async () => {
  const handler = manualDiscovery(Response.json({}, { status }), () => { throw new Error("must not run"); });
  assert.equal((await handler()).status, status);
});
test("signed-in administrator runs discovery with MANUAL audit trigger", async () => {
  let trigger;
  const handler = manualDiscovery(null, async value => { trigger = value; return { ok: true }; });
  const result = await handler();
  assert.equal(trigger, "MANUAL"); assert.equal(result.status, 200);
  assert.equal(result.headers.get("Cache-Control"), "no-store");
});

for (const body of [null, [], { callsPerAdapter: 1000 }, { callsPerAdapter: "30" }, { concurrencyPerAdapter: 4 }]) {
  test(`stress rejects unsafe or invalid payload ${JSON.stringify(body)}`, async () => {
    const handler = load("../app/api/admin/adapters/stress/route.ts", {
      "next/server": { NextResponse: Response },
      "../../../../../lib/ops-api": { requireOpsApi: async () => null },
      "../../../../../lib/adapter-ops-write-db": {},
    }, { process: { env: { ADAPTER_STRESS_URL: "https://worker.example.test", ADAPTER_SERVICE_TOKEN: "test-only" } }, fetch: () => { throw new Error("must not run"); } }).POST;
    assert.equal((await handler(request(body))).status, 422);
  });
}

const nodeCrypto = await import("node:crypto");
test("cron rejects missing/wrong tokens and accepts only its configured scheduler token", async () => {
  for (const token of [null, "Bearer wrong", "Bearer test-cron"]) {
    let calls = 0;
    const handler = load("../app/api/cron/adapters/route.ts", {
      "next/server": { NextResponse: Response }, "node:crypto": nodeCrypto,
      "../../../../lib/adapter-discovery": { AdapterServiceError: Error, executeDiscovery: async trigger => { calls++; assert.equal(trigger, "CRON"); return { ok: true }; } },
    }, { process: { env: { CRON_SECRET: "test-cron" } } }).GET;
    const response = await handler(new Request("https://ops.wone.one/api/cron/adapters", { headers: token ? { Authorization: token } : {} }));
    assert.equal(response.status, token === "Bearer test-cron" ? 200 : 401);
    assert.equal(calls, token === "Bearer test-cron" ? 1 : 0);
  }
});
test("discovery refuses malformed worker success before touching the database", async () => {
  const { executeDiscovery } = load("../lib/adapter-discovery.ts", {
    "server-only": {}, "node:crypto": nodeCrypto,
    "./adapter-ops-write-db": { getAdapterOpsWritePool: () => { throw new Error("must not access DB"); } },
  }, { process: { env: { ADAPTER_DISCOVERY_URL: "https://worker.example.test", ADAPTER_SERVICE_TOKEN: "test-only" } }, fetch: async () => Response.json({}) });
  await assert.rejects(executeDiscovery(), error => error.status === 502);
});
