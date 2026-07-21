import test from "node:test";
import assert from "node:assert/strict";
import { renderFindingsMarkdown } from "../src/server/findings-report.js";
import { buildReviewPresentation } from "../src/server/review-presentation.js";
import { supersedeCorrectedTestPlans } from "../src/server/test-plan-state.js";

const source = "contract Counter { uint256 public value; }";

function fullJob(priorStatus, priorFailureKind = null) {
  return {
    id: "job-retry",
    fileName: "Counter.sol",
    source,
    sourceHash: "abc",
    sourceIntegrity: { status: "verified" },
    status: "completed",
    auditDepth: "full",
    evidenceRevision: 2,
    findings: [],
    qualityFindings: [],
    toolRuns: [],
    worklog: [],
    limitations: [],
    reportState: { status: "ready", reason: "testing closed" },
    runGeneratedTests: true,
    runAnvil: false,
    sourceConclusions: [{
      id: "SC-1",
      statement: "The contract exposes its value.",
      category: "state-transition",
      classification: "neutral-fact",
      severity: "info",
      confidence: "high",
      rationale: "The public state declaration creates a getter.",
      evidence: [{ lineStart: 1, lineEnd: 1, quote: "uint256 public value", why: "Exact declaration." }],
    }],
    verificationQuestions: [{
      id: "Q-1",
      priority: "high",
      materiality: "required-for-opinion",
      category: "state-transition",
      question: "Does the value getter return the stored value?",
      rationale: "Runtime behavior should match the declaration.",
      expectedEvidence: "A source-grounded Foundry assertion.",
      requiredEvidenceKinds: ["foundry"],
    }],
    evidenceReview: { questionResults: [{
      questionId: "Q-1",
      status: "ai-supported",
      answer: "The corrected test passed with a source-validated oracle.",
      confidence: "high",
      relatedTestIds: ["new"],
      sourceEvidence: [{ lineStart: 1, lineEnd: 1, quote: "uint256 public value", sourceValidated: true }],
      evidenceClasses: ["foundry"],
      nextCheck: { needed: false, tool: "none", objective: "", reason: "Satisfied" },
    }] },
    operationLoop: {
      history: [
        { id: "OP-OLD", kind: "foundry", questionId: "Q-1", specDigest: "same-spec" },
        { id: "OP-NEW", kind: "foundry", questionId: "Q-1", specDigest: "same-spec" },
      ],
      coverageObligations: [],
    },
    ai: { status: "completed", result: { testPlans: [
      { id: "old", title: "Old broken attempt", questionIds: ["Q-1"], followupOperationId: "OP-OLD", operationSpecDigest: "same-spec", executionStatus: priorStatus, failureKind: priorFailureKind, executionMessage: "The old harness was broken." },
      { id: "new", title: "Corrected attempt", questionIds: ["Q-1"], followupOperationId: "OP-NEW", operationSpecDigest: "same-spec", executionStatus: "executed-ai-supported", executionMessage: "The corrected property passed." },
    ] } },
    testCampaign: { mode: "custom", generatedTestBudget: 1, passed: 1, invalid: 0, rejected: 0, failed: 0, timedOut: 0 },
  };
}

for (const [label, status, failureKind] of [
  ["invalid oracle", "invalid-test", "invalid-oracle"],
  ["failed harness", "failed", "harness-error"],
]) {
  test(`a corrected retry supersedes the historical ${label} in full findings`, () => {
    const job = fullJob(status, failureKind);
    supersedeCorrectedTestPlans(job);
    assert.equal(job.ai.result.testPlans[0].supersededBy, "new");
    const presentation = buildReviewPresentation(job);
    assert.equal(presentation.releaseDecision.testGaps, 0);
    assert.equal(presentation.releaseDecision.regressionPasses, 1);
    assert.equal(presentation.releaseDecision.status, "ready-with-caveats");
    const markdown = renderFindingsMarkdown(job);
    assert.doesNotMatch(markdown, /TEST GAP.*old/is);
    assert.doesNotMatch(markdown, /Old broken attempt/);
  });
}
