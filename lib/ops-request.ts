type Operation = "edit" | "outcome" | "rearm" | "verify-link";
type Validation =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string } };

export function validateOpsRequest(operation: Operation, input: unknown): Validation {
  const invalid = (message: string, code = "VALIDATION"): Validation => ({
    ok: false, error: { code, message },
  });
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return invalid("A JSON object is required.");
  }
  const body = input as Record<string, unknown>;
  if (body.note !== undefined && typeof body.note !== "string") {
    return invalid("note must be a string.");
  }
  if (operation === "edit" && Object.hasOwn(body, "timingLink")) {
    return invalid("Use verify-link to change a timing link.", "USE_VERIFY_LINK");
  }
  if (operation === "outcome") {
    // Only explicit null may clear a result outcome; an empty/invalid body must not.
    if (!Object.hasOwn(body, "outcome")) return invalid("outcome is required; use null to clear it.");
    if (body.outcome !== null && (typeof body.outcome !== "string"
      || !["DNS", "DNF", "NON_TIMED"].includes(body.outcome.toUpperCase()))) {
      return invalid("Outcome must be DNS, DNF, NON_TIMED, or null.");
    }
  }
  const booleanFields = operation === "rearm" ? ["clearLink", "runNow"]
    : operation === "verify-link" ? ["force", "keepOnFailure"] : [];
  for (const field of booleanFields) {
    if (body[field] !== undefined && typeof body[field] !== "boolean") {
      return invalid(`${field} must be a boolean.`);
    }
  }
  if (operation === "verify-link") {
    if (typeof body.url !== "string" || !body.url.trim()) return invalid("A result URL is required.");
    try {
      const url = new URL(body.url.trim());
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
        return invalid("Use an HTTP(S) result link without credentials.", "LINK_INVALID");
      }
    } catch {
      return invalid("The result URL is invalid.", "LINK_INVALID");
    }
  }
  return { ok: true, body };
}
