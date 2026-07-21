import test from "node:test";
import assert from "node:assert/strict";
import {
  chunk,
  expandGroupReview,
  groupReviewCandidates,
  reviewFromTriage,
  reviewRecoveryAction,
  triageNeedsDeepReview,
  manualReviewGroupReviews,
} from "../src/server/ai/review-queue.js";

function finding(id, line, overrides = {}) {
  return {
    id,
    title: "external call",
    summary: "review call ordering",
    severity: "medium",
    category: "external-call",
    location: { file: "src/Target.sol", contract: "Token", function: "swapBack", lineStart: line, lineEnd: line },
    evidence: [{ tool: id.split(":")[0], detectorId: "external-call", kind: "static" }],
    ...overrides,
  };
}

test("near-identical detector leads are grouped without losing finding ids or provenance", () => {
  const groups = groupReviewCandidates([finding("slither:a", 20), finding("aderyn:b", 21)]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].findingIds, ["slither:a", "aderyn:b"]);
  assert.deepEqual(groups[0].detectors, ["slither/external-call", "aderyn/external-call"]);
});

test("distinct functions and distant source locations remain separate review groups", () => {
  const groups = groupReviewCandidates([
    finding("slither:a", 20),
    finding("slither:b", 40),
    finding("slither:c", 21, { location: { file: "src/Target.sol", contract: "Token", function: "transfer", lineStart: 21, lineEnd: 21 } }),
  ]);
  assert.equal(groups.length, 3);
});

test("triage closes contextual observations but escalates material or unsupported leads", () => {
  assert.equal(triageNeedsDeepReview({ disposition: "quality-only" }), false);
  assert.equal(triageNeedsDeepReview({ disposition: "deep-review" }), true);
  assert.equal(triageNeedsDeepReview(), true);
  const review = reviewFromTriage({ disposition: "intentional", confidence: "high", rationale: "declared", assumptionEffect: "owner trusted", evidence: [] });
  assert.equal(review.classification, "intentional-design");
  assert.equal(review.verdict, "likely");
});

test("group results expand back to every raw finding and failures remain explicit", () => {
  const group = groupReviewCandidates([finding("slither:a", 20), finding("aderyn:b", 21)])[0];
  const expanded = expandGroupReview(group, { verdict: "reject", confidence: "high", rationale: "not applicable", classification: "false-positive", assumptionEffect: "none", evidence: [] });
  assert.deepEqual(expanded.map((item) => item.findingId), ["slither:a", "aderyn:b"]);
  const manualReview = manualReviewGroupReviews(group, "timeout");
  assert.equal(manualReview.length, 2);
  assert.ok(manualReview.every((item) => item.verdict === "needs-review" && item.classification === "manual-review-required" && item.evidence.length === 0 && item.terminalDisposition === "manual-review-required"));
});

test("batch chunking preserves order and supports smaller retry units", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.equal(reviewRecoveryAction(8, 0), "split");
  assert.equal(reviewRecoveryAction(1, 0), "retry");
  assert.equal(reviewRecoveryAction(1, 1), "manual-review");
});
