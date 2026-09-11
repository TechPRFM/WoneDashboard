import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = fs.readFileSync(new URL("../lib/ops-request.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { validateOpsRequest: validate } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

for (const operation of ["edit", "outcome", "rearm", "verify-link"]) {
  test(`${operation} rejects non-object bodies`, () => {
    for (const input of [null, undefined, [], true, 3, "DNS"]) assert.equal(validate(operation, input).ok, false);
  });
}
test("missing outcome cannot clear an existing outcome", () => {
  assert.equal(validate("outcome", {}).ok, false);
  assert.equal(validate("outcome", { note: "test" }).ok, false);
  for (const outcome of [null, "DNS", "DNF", "NON_TIMED"]) assert.equal(validate("outcome", { outcome }).ok, true);
  for (const outcome of [false, 0, "DQ", {}, ""]) assert.equal(validate("outcome", { outcome }).ok, false);
});
test("timingLink cannot be silently ignored in an edit", () => {
  assert.equal(validate("edit", { timingLink: "https://example.com", bib: "12" }).error.code, "USE_VERIFY_LINK");
});
test("mutation flags require real booleans", () => {
  for (const [op, key] of [["rearm", "runNow"], ["rearm", "clearLink"], ["verify-link", "force"], ["verify-link", "keepOnFailure"]]) {
    assert.equal(validate(op, { url: "https://example.com/result", [key]: "false" }).ok, false);
    assert.equal(validate(op, { url: "https://example.com/result", [key]: false }).ok, true);
  }
});
test("invalid result links and non-string notes are rejected", () => {
  for (const url of ["", "bad link", "javascript:alert(1)", "https://user:pass@example.com"]) assert.equal(validate("verify-link", { url }).ok, false);
  assert.equal(validate("verify-link", { url: "https://example.com/result" }).ok, true);
  assert.equal(validate("outcome", { outcome: "DNS", note: {} }).ok, false);
});
