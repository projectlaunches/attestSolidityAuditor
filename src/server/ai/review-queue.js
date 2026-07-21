const DEEP_REVIEW = new Set(["deep-review", "insufficient-evidence"]);

export function groupReviewCandidates(findings) {
  const groups = [];
  for (const finding of findings) {
    const match = groups.find((group) => compatible(group.findings.at(-1), finding));
    if (match) match.findings.push(finding);
    else groups.push({ id: `group-${groups.length + 1}`, findings: [finding] });
  }
  return groups.map((group) => ({
    ...group,
    findingIds: group.findings.map((finding) => finding.id),
    primary: digestFinding(group.findings[0]),
    detectors: [...new Set(group.findings.flatMap((finding) =>
      (finding.evidence || []).map((item) => `${item.tool}/${item.detectorId || item.kind}`)
    ))],
  }));
}

export function candidateGroupDigest(group) {
  return {
    groupId: group.id,
    findingIds: group.findingIds,
    primary: group.primary,
    detectors: group.detectors,
  };
}

export function triageNeedsDeepReview(entry) {
  return !entry || DEEP_REVIEW.has(entry.disposition);
}

export function expandGroupReview(group, review) {
  return group.findingIds.map((findingId) => ({
    findingId,
    verdict: review.verdict,
    confidence: review.confidence,
    rationale: review.rationale,
    classification: review.classification,
    assumptionEffect: review.assumptionEffect,
    evidence: review.evidence,
  }));
}

export function reviewFromTriage(entry) {
  const mapping = {
    "valid-observation": ["likely", "code-quality"],
    "intentional": ["likely", "intentional-design"],
    "trust-dependent": ["needs-review", "trust-disclosure"],
    "quality-only": ["likely", "code-quality"],
    "not-applicable": ["reject", "false-positive"],
  };
  const [verdict, classification] = mapping[entry.disposition] || ["needs-review", "assumption-dependent"];
  return {
    verdict,
    confidence: entry.confidence,
    rationale: entry.rationale,
    classification,
    assumptionEffect: entry.assumptionEffect,
    evidence: entry.evidence,
  };
}

export function manualReviewGroupReviews(group, reason) {
  return group.findingIds.map((findingId) => ({
    findingId,
    verdict: "needs-review",
    confidence: "low",
    rationale: reason,
    classification: "manual-review-required",
    assumptionEffect: "Automated review could not reach a source-validated disposition; human review remains required.",
    evidence: [],
    terminalDisposition: "manual-review-required",
  }));
}

export function chunk(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

export function reviewRecoveryAction(batchSize, retry, maxSingleRetries = 1) {
  if (batchSize > 1) return "split";
  if (retry < maxSingleRetries) return "retry";
  return "manual-review";
}

function digestFinding(finding) {
  return {
    id: finding.id,
    title: finding.title,
    summary: finding.summary,
    severity: finding.severity,
    category: finding.category,
    location: finding.location,
    evidence: finding.evidence,
  };
}

function compatible(left, right) {
  if (!left || !right) return false;
  if (left.category !== right.category) return false;
  const a = left.location || {};
  const b = right.location || {};
  if (a.file !== b.file || (a.contract && b.contract && a.contract !== b.contract) ||
      (a.function && b.function && a.function !== b.function)) return false;
  if (Number.isInteger(a.sourceStart) && Number.isInteger(a.sourceLength) &&
      Number.isInteger(b.sourceStart) && Number.isInteger(b.sourceLength)) {
    return a.sourceStart < b.sourceStart + b.sourceLength && b.sourceStart < a.sourceStart + a.sourceLength;
  }
  if (!Number.isInteger(a.lineStart) || !Number.isInteger(b.lineStart)) return false;
  return Math.abs(a.lineStart - b.lineStart) <= 1;
}
