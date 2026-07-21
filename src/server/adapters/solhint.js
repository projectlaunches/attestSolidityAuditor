export function normalizeSolhintOutput(raw, toolVersion = null) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Solhint did not produce valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("Solhint JSON must be an array");
  return parsed
    .filter((entry) => entry && typeof entry.ruleId === "string")
    .map((entry, index) => {
      const line = Number.isInteger(entry.line) && entry.line > 0 ? entry.line : null;
      const column = Number.isInteger(entry.column) && entry.column > 0 ? entry.column : null;
      const severity = String(entry.severity || "warning").toLowerCase() === "error" ? "error" : "warning";
      return {
        id: `solhint:${entry.ruleId}:${entry.filePath || "src/Target.sol"}:${line ?? `unknown-${index + 1}`}:${column ?? "unknown"}`,
        ruleId: entry.ruleId,
        message: typeof entry.message === "string" ? entry.message : entry.ruleId,
        severity,
        location: {
          file: entry.filePath || "src/Target.sol",
          lineStart: line,
          lineEnd: line,
          column,
        },
        evidence: {
          kind: "lint",
          tool: "solhint",
          toolVersion,
          detectorId: entry.ruleId,
          description: typeof entry.message === "string" ? entry.message : entry.ruleId,
        },
      };
    });
}
