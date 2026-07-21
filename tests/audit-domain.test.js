import test from "node:test";
import assert from "node:assert/strict";
import { applyEvidenceReview } from "../src/server/evidence-review.js";
import { buildSourceFindings, coverageObligationDisposition } from "../src/server/audit-domain.js";
import { buildReviewPresentation } from "../src/server/review-presentation.js";
import { renderFindingsMarkdown } from "../src/server/findings-report.js";

const source = "pragma solidity ^0.8.20;\ncontract Token { uint256 public totalSupply = 100; }\n";
const sourceEvidence = [{ lineStart: 2, lineEnd: 2, quote: "uint256 public totalSupply = 100", why: "The declaration fixes the source value" }];

function evidenceJob(question, plans = []) {
  return {
    source,
    sourceHash: "source-hash",
    verificationQuestions: [question],
    sourceConclusions: [],
    sourceFindings: [],
    evidenceReview: { status: "running" },
    ai: { status: "completed", result: { testPlans: plans } },
    suitePlan: [],
    testCampaign: { passed: 0, awaitingOracle: 0, failed: 0, rejected: 0, invalid: 0, timedOut: 0 },
    findings: [],
    qualityFindings: [],
    toolRuns: [],
  };
}

test("one sufficient evidence route can answer a question without satisfying every alternative", () => {
  const question = {
    id: "Q-ROUTES",
    question: "Is the fixed supply declared in source?",
    rationale: "The source declaration is the objective claim.",
    expectedEvidence: "Exact source citation or a stronger Foundry check",
    requiredEvidenceKinds: ["source", "foundry"],
    sufficientEvidenceRoutes: [["source"], ["source", "foundry"]],
  };
  const job = evidenceJob(question);
  job.sourceConclusions = [{
    id: "SC-ROUTES",
    statement: "The source fixes totalSupply at 100.",
    confidence: "high",
    sourceValidated: true,
    evidence: sourceEvidence,
    relatedQuestionIds: [question.id],
  }];
  applyEvidenceReview(job, { testResults: [], questionResults: [] });
  assert.equal(job.evidenceReview.questionResults[0].status, "ai-supported");
  assert.equal(job.evidenceReview.questionResults[0].nextCheck.needed, false);
});

test("not-verified answers cannot retain positive oracle wording", () => {
  const question = {
    id: "Q-NOT-VERIFIED",
    question: "Does the generated property hold?",
    rationale: "The property is material.",
    expectedEvidence: "An executed Foundry assertion",
    requiredEvidenceKinds: ["source", "foundry"],
  };
  const job = evidenceJob(question, [{ id: "TP-1", questionIds: [question.id], executionStatus: "not-run", code: "" }]);
  applyEvidenceReview(job, {
    testResults: [],
    questionResults: [{
      questionId: question.id,
      status: "verified",
      answer: "The generated property passed.",
      confidence: "high",
      sourceEvidence,
      nextCheck: { needed: false, tool: "none", objective: "none", reason: "No executable oracle was accepted" },
    }],
  });
  const result = job.evidenceReview.questionResults[0];
  assert.equal(result.status, "not-verified");
  assert.match(result.answer, /^Not verified:/);
  assert.equal(result.nextCheck.needed, true);
});

test("source findings require exact citations and are rendered in the AI-led report", () => {
  const job = {
    fileName: "Token.sol",
    source,
    sourceHash: "source-hash",
    sourceIntegrity: { status: "verified" },
    evidenceRevision: 1,
    status: "completed",
    reportState: { reason: "closed" },
    sourceConclusions: [],
    sourceFindings: [
      { id: "SF-VALID", title: "Fixed supply", summary: "Supply is fixed at construction.", rationale: "Direct declaration.", confidence: "high", evidence: sourceEvidence },
      { id: "SF-INVALID", title: "Fabricated", summary: "Not in source.", evidence: [{ lineStart: 2, lineEnd: 2, quote: "not present", why: "bad" }] },
    ],
    findings: [],
    qualityFindings: [],
    ai: { status: "completed", result: { testPlans: [] } },
    verificationQuestions: [],
    evidenceReview: { questionResults: [] },
    toolRuns: [],
  };
  assert.deepEqual(buildSourceFindings(job).map((item) => item.id), ["SF-VALID"]);
  const markdown = renderFindingsMarkdown(job);
  assert.match(markdown, /Source findings/);
  assert.match(markdown, /SF-VALID/);
  assert.match(markdown, /lines 2-2/);
  assert.doesNotMatch(markdown, /SF-INVALID/);
});

test("a cited source finding is reportable even when no analyzer candidate exists", () => {
  const presentation = buildReviewPresentation({
    source,
    sourceFindings: [{
      id: "SF-DRAIN",
      title: "Unrestricted drain",
      summary: "Any caller can reach the balance transfer path.",
      category: "authorization",
      classification: "vulnerability",
      severity: "high",
      confidence: "high",
      rationale: "No caller gate is present in the cited function.",
      impact: "The entire balance can be redirected.",
      trigger: "An untrusted caller reaches the cited path.",
      action: "Restrict the caller and retest.",
      evidence: [{ lineStart: 2, lineEnd: 2, quote: "contract Token { uint256 public totalSupply = 100; }", why: "Exact source location" }],
    }],
    findings: [],
    ai: { status: "completed", result: { testPlans: [] } },
    verificationQuestions: [],
    evidenceReview: { questionResults: [] },
  });
  assert.deepEqual(presentation.findings.map((finding) => finding.id), ["SF-DRAIN"]);
  assert.equal(presentation.findings[0].decisionCategory, "release-blocker");
  assert.equal(presentation.practicalVerdict.code, "do-not-use");
});

test("an adverse exact-cited source conclusion is promoted to a blocker when no analyzer lead exists", () => {
  const presentation = buildReviewPresentation({
    source,
    sourceConclusions: [{
      id: "SC-DRAIN",
      statement: "Any caller can transfer the entire contract balance to an arbitrary address.",
      category: "asset-flow",
      classification: "vulnerability",
      severity: "high",
      confidence: "high",
      rationale: "The transfer path has no caller gate.",
      evidence: sourceEvidence,
    }],
    findings: [],
    ai: { status: "completed", result: { testPlans: [] } },
    verificationQuestions: [],
    evidenceReview: { questionResults: [] },
  });
  assert.equal(presentation.findings[0].id, "SC-DRAIN");
  assert.equal(presentation.findings[0].decisionCategory, "release-blocker");
  assert.equal(presentation.practicalVerdict.code, "do-not-use");
});

test("full coverage keeps technical dispositions while the report follows the AI opinion", () => {
  const job = {
    fileName: "Token.sol",
    source,
    sourceHash: "source-hash",
    sourceIntegrity: { status: "verified" },
    evidenceRevision: 1,
    status: "partial",
    reportState: { reason: "coverage incomplete" },
    auditDepth: "full",
    findings: [],
    qualityFindings: [],
    ai: { status: "completed", result: { testPlans: [] } },
    verificationQuestions: [],
    evidenceReview: { questionResults: [] },
    operationLoop: { coverageObligations: [
      { kind: "analyzer", status: "unavailable", reason: "Slither is not installed" },
      { kind: "fork", status: "server-inapplicable", reason: "No external integration exists" },
    ] },
    auditSynthesis: { answer: "The full review is limited because Slither was unavailable; no external integration exists, so fork testing was inapplicable." },
    toolRuns: [],
  };
  const presentation = buildReviewPresentation(job);
  assert.equal(presentation.coverageObligations[0].terminalDisposition, "unavailable");
  assert.equal(presentation.coverageObligations[1].terminal, true);
  assert.equal(presentation.practicalVerdict.code, "review-required");
  const markdown = renderFindingsMarkdown(job);
  assert.match(markdown, /The full review is limited because Slither was unavailable/);
  assert.match(markdown, /fork testing was inapplicable/);
});

test("timed-out and cancelled coverage are terminal limitations", () => {
  for (const status of ["timed-out", "cancelled"]) {
    const result = coverageObligationDisposition({ kind: "foundry", status });
    assert.equal(result.terminal, true);
    assert.equal(result.disposition, status);
  }
});
