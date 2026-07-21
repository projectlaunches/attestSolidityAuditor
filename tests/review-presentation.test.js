import test from "node:test";
import assert from "node:assert/strict";
import { buildReviewPresentation } from "../src/server/review-presentation.js";

function candidate(id, overrides = {}) {
  return {
    id,
    severity: "medium",
    verification: "ai-reviewed",
    aiReview: null,
    ...overrides,
  };
}

const cleanSource = "contract Token { uint256 public totalSupply; }";
const cleanConclusion = {
  id: "SC-CLEAN",
  statement: "The source exposes a totalSupply getter.",
  category: "state-transition",
  classification: "neutral-fact",
  severity: "info",
  confidence: "high",
  rationale: "The public state declaration creates the getter.",
  evidence: [{ lineStart: 1, lineEnd: 1, quote: "uint256 public totalSupply", why: "Exact declaration." }],
};

test("raw detector candidates remain hidden until AI review completes", () => {
  const finding = candidate("raw", { aiReview: { sourceValidated: true, verdict: "likely", classification: "vulnerability" } });
  const result = buildReviewPresentation({ findings: [finding], ai: { status: "running" } });
  assert.equal(result.findings.length, 0);
  assert.deepEqual(result.touchpoints, [{ id: "raw", location: { file: "src/Target.sol", line: null }, detectors: [], state: "reviewed" }]);
  assert.deepEqual(result.reviewSummary, {
    status: "running", touchpoints: 1, reviewed: 1, surfaced: 0, observations: 0, rejected: 0, manualReview: 0, unreviewed: 0,
  });
});

test("a failed pipeline reports an operational failure instead of a contract opinion", () => {
  const result = buildReviewPresentation({
    status: "failed",
    findings: [],
    toolRuns: [],
    worklog: [{ stage: "job", status: "failed", message: "AI review could not reach OpenAI." }],
    ai: { status: "failed" },
  });
  assert.equal(result.releaseDecision.status, "failed");
  assert.deepEqual(result.practicalVerdict, {
    code: "audit-not-completed",
    title: "Audit did not complete",
    reason: "AI review could not reach OpenAI.",
  });
  assert.equal(result.releaseDecision.usability.title, "Audit did not complete");
  assert.match(result.releaseDecision.usability.summary, /no contract-use opinion was produced/i);
});

test("release decision blocks on validated high defects and property failures while categorizing other evidence", () => {
  const blocker = candidate("blocker", {
    severity: "high",
    aiReview: { sourceValidated: true, verdict: "likely", classification: "vulnerability" },
  });
  const contextual = candidate("context", {
    aiReview: { sourceValidated: true, verdict: "likely", classification: "intentional-design" },
  });
  const result = buildReviewPresentation({
    source: cleanSource,
    findings: [blocker, contextual],
    ai: { status: "completed", result: { testPlans: [
      { executionStatus: "failed", failureKind: "property-failure" },
      { executionStatus: "failed", failureKind: "harness-error" },
      { executionStatus: "executed-ai-supported" },
    ] } },
    qualityFindings: [{}],
    toolRuns: [],
    runGeneratedTests: true,
  });
  assert.equal(result.findings[0].decisionCategory, "release-blocker");
  const { nextActions, propertyTesting, usability, ...decision } = result.releaseDecision;
  assert.deepEqual(decision, {
    status: "block", blockers: 1, regressionFailures: 1, regressionPasses: 1,
    needsDecision: 1, context: 1, quality: 0, rejected: 0, manualReview: 0, unreviewed: 0, testGaps: 0, recommendedChecks: 1,
  });
  assert.deepEqual(propertyTesting, { status: "recommended", label: "1 AI-supported; 1 optional stronger check need retry or review" });
  assert.equal(usability.title, "Do not use this contract as submitted");
  assert.deepEqual(nextActions.map((item) => item.required), [true, true, false]);
});

test("practical assessment says when a contract is usable in the completed scope and names what remains", () => {
  const result = buildReviewPresentation({
    findings: [], qualityFindings: [], toolRuns: [], runGeneratedTests: true,
    sourceConclusions: [{ id: "SC-1", statement: "The source has no mutable privileged path.", assurance: "ai-source-supported", sourceValidated: true }],
    contractProfile: { archetypes: ["erc20-token"] },
    ai: { status: "completed", result: { testPlans: [
      { id: "P-1", executionStatus: "executed-ai-supported" },
      { id: "P-2", executionStatus: "executed-ai-supported" },
    ] } },
    verificationQuestions: [
      { id: "Q-GAP", question: "Are transfer events exact?", requiredEvidenceKinds: ["source", "foundry"] },
      { id: "Q-DECISION", question: "Is allowance overwrite intended?", requiredEvidenceKinds: ["source", "developer-context"] },
    ],
    evidenceReview: { questionResults: [
      { questionId: "Q-GAP", status: "not-verified", answer: "Event receipts were not checked", nextCheck: { needed: true, tool: "forge", objective: "Assert event topics", reason: "Receipt evidence is missing" } },
      { questionId: "Q-DECISION", status: "developer-decision", answer: "The source uses conventional overwrite semantics", nextCheck: { needed: false, tool: "none", objective: "No test", reason: "Intent controls this decision" } },
    ] },
  });
  assert.equal(result.releaseDecision.usability.title, "Usable in the completed ERC-20 token behavior test scope");
  assert.match(result.releaseDecision.usability.summary, /no contract-breaking behavior in 2 supported property checks/i);
  assert.match(result.releaseDecision.usability.summary, /additional check/i);
  assert.equal(result.releaseDecision.recommendedChecks, 1);
  assert.doesNotMatch(result.releaseDecision.usability.summary, /developer decision/i);
  assert.equal(result.releaseDecision.needsDecision, 0, "recorded intent is context, not an unresolved release decision");
});

test("a high opinion-critical AI-supported concern is a blocker rather than a developer-intent question", () => {
  const result = buildReviewPresentation({
    source: cleanSource,
    sourceConclusions: [cleanConclusion],
    findings: [], qualityFindings: [], toolRuns: [], auditDepth: "targeted",
    ai: { status: "completed", result: { testPlans: [] } },
    verificationQuestions: [{
      id: "Q-DRAIN", priority: "high", materiality: "required-for-opinion",
      question: "Can an untrusted caller drain the contract balance?", rationale: "Funds safety",
      expectedEvidence: "Source trace and executed caller-bound property", requiredEvidenceKinds: ["source", "foundry"],
    }],
    evidenceReview: { questionResults: [{
      questionId: "Q-DRAIN", status: "ai-supported-concern", answer: "An untrusted caller reached the withdrawal path.", confidence: "high",
      nextCheck: { needed: false, tool: "none", objective: "No further check", reason: "The failed property and source trace agree" },
    }] },
  });
  assert.equal(result.releaseDecision.status, "block");
  assert.equal(result.releaseDecision.blockers, 1);
  assert.match(result.releaseDecision.nextActions[0].title, /blocking issue/i);
});

test("custom-contract usability titles do not contain a duplicated article", () => {
  const result = buildReviewPresentation({
    findings: [], qualityFindings: [], toolRuns: [], runGeneratedTests: true, auditDepth: "targeted",
    contractProfile: { archetypes: ["custom-contract"] },
    ai: { status: "completed", result: { testPlans: [{ id: "P-1", executionStatus: "executed-ai-supported" }] } },
    evidenceReview: { questionResults: [] },
  });
  assert.doesNotMatch(result.releaseDecision.usability.title, /completed the contract/);
  assert.match(result.releaseDecision.usability.title, /completed stated-purpose behavior test scope/);
});

test("targeted mode can finish from clean source review without forcing tests", () => {
  const result = buildReviewPresentation({
    source: cleanSource,
    findings: [],
    qualityFindings: [],
    toolRuns: [],
    runGeneratedTests: true,
    auditDepth: "targeted",
    contractProfile: { archetypes: ["erc20-token"] },
    sourceConclusions: [cleanConclusion],
    ai: { status: "completed", result: { testPlans: [] } },
    verificationQuestions: [],
    evidenceReview: { questionResults: [] },
  });
  assert.equal(result.releaseDecision.status, "ready-with-caveats");
  assert.equal(result.releaseDecision.testGaps, 0);
  assert.equal(result.releaseDecision.propertyTesting.label, "No generated property was needed for the source-only conclusions");
  assert.equal(result.releaseDecision.usability.title, "No blocker found in AI review scope");
  assert.match(result.releaseDecision.usability.summary, /found no source-validated blocker/i);
});

test("targeted mode treats unanswered runtime checks as optional stronger assurance", () => {
  const result = buildReviewPresentation({
    source: cleanSource,
    findings: [],
    qualityFindings: [],
    toolRuns: [],
    auditDepth: "targeted",
    contractProfile: { archetypes: ["erc20-token"] },
    sourceConclusions: [cleanConclusion],
    ai: { status: "completed", result: { testPlans: [] } },
    verificationQuestions: [
      { id: "Q-DEPLOY", priority: "high", question: "Does deployment assign the constructor supply to actor 0?", rationale: "Runtime assurance", expectedEvidence: "Fresh Anvil deployment observations", requiredEvidenceKinds: ["source", "anvil-deployment", "anvil-observation"] },
    ],
    evidenceReview: { questionResults: [] },
  });
  assert.equal(result.releaseDecision.status, "ready-with-caveats");
  assert.equal(result.releaseDecision.testGaps, 0);
  assert.equal(result.releaseDecision.recommendedChecks, 1);
  assert.equal(result.verificationResults[0].nextCheck.tool, "anvil");
  assert.equal(result.releaseDecision.nextActions.at(-1).required, false);
  assert.match(result.releaseDecision.nextActions.at(-1).title, /Optional: run 1 recommended/);
  assert.doesNotMatch(result.releaseDecision.nextActions.map((item) => item.detail).join(" "), /developer-context/i);
});

test("full mode keeps unanswered runtime checks as required coverage", () => {
  const result = buildReviewPresentation({
    findings: [],
    qualityFindings: [],
    toolRuns: [],
    auditDepth: "full",
    contractProfile: { archetypes: ["erc20-token"] },
    ai: { status: "completed", result: { testPlans: [] } },
    verificationQuestions: [
      { id: "Q-DEPLOY", priority: "high", question: "Does deployment assign the constructor supply to actor 0?", rationale: "Runtime assurance", expectedEvidence: "Fresh Anvil deployment observations", requiredEvidenceKinds: ["source", "anvil-deployment", "anvil-observation"] },
    ],
    evidenceReview: { questionResults: [] },
  });
  assert.equal(result.releaseDecision.status, "incomplete");
  assert.equal(result.releaseDecision.testGaps, 1);
  assert.equal(result.releaseDecision.recommendedChecks, 0);
  assert.equal(result.releaseDecision.nextActions.find((item) => item.type === "targeted-verification").required, true);
});

test("non-full modes focus blocker and funds-safety output while full mode includes nits", () => {
  const fundSafety = candidate("auth", {
    category: "authorization",
    severity: "medium",
    title: "owner can redirect treasury",
    aiReview: { sourceValidated: true, verdict: "needs-review", classification: "assumption-dependent" },
  });
  const nit = candidate("nit", {
    category: "style",
    severity: "low",
    title: "naming style",
    aiReview: { sourceValidated: true, verdict: "likely", classification: "code-quality" },
  });
  const base = {
    findings: [fundSafety, nit],
    qualityFindings: [{ ruleId: "compiler-version" }],
    ai: { status: "completed", result: { testPlans: [] } },
    verificationQuestions: [
      { id: "Q-FUNDS", question: "Can owner drain funds?", rationale: "Funds safety", expectedEvidence: "source or test", requiredEvidenceKinds: ["source"] },
      { id: "Q-COMPILER", question: "Does every compiler version build?", rationale: "Compatibility", expectedEvidence: "compiler matrix", requiredEvidenceKinds: ["compiler-matrix"] },
    ],
    evidenceReview: { questionResults: [] },
  };
  const targeted = buildReviewPresentation({ ...base, auditDepth: "targeted" });
  assert.deepEqual(targeted.findings.map((item) => item.id), ["auth"]);
  assert.equal(targeted.releaseDecision.quality, 0);
  assert.deepEqual(targeted.verificationResults.map((item) => item.id), ["Q-FUNDS"]);

  const full = buildReviewPresentation({ ...base, auditDepth: "full" });
  assert.deepEqual(full.findings.map((item) => item.id), ["auth"]);
  assert.equal(full.releaseDecision.quality, 2);
  assert.deepEqual(full.verificationResults.map((item) => item.id), ["Q-FUNDS", "Q-COMPILER"]);
});

test("completed AI review surfaces security concerns and summarizes other touchpoints", () => {
  const findings = [
    candidate("vulnerability", { category: "authorization", title: "untrusted owner change", aiReview: { sourceValidated: true, verdict: "likely", classification: "vulnerability" } }),
    candidate("assumption", { category: "asset-flow", title: "owner can redirect treasury funds", aiReview: { sourceValidated: true, verdict: "needs-review", classification: "assumption-dependent" } }),
    candidate("intentional", { aiReview: { sourceValidated: true, verdict: "likely", classification: "intentional-design" } }),
    candidate("rejected", { aiReview: { sourceValidated: true, verdict: "reject", classification: "false-positive" } }),
    candidate("invalid", { severity: "high", category: "authorization", title: "privileged transfer path", location: { file: "src/Target.sol", lineStart: 44 }, aiReview: { sourceValidated: false, verdict: "needs-review", classification: "assumption-dependent", rationale: "Final citation did not validate", terminalDisposition: "manual-review-required" } }),
  ];
  const result = buildReviewPresentation({ findings, ai: { status: "completed" } });
  assert.deepEqual(result.findings.map((item) => item.id), ["vulnerability", "assumption"]);
  assert.deepEqual(result.touchpoints.map((item) => item.state), ["surfaced", "surfaced", "contextualized", "not-substantiated", "manual-review-required"]);
  assert.deepEqual(result.reviewSummary, {
    status: "completed", touchpoints: 5, reviewed: 4, surfaced: 2, observations: 1, rejected: 1, manualReview: 1, unreviewed: 0,
  });
  assert.equal(result.releaseDecision.nextActions[0].title, "Complete manual review for 1 touchpoint(s)");
  assert.match(result.releaseDecision.nextActions[0].detail, /src\/Target\.sol:44/);
  assert.match(result.releaseDecision.nextActions[0].detail, /Final citation did not validate/);
  assert.deepEqual(result.releaseDecision.propertyTesting, { status: "not-run", label: "Not run" });
  assert.equal(result.touchpoints.at(-1).reason, "Final citation did not validate");
});

test("a modern compiler pragma warning is compatibility coverage, not a vague manual security item", () => {
  const finding = candidate("slither:solc-version:src/Target.sol:2", {
    title: "solc-version",
    category: "compiler",
    evidence: [{ tool: "slither", detectorId: "solc-version" }],
    aiReview: { sourceValidated: false, verdict: "needs-review", classification: "assumption-dependent", rationale: "citation unavailable" },
  });
  const result = buildReviewPresentation({
    source: "pragma solidity ^0.8.20;\ncontract Token {}",
    findings: [finding], ai: { status: "completed", result: { testPlans: [] } },
    toolRuns: [], runGeneratedTests: false,
  });
  assert.equal(result.releaseDecision.manualReview, 0);
  assert.equal(result.touchpoints[0].state, "contextualized");
  assert.match(result.touchpoints[0].reason, /dedicated verification check/);
  assert.doesNotMatch(result.releaseDecision.nextActions.map((item) => item.title).join(" "), /manual review/i);
});

test("disabled or failed AI is presented as not adjudicated rather than a completed final retry", () => {
  for (const status of ["disabled", "failed", "unavailable"]) {
    const result = buildReviewPresentation({ findings: [candidate("pending", { severity: "high", category: "authorization", title: "unchecked owner change" })], ai: { status }, toolRuns: [], runGeneratedTests: false });
    assert.equal(result.releaseDecision.manualReview, 0);
    assert.equal(result.releaseDecision.unreviewed, 1);
    assert.equal(result.touchpoints[0].state, "not-adjudicated");
    assert.match(result.releaseDecision.nextActions[0].title, /Adjudicate 1 pending touchpoint/);
    assert.doesNotMatch(result.releaseDecision.nextActions[0].detail, /final source-focused retry/i);
  }
});

test("an executed generated harness remains a coverage gap until its oracle is independently validated", () => {
  const result = buildReviewPresentation({
    findings: [],
    qualityFindings: [],
    toolRuns: [{ tool: "forge", status: "completed" }],
    ai: { status: "completed", result: { testPlans: [{ executionStatus: "executed-needs-oracle" }] } },
    runGeneratedTests: true,
    auditDepth: "full",
  });
  assert.equal(result.releaseDecision.status, "incomplete");
  assert.equal(result.releaseDecision.regressionPasses, 0);
  assert.equal(result.releaseDecision.testGaps, 1);
  assert.deepEqual(result.releaseDecision.propertyTesting, { status: "attention", label: "0 AI-supported; 0 AI-supported failed properties; 1 executed awaiting oracle review; 0 rejected before Forge; 0 property-check execution errors; 0 timed out" });
  assert.match(result.releaseDecision.nextActions[0].detail, /independent semantic review/);
});

test("deployment input is separated from tool failure and names exact constructor fields", () => {
  const result = buildReviewPresentation({
    source: cleanSource, sourceConclusions: [cleanConclusion], findings: [], qualityFindings: [], runGeneratedTests: false, runAnvil: true,
    ai: { status: "completed", result: { testPlans: [] } },
    anvil: { status: "needs-input", reason: "Developer intent did not define constructor values" },
    aiDeploymentPlan: { targetContract: "SimpleToken" },
    deploymentArtifacts: [{ contract: "SimpleToken", constructorInputs: [{ name: "_name", type: "string" }, { name: "_symbol", type: "string" }, { name: "_initialSupply", type: "uint256" }] }],
    toolRuns: [{ tool: "anvil-deployment", status: "skipped", error: "missing inputs" }],
  });
  const action = result.releaseDecision.nextActions.find((item) => item.type === "targeted-verification");
  assert.equal(result.releaseDecision.status, "ready-with-caveats");
  assert.equal(action.required, false);
  assert.match(action.detail, /SimpleToken/);
  assert.match(action.detail, /_name \(string\)/);
  assert.match(action.detail, /_symbol \(string\)/);
  assert.match(action.detail, /_initialSupply \(uint256\)/);
  assert.match(action.detail, /In Audit Copilot/);
  assert.match(action.detail, /_name="<text>"; _symbol="<text>"; _initialSupply=<decimal amount>/);
  assert.doesNotMatch(result.releaseDecision.nextActions.map((item) => item.title).join(" "), /unavailable or unsuccessful tool/i);
});

test("rejected harnesses are named as pre-Forge gaps rather than failed properties", () => {
  const plans = ["Unauthorized delegated transfer", "Allowance conservation"].map((title, index) => ({
    id: `plan-${index}`,
    title,
    executionStatus: "rejected",
    executionMessage: "Low-level .call is not allowed; use typed calls and Solidity try/catch",
  }));
  const result = buildReviewPresentation({ findings: [], qualityFindings: [], toolRuns: [], runGeneratedTests: true, auditDepth: "full", ai: { status: "completed", result: { testPlans: plans } } });
  assert.equal(result.releaseDecision.regressionFailures, 0);
  assert.equal(result.releaseDecision.testGaps, 2);
  assert.match(result.releaseDecision.propertyTesting.label, /2 rejected before Forge/);
  const action = result.releaseDecision.nextActions[0];
  assert.match(action.title, /rejected before Forge/);
  assert.match(action.detail, /No contract property was executed or failed/);
  assert.match(action.detail, /Unauthorized delegated transfer/);
  assert.match(action.detail, /Allowance conservation/);
  assert.doesNotMatch(action.detail, /validate generated assertion oracles/i);
});

test("AI may conclude that no generated property is needed when no runtime question remains", () => {
  const result = buildReviewPresentation({
    source: cleanSource, sourceConclusions: [cleanConclusion], findings: [], qualityFindings: [], toolRuns: [], runGeneratedTests: true,
    testCampaign: { selectedObligationIds: ["AUTH-01-S01", "STATE-01-S01"] },
    ai: { status: "completed", result: { testPlans: [] } },
  });
  assert.equal(result.releaseDecision.status, "ready-with-caveats");
  assert.equal(result.releaseDecision.testGaps, 0);
  assert.deepEqual(result.releaseDecision.propertyTesting, { status: "not-needed", label: "No generated property was needed for the source-only conclusions" });
  assert.equal(result.releaseDecision.nextActions.some((item) => /missing Foundry property campaign/.test(item.title)), false);
});

test("an AI-supported failing oracle requires review but cannot independently block release", () => {
  const result = buildReviewPresentation({
    findings: [],
    ai: { status: "completed", result: { testPlans: [{ id: "TP-1", title: "Increment oracle", executionStatus: "failed", failureKind: "property-failure", oracleReview: { rationale: "The generated assertion failed" } }] } },
    qualityFindings: [], toolRuns: [], runGeneratedTests: true, verificationQuestions: [], evidenceReview: { questionResults: [] },
  });
  assert.equal(result.releaseDecision.status, "review");
  assert.equal(result.releaseDecision.blockers, 0);
  assert.equal(result.releaseDecision.regressionFailures, 1);
  assert.match(result.releaseDecision.nextActions[0].title, /AI-supported property concern/);
});
