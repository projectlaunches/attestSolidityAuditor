import { canonicalSecurityCategory } from "./categories.js";

const SECTIONS = [
  ["high", "high_issues"],
  ["medium", "medium_issues"],
  ["low", "low_issues"],
];

export function normalizeAderynReport(raw, toolVersion = null) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Aderyn did not produce valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.detectors_used) || typeof parsed.issue_count !== "object") {
    throw new Error("Aderyn JSON is missing required report fields");
  }

  const findings = [];
  for (const [severity, sectionName] of SECTIONS) {
    const declaredCount = parsed.issue_count[severity] ?? 0;
    if (!Number.isInteger(declaredCount) || declaredCount < 0) throw new Error(`Aderyn ${severity} issue count is invalid`);
    const section = parsed[sectionName];
    if (section == null) {
      if (declaredCount > 0) throw new Error(`Aderyn declares ${declaredCount} ${severity} issue(s) but ${sectionName} is missing`);
      continue;
    }
    if (!Array.isArray(section.issues)) throw new Error(`Aderyn ${sectionName} is malformed`);
    if (section.issues.length !== declaredCount) throw new Error(`Aderyn ${sectionName} count does not match issue_count`);
    for (const [issueIndex, issue] of section.issues.entries()) {
      const detectorId = typeof issue.detector_name === "string" && issue.detector_name ? issue.detector_name : `aderyn-${severity}-${issueIndex + 1}`;
      if (!Array.isArray(issue.instances) || issue.instances.length === 0) throw new Error(`Aderyn detector ${detectorId} has no nonempty instances array`);
      for (const [instanceIndex, instance] of issue.instances.entries()) {
        const line = Number.isInteger(instance.line_no) && instance.line_no > 0 ? instance.line_no : null;
        const file = typeof instance.contract_path === "string" && instance.contract_path ? instance.contract_path : "src/Target.sol";
        const description = [issue.description, instance.hint].filter(Boolean).join(" ").trim() || detectorId;
        const sourceSpan = parseSourceSpan(instance.src_char || instance.src);
        const location = { file, lineStart: line, lineEnd: line, contract: null, function: null };
        if (sourceSpan) Object.assign(location, sourceSpan);
        findings.push({
          id: `aderyn:${detectorId}:${file}:${line ?? `unknown-${instanceIndex + 1}`}`,
          title: issue.title || detectorId.replaceAll("-", " "),
          summary: description,
          severity,
          confidence: "unknown",
          verification: "static-only",
          category: canonicalSecurityCategory(detectorId),
          location,
          evidence: [{
            kind: "static",
            tool: "aderyn",
            toolVersion,
            detectorId,
            description,
            location: { ...location },
          }],
          aiReview: null,
          testPlans: [],
        });
      }
    }
  }
  return findings;
}

function parseSourceSpan(value) {
  const match = typeof value === "string" ? value.match(/^(\d+):(\d+)$/) : null;
  if (!match) return null;
  return { sourceStart: Number(match[1]), sourceLength: Number(match[2]) };
}
