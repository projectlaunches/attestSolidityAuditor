const REENTRANCY_AFTER_CALL = new Set([
  "reentrancy-eth",
  "reentrancy-no-eth",
  "reentrancy-state-change",
]);

export function canonicalSecurityCategory(detectorId) {
  const normalized = String(detectorId || "unknown").toLowerCase();
  if (REENTRANCY_AFTER_CALL.has(normalized)) return "reentrancy-after-external-call";
  return normalized;
}
