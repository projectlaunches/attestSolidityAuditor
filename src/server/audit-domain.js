// Shared, deterministic semantics for the audit boundary.  The controller and
// evidence reviewer may evolve independently, so this module accepts both the
// current field names and the older aliases that appeared in persisted jobs.

export const EVIDENCE_KINDS = Object.freeze([
  "source",
  "analyzer",
  "foundry",
  "anvil-deployment",
  "anvil-observation",
  "anvil-scenario",
  "fork",
  "compiler-matrix",
  "developer-context",
]);

const EVIDENCE_KIND_SET = new Set(EVIDENCE_KINDS);
const MATERIALITIES = new Set(["required-for-opinion", "optional-assurance"]);
const POSITIVE_WORDING = /\b(?:verified|confirmed|proved|proven|passed|successful|satisfied|established)\b/i;

/**
 * Normalize exact-cited source evidence without trusting a model's
 * sourceValidated flag.  A citation is accepted only when its quote occurs in
 * the numbered source range supplied by the job.
 */
export function validateExactSourceEvidence(items, source) {
  const sourceLines = String(source || "").split("\n");
  if (!Array.isArray(items)) return [];
  return items.filter((item) => {
    const lineStart = Number(item?.lineStart);
    const lineEnd = Number(item?.lineEnd);
    const quote = typeof item?.quote === "string" ? item.quote.trim() : "";
    if (!Number.isInteger(lineStart) || !Number.isInteger(lineEnd)) return false;
    if (lineStart < 1 || lineEnd < lineStart || lineEnd > sourceLines.length || !quote) return false;
    return sourceLines.slice(lineStart - 1, lineEnd).join("\n").includes(quote);
  }).map((item) => ({ ...item, sourceValidated: true }));
}

/**
 * Promote source-only findings into a stable, first-class representation.  A
 * source finding is deliberately discarded if it has no exact validated
 * citation; this prevents a prose-only model answer from becoming evidence.
 */
export function buildSourceFindings(job = {}) {
  const source = String(job.source || "");
  const suppliedSourceFindings = Array.isArray(job.sourceFindings) ? job.sourceFindings : [];
  const candidates = [
    ...suppliedSourceFindings.map((item) => ({ ...item, kind: item.kind || "source-finding" })),
    // Older jobs stored direct source reasoning as sourceConclusions.  Expose
    // those as first-class source findings as well, while preserving their
    // original IDs and fields for compatibility.
    ...(suppliedSourceFindings.length ? [] : (Array.isArray(job.sourceConclusions) ? job.sourceConclusions.map((item) => ({
      ...item,
      kind: item.kind || "source-conclusion",
      title: item.title || item.statement || "AI source-supported conclusion",
      summary: item.summary || item.statement,
    })) : [])),
  ];
  const seen = new Set();
  return candidates.flatMap((item, index) => {
    const id = String(item?.id || `AI-SOURCE-${index + 1}`).trim();
    if (!id || seen.has(id)) return [];
    const evidence = validateExactSourceEvidence(item?.evidence || item?.sourceEvidence, source);
    if (!evidence.length) return [];
    seen.add(id);
    const statement = String(item.statement || item.summary || item.title || "AI source-supported finding").trim();
    const summary = String(item.summary || item.statement || item.impact || statement).trim();
    return [{
      id,
      kind: item.kind || "source-finding",
      title: String(item.title || statement || "AI source-supported finding").trim(),
      statement,
      summary,
      category: String(item.category || "other"),
      classification: String(item.classification || ""),
      severity: ["critical", "high", "medium", "low", "info"].includes(item.severity) ? item.severity : "info",
      confidence: ["high", "medium", "low"].includes(item.confidence) ? item.confidence : "medium",
      rationale: String(item.rationale || item.impact || "Validated against the submitted source").trim(),
      impact: String(item.impact || "").trim(),
      trigger: String(item.trigger || "").trim(),
      action: String(item.action || "").trim(),
      evidence,
      citations: evidence,
      relatedQuestionIds: [...new Set(Array.isArray(item.relatedQuestionIds) ? item.relatedQuestionIds.filter(Boolean) : [])],
      assurance: "ai-source-supported",
      sourceValidated: true,
      firstClass: true,
    }];
  });
}

/**
 * Resolve question materiality. Explicit model output wins; old jobs without
 * the field remain optional outside full mode, matching their previous
 * presentation behavior. Audit profile normalization may already provide the
 * inferred field for new jobs.
 */
export function questionMateriality(question = {}, auditDepth = "targeted") {
  const explicit = question.materiality
    || (question.requiredForOpinion === true || question.required === true ? "required-for-opinion" : null)
    || (question.optionalAssurance === true ? "optional-assurance" : null);
  const materiality = MATERIALITIES.has(explicit)
    ? explicit
    : auditDepth === "full" && question.materiality === undefined
      ? "required-for-opinion"
      : "optional-assurance";
  return {
    materiality,
    requiredForOpinion: materiality === "required-for-opinion",
    label: materiality === "required-for-opinion" ? "required for opinion" : "optional assurance",
  };
}

/**
 * Normalize alternative evidence routes. Each route is an AND-list of kinds;
 * routes are OR-ed. A flat list is treated as one backwards-compatible route.
 */
export function sufficientEvidenceRoutes(question = {}) {
  const supplied = question.sufficientEvidenceRoutes
    ?? question.evidenceRoutes
    ?? question.acceptedEvidenceRoutes
    ?? question.requiredEvidenceRoutes;
  const rawRoutes = Array.isArray(supplied) ? supplied : [];
  const routes = rawRoutes.length > 0 && rawRoutes.every((route) => typeof route === "string")
    ? [rawRoutes.filter((kind) => EVIDENCE_KIND_SET.has(kind))]
    : rawRoutes.flatMap((route) => {
    if (typeof route === "string") return EVIDENCE_KIND_SET.has(route) ? [[route]] : [];
    if (Array.isArray(route)) return [route.filter((kind) => EVIDENCE_KIND_SET.has(kind))];
    if (route && typeof route === "object") {
      const kinds = route.kinds || route.requiredEvidenceKinds || route.evidenceKinds;
      return Array.isArray(kinds) ? [kinds.filter((kind) => EVIDENCE_KIND_SET.has(kind))] : [];
    }
      return [];
    }).filter((route) => route.length).map((route) => [...new Set(route)]);
  if (routes.length) return routes;
  const fallback = Array.isArray(question.requiredEvidenceKinds)
    ? question.requiredEvidenceKinds.filter((kind) => EVIDENCE_KIND_SET.has(kind))
    : [];
  return [fallback.length ? [...new Set(fallback)] : ["source"]];
}

/**
 * Evaluate OR-of-AND evidence routes. `satisfiesKind` is called only for
 * normalized evidence kinds and may be as strict as the caller requires.
 */
export function evaluateEvidenceRoutes(question, satisfiesKind) {
  const routes = sufficientEvidenceRoutes(question);
  for (const route of routes) {
    if (route.every((kind) => satisfiesKind(kind))) {
      return { satisfied: true, matchedRoute: route, routes };
    }
  }
  return { satisfied: false, matchedRoute: null, routes };
}

export function sourceRouteCanAnswer(question = {}) {
  const text = `${question.question || ""} ${question.rationale || ""} ${question.expectedEvidence || ""}`.toLowerCase();
  return sufficientEvidenceRoutes(question).some((route) => {
    if (!route.every((kind) => kind === "source" || kind === "developer-context")) return false;
    // Developer context is not an objective proof of ownership, arithmetic,
    // runtime, or other source-trace properties.
    if (route.includes("developer-context") && /\b(intent|intended|accepted|acceptable|trusted|production|configuration|parameter|constructor\s+value|external\s+dependenc|which\s+address|should|policy)\b/.test(text)) return false;
    return route.includes("source");
  });
}

/**
 * Keep answers semantically aligned with a not-verified disposition. Positive
 * model prose is not allowed to survive as an apparent conclusion after a
 * required evidence gate fails.
 */
export function notVerifiedAnswer(question = {}, answer = "", reason = "") {
  const supplied = String(answer || "").trim();
  const fallback = String(reason || `The available evidence did not answer: ${question.question || "this verification question"}`).trim();
  const detail = supplied && !POSITIVE_WORDING.test(supplied) ? supplied : fallback;
  const clean = detail.replace(/^not[ -]verified\s*[:.-]?\s*/i, "").trim();
  return `Not verified: ${clean || "the available evidence was insufficient"}`;
}

export function isTerminalCoverageStatus(status) {
  return ["completed", "unavailable", "not-authorized", "server-inapplicable", "inapplicable", "failed", "timed-out", "cancelled", "budget-exhausted"].includes(status);
}

export function coverageObligationDisposition(obligation = {}) {
  const status = String(obligation.status || "pending");
  const terminal = isTerminalCoverageStatus(status);
  const disposition = status === "completed"
    ? "completed"
    : status === "server-inapplicable" || status === "inapplicable"
      ? "server-inapplicable"
      : status === "not-authorized"
        ? "not-authorized"
        : status === "unavailable"
          ? "unavailable"
          : status === "failed"
            ? "failed"
            : status === "timed-out"
              ? "timed-out"
              : status === "cancelled"
                ? "cancelled"
                : status === "budget-exhausted"
                  ? "budget-exhausted"
                : "pending";
  return {
    ...obligation,
    kind: String(obligation.kind || "unknown"),
    status,
    required: obligation.required !== false,
    terminal,
    terminalDisposition: disposition,
    disposition,
    reason: String(obligation.reason || obligation.message || (terminal ? `Server recorded ${disposition}.` : "Evidence obligation remains open.")).trim(),
  };
}

export function buildCoverageObligations(job = {}) {
  if (job.auditDepth !== "full") return [];
  return (Array.isArray(job.operationLoop?.coverageObligations) ? job.operationLoop.coverageObligations : [])
    .map(coverageObligationDisposition);
}

/**
 * Canonical practical verdict codes. Presentation keeps its historical state
 * and title strings, while exposing this stable machine-readable judgment.
 */
export function derivePracticalVerdict({
  blockers = 0,
  regressionFailures = 0,
  surfacedConcerns = 0,
  unresolved = 0,
  sourceConclusionCount = 0,
  sourceFindingCount = 0,
  completedEvidenceCount = 0,
  reviewComplete = false,
  fullCoverageIncomplete = false,
} = {}) {
  if (blockers > 0 || regressionFailures > 0) return {
    code: "do-not-use",
    title: "Do not use this contract as submitted",
    reason: "A blocking concern or failed contract property remains unresolved.",
  };
  if (surfacedConcerns > 0 || fullCoverageIncomplete) return {
    code: "review-required",
    title: "Review required before this contract is used",
    reason: "The selected opinion still has unresolved evidence, decisions, coverage, or adjudication items.",
  };
  if (unresolved > 0 || !reviewComplete) return {
    code: "usability-not-established",
    title: "Contract usability was not established",
    reason: "An opinion-critical question or source adjudication remains unresolved.",
  };
  if (sourceConclusionCount > 0 || sourceFindingCount > 0 || completedEvidenceCount > 0) return {
    code: "no-blocker-in-completed-scope",
    title: "No blocker found in completed scope",
    reason: "Completed source-supported review did not surface a blocker in the selected scope.",
  };
  return {
    code: "usability-not-established",
    title: "Contract usability was not established",
    reason: "The completed evidence did not establish enough source or behavioral support for a practical use decision.",
  };
}
