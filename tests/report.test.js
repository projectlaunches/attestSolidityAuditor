import test from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../src/server/report.js";

test("report distinguishes no findings from a security guarantee", () => {
  const markdown = renderMarkdown({
    id: "job-1",
    fileName: "Safe.sol",
    sourceHash: "abc",
    status: "partial",
    findings: [],
    toolRuns: [{ tool: "forge", version: "1.7.1", status: "completed", exitCode: 0, timedOut: false }],
    ai: { status: "disabled" },
    worklog: [],
    limitations: ["Human review required."],
  });
  assert.match(markdown, /detector touchpoint\(s\) remain hidden/);
  assert.match(markdown, /not a security guarantee/);
  assert.match(markdown, /Readiness assessment:/);
  assert.match(markdown, /What needs to happen next/);
  assert.match(markdown, /Optional — Optional: run AI-designed Foundry tests/);
  assert.match(markdown, /Property testing: Not run/);
  assert.match(markdown, /Only an assertion failure whose oracle was source-validated/);
});

test("report neutralizes active Markdown and raw HTML from untrusted text", () => {
  const markdown = renderMarkdown({
    id: "job-2",
    fileName: "Unsafe.sol",
    sourceHash: "def",
    status: "completed",
    auditDepth: "full",
    findings: [{
      id: "x", title: "<img src=x>", summary: "![remote](https://example.test/pixel)", severity: "low", confidence: "low", verification: "static-only",
      location: { file: "src/Target.sol", lineStart: 1 }, evidence: [], testPlans: [],
      aiReview: { sourceValidated: true, verdict: "likely", classification: "vulnerability", confidence: "high", rationale: "source evidence", assumptionEffect: "none" },
    }],
    toolRuns: [], ai: { status: "completed" }, worklog: [], limitations: [], suitePlan: [], declaredContext: {}, contractProfile: {}, compileSettings: {},
  });
  assert.doesNotMatch(markdown, /<img src=x>/);
  assert.doesNotMatch(markdown, /!\[remote\]/);
  assert.match(markdown, /&lt;img src=x&gt;/);
});

test("report keeps Solhint diagnostics out of blocker-focused summaries", () => {
  const focused = renderMarkdown({
    id: "job-3", fileName: "Quality.sol", sourceHash: "ghi", status: "completed",
    findings: [],
    qualityFindings: [{
      ruleId: "compiler-version", message: "Pin the compiler", severity: "error",
      location: { file: "src/Target.sol", lineStart: 2 },
    }],
    toolRuns: [], ai: { status: "disabled" }, worklog: [], limitations: [], suitePlan: [], declaredContext: {}, contractProfile: {}, compileSettings: {},
  });
  assert.match(focused, /Surfaced security concerns: 0/);
  assert.doesNotMatch(focused, /Quality diagnostics: 1/);

  const full = renderMarkdown({
    id: "job-3", fileName: "Quality.sol", sourceHash: "ghi", status: "completed", auditDepth: "full",
    findings: [],
    qualityFindings: [{
      ruleId: "compiler-version", message: "Pin the compiler", severity: "error",
      location: { file: "src/Target.sol", lineStart: 2 },
    }],
    toolRuns: [], ai: { status: "disabled" }, worklog: [], limitations: [], suitePlan: [], declaredContext: {}, contractProfile: {}, compileSettings: {},
  });
  assert.match(full, /Quality diagnostics: 1/);
  assert.match(full, /not counted as security findings/);
});

test("report turns failed source adjudication into an actionable manual-review conclusion", () => {
  const markdown = renderMarkdown({
    id: "job-4", fileName: "NeedsReview.sol", sourceHash: "jkl", status: "partial",
    findings: [{
      id: "tool:x", severity: "high", category: "authorization", title: "unchecked owner change", verification: "static-only",
      location: { file: "src/Target.sol", lineStart: 19 }, evidence: [], testPlans: [],
      aiReview: { sourceValidated: false, verdict: "needs-review", classification: "assumption-dependent", rationale: "Final source citation did not validate", terminalDisposition: "manual-review-required" },
    }],
    qualityFindings: [], toolRuns: [], ai: { status: "completed", result: { testPlans: [] } }, worklog: [], limitations: [], suitePlan: [], declaredContext: {}, contractProfile: {}, compileSettings: {}, runGeneratedTests: false,
  });
  assert.match(markdown, /1 manual review required/);
  assert.match(markdown, /Complete manual review for 1 touchpoint/);
  assert.match(markdown, /src\/Target\.sol:19/);
  assert.match(markdown, /Final source citation did not validate/);
  assert.doesNotMatch(markdown, /unresolved/i);
});

test("report leads with the same plain-language synthesis shown in the single feed", () => {
  const markdown = renderMarkdown({
    id: "job-5", fileName: "Token.sol", sourceHash: "mno", status: "partial",
    findings: [], qualityFindings: [], toolRuns: [], ai: { status: "disabled" }, worklog: [], limitations: [], suitePlan: [], declaredContext: {}, contractProfile: {}, compileSettings: {}, runGeneratedTests: false,
    auditSynthesis: { answer: "Assessment incomplete. Anvil deployment did not occur. Approve constructor inputs and rerun." },
    anvil: { requested: true, status: "needs-input", reason: "Constructor intent is ambiguous" },
    aiDeploymentPlan: { decision: "needs-input", targetContract: "Token", constructorArguments: [{ name: "owner" }], rationale: "Owner role was not declared" },
  });
  assert.match(markdown, /## Plain-language audit conclusion/);
  assert.match(markdown, /Assessment incomplete/);
  assert.match(markdown, /Approve constructor inputs and rerun/);
  assert.match(markdown, /AI plan: needs-input; target Token; 1 constructor argument/);
  assert.match(markdown, /Plan rationale: Owner role was not declared/);
});

test("report lists rejected property plans and their validator reasons", () => {
  const markdown = renderMarkdown({
    id: "job-6", fileName: "Token.sol", sourceHash: "pqr", status: "partial",
    findings: [], qualityFindings: [], toolRuns: [], worklog: [], limitations: [], suitePlan: [], declaredContext: {}, contractProfile: {}, compileSettings: {},
    runGeneratedTests: true,
    ai: { status: "completed", result: { testPlans: [
      { title: "Unauthorized delegated transfer", testType: "unit", executionStatus: "rejected", executionMessage: "Low-level calls are not allowed" },
      { title: "Supply conservation", testType: "invariant", executionStatus: "rejected", executionMessage: "Low-level calls are not allowed" },
    ] } },
    testCampaign: { mode: "deep", recommendedProperties: 2, generatedTestBudget: 2, fuzzRuns: 10000, plansReturned: 2, plansAccepted: 0, rejected: 2, failed: 0, timedOut: 0 },
  });
  assert.match(markdown, /Generated property plan outcomes/);
  assert.match(markdown, /Rejected or broken generated checks are coverage gaps, not failed contract properties/);
  assert.match(markdown, /Unauthorized delegated transfer/);
  assert.match(markdown, /Supply conservation/);
  assert.match(markdown, /Low-level calls are not allowed/);
});

test("report does not count missing constructor intent as an unavailable tool", () => {
  const markdown = renderMarkdown({
    id: "job-7", fileName: "Token.sol", sourceHash: "stu", status: "partial", runAnvil: true, runGeneratedTests: false,
    findings: [], qualityFindings: [], worklog: [], limitations: [], suitePlan: [], declaredContext: {}, contractProfile: {}, compileSettings: {},
    toolRuns: [{ tool: "anvil-deployment", status: "skipped", error: "constructor input required" }],
    anvil: { requested: true, status: "needs-input", reason: "constructor input required" },
    aiDeploymentPlan: { targetContract: "SimpleToken", decision: "needs-input" },
    deploymentArtifacts: [{ contract: "SimpleToken", constructorInputs: [{ name: "_name", type: "string" }] }],
    ai: { status: "completed", result: { testPlans: [] } },
  });
  assert.match(markdown, /Tool coverage: 0 completed, 0 skipped\/failed\/timed out/);
  assert.match(markdown, /Deployment input: needed only for the optional Fresh Anvil check for SimpleToken; Anvil itself was available and did not fail/);
  assert.doesNotMatch(markdown, /unavailable or unsuccessful tool/i);
});

test("report excludes environment bootstrap runs from audit tool coverage", () => {
  const markdown = renderMarkdown({
    id: "job-bootstrap", fileName: "Token.sol", sourceHash: "bootstrap", status: "completed",
    findings: [], qualityFindings: [], worklog: [], limitations: [], suitePlan: [], declaredContext: {}, contractProfile: {}, compileSettings: {},
    toolRuns: [
      { tool: "forge-bootstrap", status: "completed", evidenceEligible: false },
      { tool: "slither", status: "completed", evidenceEligible: true },
    ],
    ai: { status: "completed", result: { testPlans: [] } },
  });
  assert.match(markdown, /Tool coverage: 1 completed, 0 skipped\/failed\/timed out/);
});

test("a failed environment bootstrap does not create an audit tooling blocker", () => {
  const markdown = renderMarkdown({
    id: "job-bootstrap-failed", fileName: "Token.sol", sourceHash: "bootstrap-failed", status: "completed",
    findings: [], qualityFindings: [], worklog: [], limitations: [], suitePlan: [], declaredContext: {}, contractProfile: {}, compileSettings: {},
    toolRuns: [{ tool: "forge-bootstrap", status: "failed", evidenceEligible: false, error: "metadata probe failed" }],
    ai: { status: "completed", result: { testPlans: [] } },
  });
  assert.match(markdown, /Tool coverage: 0 completed, 0 skipped\/failed\/timed out/);
  assert.doesNotMatch(markdown, /unavailable or unsuccessful tool|Repair local audit tooling/i);
});

test("report separates source reasoning from runtime and adversarial assurance", () => {
  const evidence = [{ lineStart: 2, lineEnd: 2, quote: "uint256 public totalSupply = 100", why: "direct assignment" }];
  const questions = [
    { id: "Q-SOURCE", question: "What supply does the source initialize?", priority: "high", requiredEvidenceKinds: ["source"] },
    { id: "Q-RUNTIME", question: "Does deployed state match the allocation?", priority: "high", requiredEvidenceKinds: ["source", "anvil-observation"] },
    { id: "Q-TEST", question: "Do transfers conserve supply under adversarial inputs?", priority: "high", requiredEvidenceKinds: ["source", "foundry"] },
  ];
  const markdown = renderMarkdown({
    id: "job-assurance", fileName: "Token.sol", sourceHash: "assurance", status: "completed", source: "pragma solidity ^0.8.20;\nuint256 public totalSupply = 100;",
    sourceConclusions: [{ id: "SC-1", statement: "The source initializes totalSupply to 100.", rationale: "Direct declaration assignment.", assurance: "ai-source-supported", evidence }],
    verificationQuestions: questions,
    evidenceReview: { questionResults: [
      { questionId: "Q-SOURCE", status: "ai-supported", answer: "Source value is 100.", confidence: "high", evidenceClasses: ["ai-source-supported"], sourceEvidence: evidence, relatedTestIds: [], nextCheck: { needed: false, tool: "none" } },
      { questionId: "Q-RUNTIME", status: "ai-supported", answer: "Observed deployed state matches.", confidence: "high", evidenceClasses: ["ai-source-supported", "runtime-observed"], sourceEvidence: evidence, relatedTestIds: [], nextCheck: { needed: false, tool: "none" } },
      { questionId: "Q-TEST", status: "ai-supported", answer: "The tested input campaign conserved supply.", confidence: "high", evidenceClasses: ["ai-source-supported", "unit-tested"], sourceEvidence: evidence, relatedTestIds: ["TP-1"], nextCheck: { needed: false, tool: "none" } },
    ] },
    findings: [], qualityFindings: [], toolRuns: [], worklog: [], limitations: [], suitePlan: [], declaredContext: {}, contractProfile: {}, compileSettings: {},
    ai: { status: "completed", result: { testPlans: [{ id: "TP-1", questionIds: ["Q-TEST"], executionStatus: "executed-ai-supported" }] } },
    runGeneratedTests: true, testCampaign: { mode: "recommended", recommendedProperties: 1, generatedTestBudget: 1, fuzzRuns: 1000, plansReturned: 1, plansAccepted: 1, passed: 1, rejected: 0, failed: 0, timedOut: 0 },
  });
  assert.match(markdown, /## Whole-contract source conclusions/);
  assert.match(markdown, /AI source-supported/);
  assert.match(markdown, /runtime-observed/);
  assert.match(markdown, /unit-tested/);
});
