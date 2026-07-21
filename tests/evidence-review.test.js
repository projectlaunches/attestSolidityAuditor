import test from "node:test";
import assert from "node:assert/strict";
import { applyEvidenceReview, defaultNextCheckForQuestion, markEvidenceReviewUnavailable } from "../src/server/evidence-review.js";
import { buildReviewPresentation } from "../src/server/review-presentation.js";

const source = "pragma solidity ^0.8.20;\ncontract Token { uint256 public totalSupply = 100; function transfer(address, uint256) external returns (bool) { return true; } }\n";
const question = {
  id: "Q-SUPPLY",
  question: "Do transfers preserve the fixed supply?",
  rationale: "Unexpected supply changes can dilute holders",
  priority: "high",
  category: "accounting",
  expectedEvidence: "A source-grounded invariant and executed fuzz assertions",
  requiredEvidenceKinds: ["source", "foundry"],
};

function jobWith(plan) {
  return {
    source,
    sourceHash: "source-hash",
    verificationQuestions: [question],
    evidenceReview: { status: "running" },
    ai: { status: "completed", result: { testPlans: [{ code: "function testSupply() external { require(token.totalSupply() == 100, \"supply changed\"); }", ...plan }] } },
    suitePlan: [{ id: "ERC20-01", status: "planned" }],
    testCampaign: { passed: 0, awaitingOracle: 1, failed: 0, rejected: 0, timedOut: 0 },
    findings: [], qualityFindings: [], toolRuns: [], runGeneratedTests: true,
  };
}

function attachAnvilOperation(job, questionId) {
  const run = {
    runId: `RUN-${questionId}`,
    tool: "anvil-scenario",
    operationKind: "anvil-scenario",
    questionId,
    sourceHash: job.sourceHash,
    operationSpecDigest: "a".repeat(64),
    status: "completed",
    normalizedEvidence: { status: "completed", contractAddress: "0x2222222222222222222222222222222222222222", deploymentReceipt: { logs: [] }, observations: [], scenario: null },
  };
  job.toolRuns.push(run);
  return run;
}

function testEvidence() {
  return [{ quote: "require(token.totalSupply() == 100, \"supply changed\")", why: "This is the generated property oracle" }];
}

function sourceEvidence() {
  return [{ lineStart: 2, lineEnd: 2, quote: "uint256 public totalSupply = 100", why: "The source fixes the tracked supply" }];
}

test("Forge pass becomes verified only after a source-cited oracle review", () => {
  const job = jobWith({ id: "TP-1", title: "Supply invariant", testType: "unit", questionIds: [question.id], suitePlanIds: ["ERC20-01"], executionStatus: "executed-needs-oracle" });
  applyEvidenceReview(job, {
    testResults: [{ testId: "TP-1", verdict: "verified-pass", rationale: "The assertion tracks unchanged totalSupply", questionIds: [question.id], sourceEvidence: sourceEvidence(), testEvidence: testEvidence() }],
    questionResults: [{ questionId: question.id, status: "verified", answer: "The executed invariant preserved totalSupply within its tested scope.", confidence: "high", relatedTestIds: ["TP-1"], sourceEvidence: sourceEvidence(), nextCheck: { needed: false, tool: "none", objective: "none", reason: "answered" } }],
  });
  assert.equal(job.ai.result.testPlans[0].executionStatus, "executed-ai-supported");
  assert.equal(job.testCampaign.passed, 1);
  assert.equal(job.testCampaign.awaitingOracle, 0);
  assert.equal(job.suitePlan[0].status, "ai-supported");
  const presentation = buildReviewPresentation(job);
  assert.equal(presentation.releaseDecision.regressionPasses, 1);
  assert.deepEqual(presentation.verificationResults[0].evidenceClasses, ["ai-source-supported", "unit-tested"]);
});

test("only fuzz and invariant plans receive adversarially-tested assurance", () => {
  const job = jobWith({ id: "TP-FUZZ", title: "Fuzzed supply invariant", testType: "fuzz", questionIds: [question.id], suitePlanIds: ["ERC20-01"], executionStatus: "executed-needs-oracle" });
  applyEvidenceReview(job, {
    testResults: [{ testId: "TP-FUZZ", verdict: "verified-pass", rationale: "Fuzz execution preserved supply", questionIds: [question.id], sourceEvidence: sourceEvidence(), testEvidence: testEvidence() }],
    questionResults: [{ questionId: question.id, status: "verified", answer: "The fuzz campaign preserved totalSupply in its tested domain.", confidence: "high", relatedTestIds: ["TP-FUZZ"], sourceEvidence: sourceEvidence(), nextCheck: { needed: false, tool: "none", objective: "none", reason: "answered" } }],
  });
  assert.deepEqual(job.evidenceReview.questionResults[0].evidenceClasses, ["ai-source-supported", "adversarially-tested"]);
});

test("source-provable behavior reaches a conclusion without a generated harness", () => {
  const sourceQuestion = { ...question, id: "Q-SOURCE", question: "Is totalSupply initialized to 100 in the submitted source?", expectedEvidence: "Exact source assignment", requiredEvidenceKinds: ["source"] };
  const job = jobWith({ id: "unused", questionIds: [sourceQuestion.id], executionStatus: "not-run" });
  job.verificationQuestions = [sourceQuestion];
  job.ai.result.testPlans = [];
  job.sourceConclusions = [{ id: "SC-SUPPLY", statement: "The source initializes totalSupply to 100.", assurance: "ai-source-supported", sourceValidated: true, evidence: sourceEvidence() }];
  applyEvidenceReview(job, { testResults: [], questionResults: [{
    questionId: sourceQuestion.id, status: "verified", answer: "The declaration initializes totalSupply to 100.", confidence: "high", relatedTestIds: [], sourceEvidence: sourceEvidence(),
    nextCheck: { needed: false, tool: "none", objective: "none", reason: "answered from source" },
  }] });
  const result = job.evidenceReview.questionResults[0];
  assert.equal(result.status, "ai-supported");
  assert.deepEqual(result.evidenceClasses, ["ai-source-supported"]);
  assert.equal(result.nextCheck.needed, false);
  assert.equal(buildReviewPresentation(job).releaseDecision.testGaps, 0);
});

test("source conclusions auto-answer linked objective source questions", () => {
  const sourceQuestion = {
    ...question,
    id: "Q-TRACE",
    question: "Does the constructor assign the declared supply to the deployer in source?",
    rationale: "Initial allocation affects funds safety",
    expectedEvidence: "Exact source trace",
    requiredEvidenceKinds: ["source"],
  };
  const job = jobWith({ id: "unused", questionIds: [sourceQuestion.id], executionStatus: "not-run" });
  job.verificationQuestions = [sourceQuestion];
  job.ai.result.testPlans = [];
  job.sourceConclusions = [{
    id: "SC-TRACE",
    statement: "The source fixes totalSupply at 100 before runtime interactions.",
    category: "accounting",
    confidence: "high",
    rationale: "The declaration assigns the tracked supply directly.",
    assurance: "ai-source-supported",
    sourceValidated: true,
    evidence: sourceEvidence(),
    relatedQuestionIds: [sourceQuestion.id],
  }];
  applyEvidenceReview(job, { testResults: [], questionResults: [] });
  assert.equal(job.evidenceReview.questionResults[0].status, "ai-supported");
  assert.equal(job.evidenceReview.questionResults[0].answer, "The source fixes totalSupply at 100 before runtime interactions.");
  assert.deepEqual(job.evidenceReview.questionResults[0].evidenceClasses, ["ai-source-supported"]);
  assert.equal(job.evidenceReview.questionResults[0].nextCheck.needed, false);
});

test("source conclusions do not satisfy stronger runtime questions", () => {
  const runtimeQuestion = {
    ...question,
    id: "Q-RUNTIME-TRACE",
    question: "Does fresh Anvil deployment assign every unit to the deployer?",
    rationale: "Runtime deployment observation is stronger than source trace",
    expectedEvidence: "Fresh Anvil deployment observations",
    requiredEvidenceKinds: ["source", "anvil-deployment", "anvil-observation"],
  };
  const job = jobWith({ id: "unused", questionIds: [runtimeQuestion.id], executionStatus: "not-run" });
  job.verificationQuestions = [runtimeQuestion];
  job.ai.result.testPlans = [];
  job.sourceConclusions = [{
    id: "SC-RUNTIME-TRACE",
    statement: "The source-level constructor flow assigns supply to msg.sender.",
    category: "accounting",
    confidence: "high",
    rationale: "The cited source shows the assignment path.",
    assurance: "ai-source-supported",
    sourceValidated: true,
    evidence: sourceEvidence(),
    relatedQuestionIds: [runtimeQuestion.id],
  }];
  applyEvidenceReview(job, { testResults: [], questionResults: [] });
  assert.equal(job.evidenceReview.questionResults[0].status, "not-verified");
  assert.equal(job.evidenceReview.questionResults[0].nextCheck.tool, "anvil");
});

test("missing model tool input preserves the inferred route's real reason", () => {
  const contextQuestion = {
    id: "Q-INTENT",
    question: "Is centralized pause authority accepted by the developer?",
    rationale: "This is a product intent decision.",
    expectedEvidence: "Developer statement of accepted authority",
    requiredEvidenceKinds: ["developer-context"],
  };
  const next = defaultNextCheckForQuestion(contextQuestion, {}, "Developer intent was not provided");
  assert.equal(next.tool, "developer-context");
  assert.equal(next.reason, "Developer intent was not provided");
  assert.doesNotMatch(next.reason, /objective property/);
});

test("invalid generated oracle never becomes a contract property failure", () => {
  const job = jobWith({ id: "TP-1", title: "Supply accounting", questionIds: [question.id], suitePlanIds: ["ERC20-01"], executionStatus: "failed", failureKind: "unverified-assertion" });
  const review = {
    testResults: [{ testId: "TP-1", verdict: "invalid-test", rationale: "The final balance assertion double-counts the return transfer", questionIds: [question.id], sourceEvidence: sourceEvidence(), testEvidence: testEvidence() }],
    questionResults: [{ questionId: question.id, status: "not-verified", answer: "The failing harness used an invalid arithmetic oracle.", confidence: "high", relatedTestIds: ["TP-1"], sourceEvidence: sourceEvidence(), nextCheck: { needed: true, tool: "forge", objective: "Run a fresh supply-conservation check with correct balance accounting", reason: "The recorded failure cannot answer the question" } }],
  };
  applyEvidenceReview(job, review);
  applyEvidenceReview(job, review);
  const plan = job.ai.result.testPlans[0];
  assert.equal(plan.executionStatus, "invalid-test");
  assert.equal(plan.failureKind, "invalid-oracle");
  assert.equal(job.testCampaign.failed, 0);
  assert.equal(job.testCampaign.invalid, 1);
  const presentation = buildReviewPresentation(job);
  assert.equal(presentation.releaseDecision.regressionFailures, 0);
  assert.equal(presentation.releaseDecision.status, "incomplete");
  assert.doesNotMatch(presentation.releaseDecision.nextActions.map((item) => item.title).join(" "), /failed security property/i);
  assert.match(presentation.releaseDecision.nextActions.map((item) => item.detail).join(" "), /double-counts the return transfer/i);
});

test("unknown ids and invalid citations cannot promote execution evidence", () => {
  const job = jobWith({ id: "TP-1", title: "Supply invariant", questionIds: [question.id], suitePlanIds: ["ERC20-01"], executionStatus: "executed-needs-oracle" });
  applyEvidenceReview(job, {
    testResults: [
      { testId: "UNKNOWN", verdict: "verified-pass", rationale: "unknown", questionIds: [question.id], sourceEvidence: sourceEvidence(), testEvidence: testEvidence() },
      { testId: "TP-1", verdict: "verified-pass", rationale: "citation is fabricated", questionIds: [question.id], sourceEvidence: [{ lineStart: 2, lineEnd: 2, quote: "not in source", why: "invalid" }], testEvidence: testEvidence() },
    ],
    questionResults: [],
  });
  assert.equal(job.ai.result.testPlans[0].executionStatus, "executed-needs-oracle");
  assert.equal(job.testCampaign.passed, 0);
  assert.equal(job.evidenceReview.questionResults[0].status, "not-verified");
});

test("an unavailable evidence turn restores raw execution facts", () => {
  const job = jobWith({ id: "TP-1", title: "Supply invariant", questionIds: [question.id], suitePlanIds: ["ERC20-01"], executionStatus: "executed-needs-oracle" });
  applyEvidenceReview(job, {
    testResults: [{ testId: "TP-1", verdict: "verified-pass", rationale: "The executed assertion matches the source property", questionIds: [question.id], sourceEvidence: sourceEvidence(), testEvidence: testEvidence() }],
    questionResults: [{ questionId: question.id, status: "verified", answer: "Supply was preserved in this test scope.", confidence: "high", relatedTestIds: ["TP-1"], sourceEvidence: sourceEvidence(), nextCheck: { needed: false, tool: "none", objective: "none", reason: "answered" } }],
  });
  assert.equal(job.ai.result.testPlans[0].executionStatus, "executed-ai-supported");
  markEvidenceReviewUnavailable(job, "source fingerprint changed");
  assert.equal(job.ai.result.testPlans[0].executionStatus, "executed-needs-oracle");
  assert.equal(job.testCampaign.passed, 0);
  assert.equal(job.testCampaign.awaitingOracle, 1);
});

test("rejected, timed-out, and harness-error outcomes are not erased by evidence review", () => {
  const plans = [
    { id: "TP-R", questionIds: [question.id], executionStatus: "rejected", executionMessage: "unsafe harness" },
    { id: "TP-T", questionIds: [question.id], executionStatus: "timed-out", executionMessage: "Forge timeout" },
    { id: "TP-H", questionIds: [question.id], executionStatus: "failed", failureKind: "harness-error", executionMessage: "did not compile" },
  ].map((plan) => ({ code: "function testSupply() external { require(token.totalSupply() == 100, \"supply changed\"); }", suitePlanIds: ["ERC20-01"], ...plan }));
  const job = jobWith(plans[0]);
  job.ai.result.testPlans = plans;
  applyEvidenceReview(job, { testResults: [], questionResults: [] });
  assert.deepEqual(plans.map((plan) => [plan.executionStatus, plan.failureKind || null]), [
    ["rejected", null],
    ["timed-out", null],
    ["failed", "harness-error"],
  ]);
  assert.equal(job.testCampaign.rejected, 1);
  assert.equal(job.testCampaign.timedOut, 1);
});

test("a question cannot borrow an unrelated test verdict", () => {
  const otherQuestion = { ...question, id: "Q-OWNER", question: "Can only the owner mint?", category: "authorization" };
  const job = jobWith({ id: "TP-1", title: "Supply invariant", questionIds: [question.id], suitePlanIds: ["ERC20-01"], executionStatus: "executed-needs-oracle" });
  job.verificationQuestions.push(otherQuestion);
  applyEvidenceReview(job, {
    testResults: [{ testId: "TP-1", verdict: "verified-pass", rationale: "The supply assertion matches the source", questionIds: [otherQuestion.id], sourceEvidence: sourceEvidence(), testEvidence: testEvidence() }],
    questionResults: [
      { questionId: otherQuestion.id, status: "verified", answer: "Borrowed the supply result.", confidence: "high", relatedTestIds: ["TP-1"], sourceEvidence: sourceEvidence(), nextCheck: { needed: false, tool: "none", objective: "none", reason: "answered" } },
    ],
  });
  const ownerResult = job.evidenceReview.questionResults.find((item) => item.questionId === otherQuestion.id);
  assert.deepEqual(ownerResult.relatedTestIds, []);
  assert.equal(ownerResult.status, "not-verified");
  assert.equal(job.ai.result.testPlans[0].oracleReview.questionIds[0], question.id);
});

test("invalid-test cannot be paired with a blocking confirmed concern", () => {
  const job = jobWith({ id: "TP-1", title: "Supply accounting", questionIds: [question.id], suitePlanIds: ["ERC20-01"], executionStatus: "failed", failureKind: "unverified-assertion" });
  applyEvidenceReview(job, {
    testResults: [{ testId: "TP-1", verdict: "invalid-test", rationale: "The assertion arithmetic is wrong", questionIds: [question.id], sourceEvidence: sourceEvidence(), testEvidence: testEvidence() }],
    questionResults: [{ questionId: question.id, status: "confirmed-concern", answer: "The model claimed a concern despite the invalid test.", confidence: "high", relatedTestIds: ["TP-1"], sourceEvidence: sourceEvidence(), nextCheck: { needed: false, tool: "none", objective: "none", reason: "answered" } }],
  });
  assert.equal(job.evidenceReview.questionResults[0].status, "not-verified");
  assert.notEqual(buildReviewPresentation(job).releaseDecision.status, "block");
});

test("AI cannot accept behavior on the developer's behalf", () => {
  const job = jobWith({ id: "TP-1", title: "Supply context", questionIds: [question.id], suitePlanIds: ["ERC20-01"], executionStatus: "executed-needs-oracle" });
  job.declaredContext = { contractType: "auto", trustedRoles: "", intendedBehaviors: "", acceptedRisks: "" };
  applyEvidenceReview(job, {
    testResults: [],
    questionResults: [{ questionId: question.id, status: "accepted-behavior", answer: "This behavior is acceptable.", confidence: "high", relatedTestIds: [], sourceEvidence: sourceEvidence(), nextCheck: { needed: false, tool: "none", objective: "none", reason: "answered" } }],
  });
  assert.equal(job.evidenceReview.questionResults[0].status, "developer-decision");
  const presentation = buildReviewPresentation(job);
  assert.equal(presentation.releaseDecision.needsDecision, 0);
  assert.notEqual(presentation.releaseDecision.status, "block");
});

test("Anvil state claims require the exact completed read observations", () => {
  const observationQuestion = {
    id: "Q-ANVIL",
    question: "Does actor 0 receive total supply while another account starts with zero balance?",
    rationale: "Initial allocation matters",
    priority: "high",
    category: "accounting",
    expectedEvidence: "Fresh Anvil deployment plus totalSupply, deployer balance, and another account balance",
    requiredEvidenceKinds: ["source", "anvil-deployment", "anvil-observation"],
  };
  const job = jobWith({ id: "TP-1", title: "Allocation", questionIds: [observationQuestion.id], suitePlanIds: ["ERC20-01"], executionStatus: "not-run" });
  job.verificationQuestions = [observationQuestion];
  const anvilRun = attachAnvilOperation(job, observationQuestion.id);
  anvilRun.normalizedEvidence.observations = [
    { id: "total-supply", status: "completed", value: "100" },
    { id: "balance-actor-0", status: "completed", value: "100" },
    { id: "balance-actor-1", status: "failed", error: "call reverted" },
  ];
  const review = { testResults: [], questionResults: [{ questionId: observationQuestion.id, status: "verified", answer: "Allocation matches.", confidence: "high", sourceEvidence: sourceEvidence(), nextCheck: { needed: false, tool: "none", objective: "none", reason: "answered" } }] };
  applyEvidenceReview(job, review);
  assert.equal(job.evidenceReview.questionResults[0].status, "not-verified");
  anvilRun.normalizedEvidence.observations[2] = { id: "balance-actor-1", status: "completed", value: "0" };
  anvilRun.normalizedEvidence.observations[1] = { id: "balance-actor-0", status: "completed", value: "99" };
  applyEvidenceReview(job, review);
  assert.equal(job.evidenceReview.questionResults[0].status, "not-verified");
  anvilRun.normalizedEvidence.observations[1] = { id: "balance-actor-0", status: "completed", value: "100" };
  applyEvidenceReview(job, review);
  assert.equal(job.evidenceReview.questionResults[0].status, "ai-supported");
  assert.deepEqual(job.evidenceReview.questionResults[0].evidenceClasses, ["ai-source-supported", "runtime-observed"]);
});

test("a completed Anvil scenario expectation mismatch can support a contract concern", () => {
  const scenarioQuestion = {
    id: "Q-ANVIL-CONCERN",
    question: "Can actor 1 call the owner-only transfer function successfully?",
    rationale: "Unauthorized value movement would violate the source-defined access boundary",
    priority: "high",
    category: "authorization",
    expectedEvidence: "A typed actor-1 Anvil call expected to revert",
    requiredEvidenceKinds: ["source", "anvil-scenario"],
  };
  const job = jobWith({ id: "unused", questionIds: [scenarioQuestion.id], executionStatus: "not-run" });
  job.verificationQuestions = [scenarioQuestion];
  job.ai.result.testPlans = [];
  const anvilRun = attachAnvilOperation(job, scenarioQuestion.id);
  anvilRun.normalizedEvidence.scenario = {
    status: "property-failure",
    steps: [{ id: "unauthorized-call", status: "completed", expectedOutcome: "revert", matchedExpectation: false }],
  };
  applyEvidenceReview(job, { testResults: [], questionResults: [{
    questionId: scenarioQuestion.id,
    status: "confirmed-concern",
    answer: "Actor 1 successfully executed a call the source intends to restrict.",
    confidence: "high",
    sourceEvidence: sourceEvidence(),
    nextCheck: { needed: false, tool: "none", objective: "none", reason: "answered" },
  }] });
  assert.equal(job.evidenceReview.questionResults[0].status, "ai-supported-concern");
  assert.deepEqual(job.evidenceReview.questionResults[0].evidenceClasses, ["ai-source-supported", "runtime-observed"]);
});

test("constructor Transfer evidence is answered directly from the Anvil deployment receipt", () => {
  const eventQuestion = {
    id: "Q-CONSTRUCTOR-EVENT", question: "Does deployment emit exactly one Transfer event from address(0) to the deployer for the full supply?", rationale: "Wallets depend on deployment logs",
    priority: "medium", category: "compatibility", expectedEvidence: "Fresh Anvil deployment receipt with exact fields and value",
    requiredEvidenceKinds: ["source", "anvil-deployment", "anvil-observation"],
  };
  const deployer = "0x1111111111111111111111111111111111111111";
  const contract = "0x2222222222222222222222222222222222222222";
  const job = jobWith({ id: "unused", questionIds: [eventQuestion.id], executionStatus: "not-run" });
  job.verificationQuestions = [eventQuestion];
  job.ai.result.testPlans = [];
  const anvilRun = attachAnvilOperation(job, eventQuestion.id);
  Object.assign(anvilRun.normalizedEvidence, {
    deployer, contractAddress: contract,
    observations: [{ id: "total-supply", status: "completed", value: "100" }],
    deploymentReceipt: { logs: [{
      address: contract,
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        `0x${"0".repeat(64)}`,
        `0x${"0".repeat(24)}${deployer.slice(2)}`,
      ],
      data: `0x${100n.toString(16).padStart(64, "0")}`,
    }] },
  });
  applyEvidenceReview(job, { testResults: [], questionResults: [{
    questionId: eventQuestion.id, status: "verified", answer: "The deployment receipt contains exactly the expected mint Transfer.", confidence: "high", relatedTestIds: [], sourceEvidence: sourceEvidence(),
    nextCheck: { needed: false, tool: "none", objective: "none", reason: "answered" },
  }] });
  assert.equal(job.evidenceReview.questionResults[0].status, "ai-supported");
  assert.deepEqual(job.evidenceReview.questionResults[0].evidenceClasses, ["ai-source-supported", "runtime-observed"]);
});

test("owner runtime assurance requires the observed owner to match the claimed deployer", () => {
  const ownerQuestion = { ...question, id: "Q-OWNER", question: "Does owner equal the actor-0 deployer?", expectedEvidence: "Fresh Anvil owner observation", requiredEvidenceKinds: ["source", "anvil-deployment", "anvil-observation"] };
  const job = jobWith({ id: "unused", questionIds: [ownerQuestion.id], executionStatus: "not-run" });
  job.verificationQuestions = [ownerQuestion];
  job.ai.result.testPlans = [];
  const anvilRun = attachAnvilOperation(job, ownerQuestion.id);
  Object.assign(anvilRun.normalizedEvidence, { deployer: "0x1111111111111111111111111111111111111111", observations: [{ id: "owner", status: "completed", value: "0x2222222222222222222222222222222222222222" }] });
  const review = { testResults: [], questionResults: [{ questionId: ownerQuestion.id, status: "verified", answer: "Owner is the deployer.", confidence: "high", sourceEvidence: sourceEvidence(), nextCheck: { needed: false, tool: "none", objective: "none", reason: "answered" } }] };
  applyEvidenceReview(job, review);
  assert.equal(job.evidenceReview.questionResults[0].status, "not-verified");
  anvilRun.normalizedEvidence.observations[0].value = anvilRun.normalizedEvidence.deployer;
  applyEvidenceReview(job, review);
  assert.equal(job.evidenceReview.questionResults[0].status, "ai-supported");
  assert.deepEqual(job.evidenceReview.questionResults[0].evidenceClasses, ["ai-source-supported", "runtime-observed"]);
});

test("fork assurance is bound to the related plan and pinned network evidence", () => {
  const forkQuestion = { ...question, id: "Q-FORK", question: "Does the integration behave at the pinned Base state?", expectedEvidence: "Read-only pinned Base fork execution", requiredEvidenceKinds: ["source", "fork"] };
  const job = jobWith({ id: "TP-FORK", title: "Pinned integration", testType: "unit", questionIds: [forkQuestion.id], suitePlanIds: ["ERC20-01"], executionStatus: "executed-needs-oracle" });
  job.verificationQuestions = [forkQuestion];
  const review = {
    testResults: [{ testId: "TP-FORK", verdict: "verified-pass", rationale: "The pinned execution matched the property", questionIds: [forkQuestion.id], sourceEvidence: sourceEvidence(), testEvidence: testEvidence() }],
    questionResults: [{ questionId: forkQuestion.id, status: "verified", answer: "The integration passed at the pinned state.", confidence: "high", relatedTestIds: ["TP-FORK"], sourceEvidence: sourceEvidence(), nextCheck: { needed: false, tool: "none", objective: "none", reason: "answered" } }],
  };
  applyEvidenceReview(job, review);
  assert.equal(job.evidenceReview.questionResults[0].status, "not-verified");
  job.ai.result.testPlans[0].networkEvidence = { id: "base", chainId: 8453, blockNumber: 123, blockHash: "0xabc" };
  applyEvidenceReview(job, review);
  assert.equal(job.evidenceReview.questionResults[0].status, "ai-supported");
  assert.deepEqual(job.evidenceReview.questionResults[0].evidenceClasses, ["ai-source-supported", "fork-tested"]);
});

test("an invalid oracle cannot promote a raw Foundry failure into a concern", () => {
  const job = jobWith({ id: "TP-1", title: "Supply invariant", questionIds: [question.id], suitePlanIds: ["ERC20-01"], executionStatus: "failed", failureKind: "property-failure" });
  applyEvidenceReview(job, {
    testResults: [{ testId: "TP-1", verdict: "invalid-test", rationale: "The assertion does not measure conservation", questionIds: [question.id], sourceEvidence: sourceEvidence(), testEvidence: testEvidence() }],
    questionResults: [{ questionId: question.id, status: "confirmed-concern", answer: "Supply conservation failed.", confidence: "high", relatedTestIds: ["TP-1"], sourceEvidence: sourceEvidence(), nextCheck: { needed: false, tool: "none", objective: "none", reason: "answered" } }],
  });
  assert.equal(job.evidenceReview.questionResults[0].status, "not-verified");
  assert.deepEqual(job.evidenceReview.questionResults[0].evidenceClasses, []);
  assert.equal(buildReviewPresentation(job).releaseDecision.regressionFailures, 0);
});

test("proven constructor allocation is retained when constructor event evidence is still missing", () => {
  const stateQuestion = {
    id: "Q-CONSTRUCTOR-STATE", question: "Does deployment assign every unit to the deployer?", rationale: "Initial ownership matters",
    priority: "high", category: "accounting", expectedEvidence: "Total supply, actor-0 deployer balance, and actor-1 non-deployer balance",
    requiredEvidenceKinds: ["source", "anvil-deployment", "anvil-observation"],
  };
  const eventQuestion = {
    id: "Q-CONSTRUCTOR-EVENT", question: "Does deployment emit the exact mint Transfer event?", rationale: "Consumers depend on logs",
    priority: "medium", category: "compatibility", expectedEvidence: "Executed Foundry event assertion", requiredEvidenceKinds: ["source", "foundry"],
  };
  const job = jobWith({ id: "TP-STATE", title: "Allocation", questionIds: [stateQuestion.id], suitePlanIds: ["ERC20-01"], executionStatus: "not-run" });
  job.verificationQuestions = [stateQuestion, eventQuestion];
  const anvilRun = attachAnvilOperation(job, stateQuestion.id);
  anvilRun.normalizedEvidence.observations = [
    { id: "total-supply", status: "completed", value: "100" },
    { id: "balance-actor-0", status: "completed", value: "100" },
    { id: "balance-actor-1", status: "completed", value: "0" },
  ];
  applyEvidenceReview(job, { testResults: [], questionResults: [
    { questionId: stateQuestion.id, status: "verified", answer: "All observed supply belongs to the deployer and actor 1 holds zero.", confidence: "high", sourceEvidence: sourceEvidence(), nextCheck: { needed: false, tool: "none", objective: "none", reason: "answered" } },
    { questionId: eventQuestion.id, status: "not-verified", answer: "The constructor log was not inspected.", confidence: "high", sourceEvidence: sourceEvidence(), nextCheck: { needed: true, tool: "forge", objective: "Inspect the constructor event", reason: "Event evidence is missing" } },
  ] });
  assert.equal(job.evidenceReview.questionResults[0].status, "ai-supported");
  assert.equal(job.evidenceReview.questionResults[1].status, "not-verified");
});

test("objective accounting gaps cannot be routed to developer opinion", () => {
  const job = jobWith({ id: "TP-1", title: "Supply accounting", questionIds: [question.id], suitePlanIds: ["ERC20-01"], executionStatus: "not-run" });
  applyEvidenceReview(job, {
    testResults: [],
    questionResults: [{
      questionId: question.id,
      status: "not-verified",
      answer: "The available execution did not prove conservation.",
      confidence: "high",
      sourceEvidence: sourceEvidence(),
      nextCheck: { needed: true, tool: "developer-context", objective: "Ask whether supply should remain fixed", reason: "Developer confirmation is needed" },
    }],
  });
  const result = job.evidenceReview.questionResults[0];
  assert.equal(result.nextCheck.tool, "forge");
  assert.match(result.nextCheck.reason, /Developer opinion cannot prove it/);
});

test("one Anvil question cannot borrow another operation's later observations", () => {
  const q1 = { ...question, id: "Q-OWNER-1", question: "Does owner equal the actor-0 deployer?", expectedEvidence: "Fresh Anvil owner observation", requiredEvidenceKinds: ["source", "anvil-deployment", "anvil-observation"] };
  const q2 = { ...q1, id: "Q-OWNER-2" };
  const job = jobWith({ id: "unused", questionIds: [q1.id], executionStatus: "not-run" });
  job.verificationQuestions = [q1, q2];
  job.ai.result.testPlans = [];
  const first = attachAnvilOperation(job, q1.id);
  Object.assign(first.normalizedEvidence, { deployer: "0x1111111111111111111111111111111111111111", observations: [{ id: "owner", status: "completed", value: "0x2222222222222222222222222222222222222222" }] });
  const second = attachAnvilOperation(job, q2.id);
  Object.assign(second.normalizedEvidence, { deployer: "0x1111111111111111111111111111111111111111", observations: [{ id: "owner", status: "completed", value: "0x1111111111111111111111111111111111111111" }] });
  applyEvidenceReview(job, { testResults: [], questionResults: [
    { questionId: q1.id, status: "verified", answer: "Owner is actor 0.", confidence: "high", sourceEvidence: sourceEvidence(), nextCheck: { needed: false, tool: "none", objective: "none", reason: "answered" } },
    { questionId: q2.id, status: "verified", answer: "Owner is actor 0.", confidence: "high", sourceEvidence: sourceEvidence(), nextCheck: { needed: false, tool: "none", objective: "none", reason: "answered" } },
  ] });
  assert.equal(job.evidenceReview.questionResults.find((item) => item.questionId === q1.id).status, "not-verified");
  assert.equal(job.evidenceReview.questionResults.find((item) => item.questionId === q2.id).status, "ai-supported");
});
