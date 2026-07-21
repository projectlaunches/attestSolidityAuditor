import { canonicalSecurityCategory } from "./categories.js";

function severity(impact = "") {
  const normalized = impact.toLowerCase();
  if (["high", "medium", "low", "informational", "optimization"].includes(normalized)) {
    return normalized === "informational" || normalized === "optimization" ? "info" : normalized;
  }
  return "unknown";
}

function parseJsonFromOutput(output) {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Slither did not return JSON output");
  return JSON.parse(output.slice(start, end + 1));
}

export function normalizeSlitherOutput(output, toolVersion = null) {
  const parsed = parseJsonFromOutput(output);
  if (parsed.success !== true) throw new Error(parsed.error || "Slither JSON did not report success:true");
  const detectors = parsed?.results?.detectors ?? [];

  return detectors.map((detector, index) => {
    const element = detector.elements?.[0] ?? {};
    const mapping = element.source_mapping ?? {};
    const lines = Array.isArray(mapping.lines) ? mapping.lines : [];
    const lineStart = lines.length ? Math.min(...lines) : null;
    const lineEnd = lines.length ? Math.max(...lines) : lineStart;
    const detectorId = detector.check || `slither-${index + 1}`;
    const file = mapping.filename_relative || mapping.filename_short || "src/Target.sol";
    const location = {
      file,
      lineStart,
      lineEnd,
      contract: element.type === "contract" ? element.name : null,
      function: element.type === "function" ? element.name : null,
    };
    if (Number.isInteger(mapping.start) && Number.isInteger(mapping.length)) {
      location.sourceStart = mapping.start;
      location.sourceLength = mapping.length;
    }

    return {
      id: `slither:${detectorId}:${file}:${lineStart ?? "unknown"}`,
      title: detector.check ? detector.check.replaceAll("-", " ") : "Slither finding",
      summary: detector.description?.trim() || "Slither reported a potential issue.",
      severity: severity(detector.impact),
      confidence: detector.confidence?.toLowerCase() || "unknown",
      verification: "static-only",
      category: canonicalSecurityCategory(detectorId),
      location,
      evidence: [{
        kind: "static",
        tool: "slither",
        toolVersion,
        detectorId,
        description: detector.description?.trim() || detectorId,
        location: { ...location },
      }],
      aiReview: null,
      testPlans: [],
    };
  });
}

export const __test = { parseJsonFromOutput, severity };
