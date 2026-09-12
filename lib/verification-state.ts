type Evidence = {
  failureCode: string | null;
  verificationError: string | null;
  userAction: string | null;
  timingLink: string | null;
  verificationStatus: string | null;
};

export function verificationFailureCode(item: Evidence): string | null {
  return item.failureCode || item.verificationError?.match(/^([A-Z][A-Z0-9_]+):/)?.[1] || null;
}

export function hasOpenDecision(item: Evidence): boolean {
  if (item.verificationStatus === "VERIFIED") return false;
  const code = verificationFailureCode(item);
  if (code && code !== "LINK_OPEN_DECISION") return false;
  return code === "LINK_OPEN_DECISION" || item.userAction === "OPEN_RESULT_LINK";
}
