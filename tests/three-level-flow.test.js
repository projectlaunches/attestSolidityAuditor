import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { askAuditCopilot, createAudit, getJob } from "../src/server/audit.js";

const smokeSource = await readFile(new URL("../samples/SmokeCounter.sol", import.meta.url), "utf8");
const sourceEvidence = [{ lineStart: 8, lineEnd: 8, quote: "value += 1;", why: "The complete increment state transition." }];

function profile({ runtimeQuestion = false, optionalRuntimeQuestion = false } = {}) {
  const needsRuntime = runtimeQuestion || optionalRuntimeQuestion;
  const question = {
    id: "Q-INCREMENT",
    question: "Does one successful increment call increase value by exactly one?",
    rationale: "This is the contract's only state transition.",
    priority: "high",
    category: "state-transition",
    expectedEvidence: needsRuntime ? "Exact source trace plus one executed Foundry property" : "Exact source trace",
    materiality: runtimeQuestion ? "required-for-opinion" : "optional-assurance",
    requiredEvidenceKinds: needsRuntime ? ["source", "foundry"] : ["source"],
    sufficientEvidenceRoutes: [needsRuntime ? ["source", "foundry"] : ["source"]],
  };
  return {
    contractProfile: { archetypes: ["custom-contract"], trustedRoles: [], assets: [], externalDependencies: [], intendedBehaviors: ["increment a counter"], assumptions: [] },
    contractSummary: "A constructor-free counter with one state-changing function.",
    threatModel: "No funds, roles, or external calls are present.",
    sourceConclusions: [{
      id: "SC-INCREMENT", statement: "Each successful increment call adds exactly one to value.", category: "state-transition",
      classification: "neutral-fact", severity: "info", confidence: "high", rationale: "The function contains one direct increment.",
      evidence: sourceEvidence, relatedQuestionIds: [question.id],
    }],
    sourceFindings: [],
    deploymentPlan: { decision: "deploy", decisionReason: "deploy-ready", environment: "fresh-anvil", targetContract: "SmokeCounter", constructorArguments: [], transactionValueWei: "0", rationale: "No constructor inputs are required.", limitations: [] },
    verificationQuestions: [question],
    limitations: [],
  };
}

function capabilities({ forge = false } = {}) {
  return {
    codex: { available: true, version: "flow-fixture" },
    analyzers: forge
      ? [{ id: "forge", label: "Foundry", command: "forge", available: true, version: "test-runtime" }]
      : [],
  };
}

function conclusion(assessment = "The selected scope has reached a supported opinion.") {
  return { status: "conclude", assessment, operations: [], coverageUpdates: [], requestedInput: "" };
}

function operation(questionId) {
  return {
    id: "OP-INCREMENT-1", kind: "foundry", questionId,
    objective: "Execute one source-bound increment property",
    rationale: "A runtime observation adds material assurance to the source trace.",
    slitherDetectors: [], aderynSeverity: "all", compilerVersions: [], networkId: "", scenario: null,
  };
}

async function waitFor(id, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = getJob(id);
    if (job && predicate(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Audit ${id} did not reach the expected state`);
}

test("the three engagement levels cycle through distinct truthful states", async (context) => {
  const root = await mkdtemp(path.join("/tmp", "attest-three-level-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sourceOnlyCodex = {
    profile: async () => structuredClone(profile()),
    planAuditOperations: async () => conclusion(),
    cancelActiveReview: async () => {},
  };

  const review = createAudit({ projectRoot: root, capabilities: capabilities(), codex: sourceOnlyCodex, source: smokeSource, fileName: "SmokeCounter.sol", auditDepth: "review" });
  const reviewDone = await waitFor(review.id, (job) => job.reportState?.status === "ready");
  assert.equal(reviewDone.auditDepth, "review");
  assert.equal(reviewDone.toolRuns.length, 0);
  assert.match(reviewDone.worklog.findLast((item) => item.stage === "report" && item.status === "completed").message, /no executable testing was selected/);

  const targeted = createAudit({ projectRoot: root, capabilities: capabilities(), codex: sourceOnlyCodex, source: smokeSource, fileName: "SmokeCounter.sol", auditDepth: "targeted" });
  const targetedDone = await waitFor(targeted.id, (job) => job.reportState?.status === "ready");
  assert.equal(targetedDone.auditDepth, "targeted");
  assert.equal(targetedDone.toolRuns.length, 0);
  assert.equal(targetedDone.auditSynthesis.answer, "The selected scope has reached a supported opinion.");

  const full = createAudit({ projectRoot: root, capabilities: capabilities(), codex: sourceOnlyCodex, source: smokeSource, fileName: "SmokeCounter.sol", auditDepth: "full" });
  const fullDone = await waitFor(full.id, (job) => job.reportState?.status === "ready");
  assert.equal(fullDone.auditDepth, "full");
  assert.equal(fullDone.coverageObligations.length, 0, "the server must not manufacture a mandatory per-tool audit checklist");
  assert.equal(fullDone.auditSynthesis.answer, "The selected scope has reached a supported opinion.");
  assert.match(fullDone.worklog.findLast((item) => item.stage === "report" && item.status === "completed").message, /no runtime property test was executed/);
});

test("targeted mode executes and adjudicates a real Foundry property before concluding", async (context) => {
  const root = await mkdtemp(path.join("/tmp", "attest-targeted-foundry-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  let planningTurns = 0;
  const codex = {
    profile: async () => structuredClone(profile({ runtimeQuestion: true })),
    planAuditOperations: async () => (++planningTurns === 1
      ? { status: "continue", assessment: "Run the one material runtime property.", operations: [operation("Q-INCREMENT")], coverageUpdates: [], requestedInput: "" }
      : conclusion("The source trace and executed property now support the opinion.")),
    designAuditCampaign: async () => ({ testPlans: [{
      id: "TP-INCREMENT", title: "Increment changes value by one", findingIds: [], suitePlanIds: ["STATE-01"], questionIds: ["Q-INCREMENT"],
      target: "SmokeCounter", testType: "unit", expectedBehavior: "value increases by exactly one",
      code: [
        "// SPDX-License-Identifier: MIT",
        "pragma solidity ^0.8.20;",
        'import "../src/Target.sol";',
        "contract IncrementProperty {",
        "  function testIncrementOnce() external {",
        "    SmokeCounter target = new SmokeCounter();",
        "    uint256 beforeValue = target.value();",
        "    target.increment();",
        '    require(target.value() == beforeValue + 1, "increment mismatch");',
        "  }",
        "}",
      ].join("\n"),
    }] }),
    verifyEvidence: async ({ testPlans }) => ({
      testResults: [{
        testId: testPlans[0].id, verdict: "verified-pass", rationale: "The executed assertion directly checks the only increment transition.",
        questionIds: ["Q-INCREMENT"], sourceEvidence,
        testEvidence: [{ quote: 'require(target.value() == beforeValue + 1, "increment mismatch");', why: "The assertion compares target state before and after increment." }],
      }],
      questionResults: [{
        questionId: "Q-INCREMENT", status: "verified", answer: "One executed call increased value by exactly one.", confidence: "high",
        relatedTestIds: [testPlans[0].id], sourceEvidence,
        nextCheck: { needed: false, tool: "none", objective: "No further check required", reason: "The selected evidence route completed." },
      }],
    }),
    cancelActiveReview: async () => {},
  };
  const created = createAudit({
    projectRoot: root, capabilities: capabilities({ forge: true }), codex, source: smokeSource, fileName: "SmokeCounter.sol",
    auditDepth: "targeted", allowLocalExecution: true, allowAnvil: false, testCampaign: { mode: "smoke" },
  });
  const job = await waitFor(created.id, (item) => item.reportState?.status === "ready", 90_000);
  const run = job.toolRuns.find((item) => item.tool.startsWith("forge-generated:"));
  assert.equal(run?.status, "completed", JSON.stringify({ toolRuns: job.toolRuns, history: job.operationLoop.history, worklog: job.worklog.slice(-12), plans: job.ai?.result?.testPlans }));
  assert.equal(job.testCampaign.passed, 1);
  assert.equal(job.verificationResults.find((item) => item.id === "Q-INCREMENT")?.status, "ai-supported");
  assert.equal(job.auditSynthesis.answer, "The source trace and executed property now support the opinion.");
  assert.match(job.worklog.findLast((item) => item.stage === "report" && item.status === "completed").message, /runtime verification completed/);
  const orderedStages = ["ai-profile", "operation-loop", "evidence-review", "report"]
    .map((stage) => job.worklog.findIndex((item) => item.stage === stage));
  assert.ok(orderedStages.every((index) => index >= 0));
  assert.deepEqual([...orderedStages].sort((left, right) => left - right), orderedStages, "AI review, execution, evidence adjudication, and report must remain ordered");
});

test("accepted Copilot context is applied without manufacturing a generic testing campaign", async (context) => {
  const root = await mkdtemp(path.join("/tmp", "attest-context-continuation-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const intentStatement = "Incrementing by one is the intended production behavior";
  const codex = {
    profile: async () => structuredClone(profile()),
    planAuditOperations: async () => conclusion(),
    discuss: async () => ({
      answer: "I recorded that intended behavior and will apply it to the audit conclusion.",
      citations: sourceEvidence, relatedFindingIds: [], requestedAction: "none", suggestedNextSteps: [], deploymentPlanCandidates: [],
      developerContextCandidates: [{ category: "intended-behavior", statement: intentStatement, relatedQuestionIds: ["Q-INCREMENT"] }],
    }),
    verifyEvidence: async ({ contractModel }) => {
      const hasDeveloperIntent = contractModel.developerEvidence.some((item) => item.statement === intentStatement);
      return {
        testResults: [],
        questionResults: [{
          questionId: "Q-INCREMENT", status: hasDeveloperIntent ? "developer-decision" : "verified",
          answer: hasDeveloperIntent ? "The developer confirmed increment-by-one as intended production behavior." : "The source increments value by exactly one.",
          confidence: "high", relatedTestIds: [], sourceEvidence,
          nextCheck: { needed: false, tool: "none", objective: "No required check", reason: hasDeveloperIntent ? "Developer intent is now recorded." : "The source trace answers the question." },
        }],
      };
    },
    cancelActiveReview: async () => {},
  };
  const created = createAudit({
    projectRoot: root, capabilities: capabilities({ forge: true }), codex, source: smokeSource, fileName: "SmokeCounter.sol",
    auditDepth: "targeted", allowLocalExecution: true, testCampaign: { mode: "smoke" },
  });
  const initial = await waitFor(created.id, (item) => item.reportState?.status === "ready", 10_000);
  const initialEvidenceRevision = initial.evidenceRevision;
  const initialReportRevision = initial.reportRevisions.length;
  assert.equal(initial.followup.actions.some((action) => action.status === "open" && action.recommendedCampaign), false);

  const accepted = await askAuditCopilot(created.id, { question: intentStatement });
  assert.ok(["queued", "running"].includes(accepted.followup.status), "developer context should enter evidence review without another click");
  const completed = await waitFor(created.id, (item) => item.followup?.history?.some((operation) => operation.tool === "developer-context" && ["completed", "failed"].includes(operation.status)), 15_000);

  assert.equal(completed.followup.history.find((operation) => operation.tool === "developer-context")?.status, "completed", JSON.stringify(completed.followup.history));
  assert.equal(completed.reportState?.status, "ready", JSON.stringify(completed.reportState));
  assert.equal(completed.evidenceRevision, initialEvidenceRevision + 2, "acceptance and completed re-review each create a durable evidence revision");
  assert.ok(completed.reportRevisions.length > initialReportRevision, "the conclusion must be republished after applying context");
  assert.equal(completed.followup.actions.some((action) => action.status === "open" && action.recommendedCampaign), false);
});

test("a broad Copilot run instruction resolves to the one server-issued continuation and executes it", async (context) => {
  const root = await mkdtemp(path.join("/tmp", "attest-copilot-action-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const codex = {
    profile: async () => structuredClone(profile({ optionalRuntimeQuestion: true })),
    planAuditOperations: async ({ operationHistory, verificationQuestions }) => {
      const candidate = verificationQuestions.find((item) => item.id === "Q-INCREMENT");
      if (!candidate || operationHistory.length) return conclusion();
      return {
        status: "continue", assessment: "Execute the approved recommended property.",
        operations: [operation(candidate.id)], coverageUpdates: [], requestedInput: "",
      };
    },
    discuss: async () => ({
      answer: "I understood this as authorization to run the currently offered focused verification campaign.",
      citations: [], relatedFindingIds: [], requestedAction: "run-current-continuation", suggestedNextSteps: [],
      deploymentPlanCandidates: [], developerContextCandidates: [],
    }),
    designAuditCampaign: async ({ questions }) => ({ testPlans: [{
      id: "TP-COPILOT-INCREMENT", title: "Copilot-authorized increment property", findingIds: [], suitePlanIds: [questions[0].suitePlanId], questionIds: [questions[0].id],
      target: "SmokeCounter", testType: "unit", expectedBehavior: "value increases by exactly one",
      code: [
        "// SPDX-License-Identifier: MIT", "pragma solidity ^0.8.20;", 'import "../src/Target.sol";',
        "contract CopilotIncrementProperty {", "  function testIncrementOnce() external {", "    SmokeCounter target = new SmokeCounter();",
        "    uint256 beforeValue = target.value();", "    target.increment();",
        '    require(target.value() == beforeValue + 1, "increment mismatch");', "  }", "}",
      ].join("\n"),
    }] }),
    verifyEvidence: async ({ verificationQuestions, testPlans }) => {
      const question = verificationQuestions.find((item) => item.id === "Q-INCREMENT");
      const plan = testPlans.find((item) => item.questionIds.includes(question.id));
      return {
        testResults: [{
          testId: plan.id, verdict: "verified-pass", rationale: "The executed assertion directly checks the approved property.",
          questionIds: [question.id], sourceEvidence,
          testEvidence: [{ quote: 'require(target.value() == beforeValue + 1, "increment mismatch");', why: "The assertion is grounded in target state." }],
        }],
        questionResults: [{
          questionId: question.id, status: "verified", answer: "The approved property held in the executed scope.", confidence: "high",
          relatedTestIds: [plan.id], sourceEvidence,
          nextCheck: { needed: false, tool: "none", objective: "No further check required", reason: "The approved check completed." },
        }],
      };
    },
    cancelActiveReview: async () => {},
  };
  const created = createAudit({
    projectRoot: root, capabilities: capabilities({ forge: true }), codex, source: smokeSource, fileName: "SmokeCounter.sol",
    auditDepth: "targeted", allowLocalExecution: true, testCampaign: { mode: "smoke" },
  });
  const initial = await waitFor(created.id, (item) => item.reportState?.status === "ready" && item.followup?.actions?.some((action) => action.status === "open"));
  assert.deepEqual(initial.followup.actions.find((action) => action.status === "open").questionIds, ["Q-INCREMENT"]);
  const originalRevisionCount = initial.reportRevisions.length;
  const queued = await askAuditCopilot(created.id, { question: "Please carry out the focused runtime assurance you recommended so the report includes the result." });
  assert.ok(["queued", "running"].includes(queued.followup.status));
  const completed = await waitFor(created.id, (item) => item.followup?.history?.length === 1
    && item.followup.history[0].status === "completed"
    && item.reportState?.status === "ready"
    && item.reportRevisions.length > originalRevisionCount, 90_000);
  assert.equal(completed.followup.history[0].tool, "controller");
  assert.equal(completed.followup.actions.find((action) => action.id === completed.followup.history[0].actionId)?.status, "consumed");
  assert.ok(completed.toolRuns.some((item) => item.tool.startsWith("forge-generated:") && item.status === "completed"), JSON.stringify({ toolRuns: completed.toolRuns, history: completed.operationLoop.history, approved: completed.operationLoop.approvedTestingCampaign, questions: completed.verificationQuestions, decisions: completed.operationLoop.decisions, worklog: completed.worklog.slice(-12) }));
  assert.match(completed.worklog.findLast((item) => item.stage === "report" && item.status === "completed").message, /runtime verification completed/);
});
