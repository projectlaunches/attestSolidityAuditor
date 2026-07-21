import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { __test } from "../src/server/audit.js";

function optionalRuntimeQuestion(id = "Q-RUNTIME") {
  return {
    id,
    question: "Does the selected runtime property hold?",
    rationale: "The AI source review identified this specific optional assurance check.",
    expectedEvidence: "One source-bound Foundry property",
    priority: "medium",
    materiality: "optional-assurance",
    requiredEvidenceKinds: ["source", "foundry"],
    sufficientEvidenceRoutes: [["source", "foundry"]],
  };
}

test("only open actions from the current evidence revision are executable", () => {
  const job = { evidenceRevision: 2, followup: { actions: [
    { id: "open", evidenceRevision: 2, status: "open", runnable: true },
    { id: "stale", evidenceRevision: 1, status: "open", runnable: true },
    { id: "used", evidenceRevision: 2, status: "consumed", runnable: true },
    { id: "manual", evidenceRevision: 2, status: "open", runnable: false },
  ] } };
  assert.deepEqual(__test.currentFollowupActions(job).map((item) => item.id), ["open"]);
});

test("optional recommended continuations stay runnable without withholding the report", () => {
  const job = {
    evidenceRevision: 2,
    reportState: { status: "completed" },
    followup: { actions: [{ id: "A-optional", evidenceRevision: 2, status: "open", runnable: true, required: false }] },
  };
  assert.deepEqual(__test.currentFollowupActions(job).map((item) => item.id), ["A-optional"]);
  assert.deepEqual(__test.currentFollowupActions(job, { requiredOnly: true }), []);
});

test("unexpected audit failure never leaves findings waiting or retryable", () => {
  const job = {
    status: "running",
    reportMarkdown: "stale",
    reportState: { status: "waiting-for-audit" },
    stages: [{ id: "compile", status: "running" }, { id: "testing", status: "queued" }, { id: "report", status: "queued" }],
    operationLoop: { status: "queued", activeOperation: null, stopReason: null },
    evidenceReview: { status: "queued", error: null },
    worklog: [],
  };
  __test.failJob(job, new Error("compiler worker exited"));
  assert.equal(job.status, "failed");
  assert.equal(job.reportMarkdown, null);
  assert.equal(job.reportState.status, "failed");
  assert.equal(job.reportState.retryable, false);
  assert.match(job.reportState.reason, /compiler worker exited/);
  assert.equal(job.stages.find((item) => item.id === "compile").status, "failed");
  assert.equal(job.stages.find((item) => item.id === "testing").status, "skipped");
  assert.equal(job.stages.find((item) => item.id === "report").status, "failed");
  assert.equal(job.stages.every((item) => ["completed", "failed", "skipped", "timed-out"].includes(item.status)), true);
  assert.equal(job.operationLoop.status, "skipped");
  assert.match(job.operationLoop.stopReason, /compiler worker exited/);
  assert.equal(job.evidenceReview.status, "skipped");
  assert.equal(job.worklog.at(-1).stage, "job");
  assert.equal(job.worklog.at(-1).status, "failed");
});

test("natural explicit run phrases execute while advisory questions do not", () => {
  for (const phrase of ["run it", "please run it", "run this check", "run that test", "run the recommended pass.", "continue testing", "i approve farther testing", "I approve further testing.", "go ahead with the recommended tests", "run those checks", "do it"]) {
    assert.equal(__test.isExplicitFollowupRunRequest(phrase), true, phrase);
  }
  for (const phrase of ["should we run it?", "can you explain that check?", "run everything", "I approve this architecture"]) {
    assert.equal(__test.isExplicitFollowupRunRequest(phrase), false, phrase);
  }
});

test("a completed targeted review exposes only the AI-authored optional checks", () => {
  const job = {
    auditDepth: "targeted",
    evidenceRevision: 3,
    capabilities: { analyzers: [{ id: "forge", available: true }] },
    executionPermissions: { localExecution: true },
    verificationQuestions: [optionalRuntimeQuestion("Q-STATE-VALID"), optionalRuntimeQuestion("Q-STATE-INVALID")],
    evidenceReview: { questionResults: [] },
    suitePlan: [{
      id: "STATE-01", vector: "State-machine ordering", rationale: "Exercise valid and invalid action order.", priority: "high",
      recommendedScenarios: [{ id: "STATE-01-S01", title: "valid transition order" }, { id: "STATE-01-S02", title: "invalid transition order" }],
    }],
    testCampaign: { selectedObligationIds: ["STATE-01-S01", "STATE-01-S02"] },
    operationLoop: { status: "completed", history: [], coverageQuestions: [], coverageObligations: [] },
    followup: { status: "idle", actions: [] },
  };
  __test.refreshFollowupActions(job);
  const actions = __test.currentFollowupActions(job);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].recommendedCampaign, true);
  assert.deepEqual(actions[0].questionIds, ["Q-STATE-VALID", "Q-STATE-INVALID"]);

  __test.activateRecommendedTestingCampaign(job, actions[0]);
  assert.deepEqual(__test.controllerOperationQuestionIds(job), actions[0].questionIds);

  actions[0].status = "consumed";
  job.followup.recommendedCampaignConsumed = true;
  job.evidenceRevision += 1;
  job.operationLoop.status = "completed";
  __test.refreshFollowupActions(job);
  assert.equal(__test.currentFollowupActions(job).length, 0, "a consumed optional campaign is not offered again at a later evidence revision");
});

test("an unconsumed recommended campaign is reissued when developer evidence advances the revision", () => {
  const job = {
    auditDepth: "targeted", evidenceRevision: 2,
    capabilities: { analyzers: [{ id: "forge", available: true }] }, executionPermissions: { localExecution: true },
    verificationQuestions: [optionalRuntimeQuestion("Q-STATE-VALID")], evidenceReview: { questionResults: [] },
    suitePlan: [{ id: "STATE-01", vector: "State transitions", rationale: "Verify the transition.", priority: "high", recommendedScenarios: [{ id: "STATE-01-S01", title: "valid transition" }] }],
    testCampaign: { selectedObligationIds: ["STATE-01-S01"] },
    operationLoop: { status: "completed", history: [], coverageQuestions: [], coverageObligations: [] },
    followup: {
      status: "idle", recommendedCampaignOffered: true, recommendedCampaignOfferedRevision: 1,
      actions: [{ id: "old", evidenceRevision: 1, tool: "controller", status: "stale", runnable: true, recommendedCampaign: true }],
    },
  };
  __test.ensureRecommendedTestingAction(job);
  const action = __test.currentFollowupActions(job)[0];
  assert.equal(action.evidenceRevision, 2);
  assert.equal(action.recommendedCampaign, true);
  assert.equal(job.followup.recommendedCampaignOfferedRevision, 2);
});

test("restoring an older completed audit migrates its recommended campaign into a clickable action", () => {
  const job = {
    status: "completed", auditDepth: "targeted", evidenceRevision: 2, cancelRequested: false,
    capabilities: { analyzers: [{ id: "forge", available: true }] }, executionPermissions: { localExecution: true },
    verificationQuestions: [optionalRuntimeQuestion("Q-BOUNDARY")], evidenceReview: { questionResults: [] }, worklog: [], copilot: { status: "idle", messages: [] },
    suitePlan: [{ id: "BOUND-01", vector: "Boundary inputs", rationale: "Test boundaries.", priority: "high", recommendedScenarios: [{ id: "BOUND-01-S01", title: "zero and one" }] }],
    testCampaign: { selectedObligationIds: ["BOUND-01-S01"] },
    operationLoop: { status: "completed", history: [], coverageQuestions: [], coverageObligations: [] },
    followup: { status: "idle", active: null, history: [], actions: [], defaultNetwork: "ethereum" },
  };
  __test.normalizeRestoredJob(job);
  assert.equal(__test.currentFollowupActions(job).length, 1);
  assert.equal(__test.currentFollowupActions(job)[0].recommendedCampaign, true);
});

test("restoring the pre-fix developer-context dead end reissues its stale campaign at the current revision", () => {
  const job = {
    status: "completed", auditDepth: "targeted", evidenceRevision: 2, cancelRequested: false,
    capabilities: { analyzers: [{ id: "forge", available: true }] }, executionPermissions: { localExecution: true },
    verificationQuestions: [optionalRuntimeQuestion("Q-BOUNDARY")], evidenceReview: { questionResults: [] }, developerEvidence: [{ kind: "audit-context", evidenceRevision: 2 }],
    worklog: [], copilot: { status: "idle", messages: [] }, reportState: { status: "awaiting-testing" },
    suitePlan: [{ id: "BOUND-01", vector: "Boundary inputs", rationale: "Test boundaries.", priority: "high", recommendedScenarios: [{ id: "BOUND-01-S01", title: "zero and one" }] }],
    testCampaign: { selectedObligationIds: ["BOUND-01-S01"] },
    operationLoop: { status: "completed", history: [], coverageQuestions: [], coverageObligations: [] },
    followup: {
      status: "idle", active: null, history: [], defaultNetwork: "ethereum", recommendedCampaignOffered: true,
      actions: [{ id: "legacy-stale", evidenceRevision: 1, tool: "controller", status: "stale", runnable: true, recommendedCampaign: true }],
    },
  };
  __test.normalizeRestoredJob(job);
  const current = __test.currentFollowupActions(job);
  assert.equal(current.length, 1);
  assert.equal(current[0].evidenceRevision, 2);
  assert.notEqual(current[0].id, "legacy-stale");
});

test("multiple unresolved checks project one resumable AI-controller action", () => {
  const job = {
    evidenceRevision: 4,
    verificationQuestions: [{ id: "Q-1" }, { id: "Q-2" }, { id: "Q-3" }],
    evidenceReview: { questionResults: [{ questionId: "Q-3", status: "ai-supported" }] },
    developerEvidence: [], developerDeploymentPlan: null,
    operationLoop: { status: "evidence-exhausted", stopReason: "Execution window ended" },
    followup: { actions: [] },
  };
  __test.refreshFollowupActions(job);
  assert.equal(job.followup.actions.length, 1);
  assert.equal(job.followup.actions[0].tool, "controller");
  assert.deepEqual(job.followup.actions[0].questionIds, ["Q-1", "Q-2"]);
  assert.equal(job.followup.actions[0].runnable, true);
  assert.equal(job.followup.actions[0].required, false);
});

test("campaign plans cannot attach one oracle to several atomic questions", () => {
  const job = {
    evidenceRevision: 2,
    findings: [{ id: "F-1" }],
    suitePlan: [{ id: "S-1" }],
    ai: { result: { testPlans: [] } },
    followup: { maxHarnessesPerRound: 8 },
  };
  const raw = [{
    title: "Grouped token properties", target: "Token", testType: "fuzz", expectedBehavior: "Transfers conserve supply and emit exact events",
    code: "contract GroupedTokenProperties {}", questionIds: ["Q-1", "Q-2", "UNKNOWN"], findingIds: ["F-1", "UNKNOWN"], suitePlanIds: ["S-1"],
  }];
  const plans = __test.normalizeCampaignPlans(job, { id: "12345678-aaaa-bbbb-cccc-123456789012" }, [{ id: "Q-1" }, { id: "Q-2" }], raw);
  assert.equal(plans.length, 0);
});

test("campaign plans may group related questions with complete function-level oracle bindings", () => {
  const job = {
    evidenceRevision: 2, findings: [], suitePlan: [], testCampaign: { generatedTestBudget: 5, plansTruncated: 0 },
    ai: { result: { testPlans: [] } }, followup: { maxHarnessesPerRound: 8 },
  };
  const code = "contract T { function testOne() external { require(true); } function testTwo() external { require(true); } }";
  const raw = [{
    title: "Grouped related properties", target: "Token", testType: "unit", expectedBehavior: "Both related properties hold", code,
    questionIds: ["Q-1", "Q-2"], findingIds: [], suitePlanIds: [],
    oracleBindings: [
      { testFunction: "testOne", questionIds: ["Q-1"] },
      { testFunction: "testTwo", questionIds: ["Q-2"] },
    ],
  }];
  const plans = __test.normalizeCampaignPlans(job, { id: "12345678-aaaa-bbbb-cccc-123456789012", questionId: "Q-1" }, [{ id: "Q-1" }, { id: "Q-2" }], raw, { remaining: 1, retryAllowed: false, maxHarnesses: 1 });
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0].questionIds, ["Q-1", "Q-2"]);
  assert.equal(plans[0].oracleBindings.length, 2);
});

test("generated-test cleanup removes only app-owned compiler inputs", async (context) => {
  const root = await mkdtemp(path.join("/tmp", "attest-harness-cleanup-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const testDir = path.join(root, "test");
  await mkdir(testDir);
  for (const name of ["ActiveGeneratedAudit.t.sol", "GeneratedAudit4.t.sol", "FollowupABC123_2.t.sol", "UserProvided.t.sol"]) {
    await writeFile(path.join(testDir, name), `// ${name}`);
  }
  await __test.cleanupGeneratedHarnesses(root);
  assert.deepEqual(await readdir(testDir), ["UserProvided.t.sol"]);
});

test("developer deployment candidates must be grounded in the chat message", () => {
  const plan = {
    decision: "deploy", transactionValueWei: "0",
    constructorArguments: [
      { position: 0, name: "owner", solidityType: "address", valueKind: "anvil-account", value: "0" },
      { position: 1, name: "name", solidityType: "string", valueKind: "literal", value: "Test Token" },
      { position: 2, name: "supply", solidityType: "uint256", valueKind: "literal", value: "1000000" },
    ],
  };
  assert.doesNotThrow(() => __test.assertDeploymentCandidateSupportedByMessage("Use the local deployer for owner, name Test Token, supply 1,000,000", plan));
  assert.throws(() => __test.assertDeploymentCandidateSupportedByMessage("Use actor-1 and name Test Token", plan), /Actor 0 was not explicitly bound to constructor field owner/);
  assert.throws(() => __test.assertDeploymentCandidateSupportedByMessage("Use the local deployer as owner, name Test Token", plan), /supply/);
  const zeroSupply = structuredClone(plan);
  zeroSupply.constructorArguments[2].value = "0";
  assert.throws(() => __test.assertDeploymentCandidateSupportedByMessage("Use actor-0 as owner and name Test Token", zeroSupply), /supply/);
  const hundredSupply = structuredClone(plan);
  hundredSupply.constructorArguments[2].value = "100";
  assert.throws(() => __test.assertDeploymentCandidateSupportedByMessage("Use the local deployer as owner, name Test Token, and supply 1000", hundredSupply), /supply/);
});

test("fresh Anvil candidates reject arbitrary external-dependency accounts", () => {
  const plan = { decision: "deploy", transactionValueWei: "0", constructorArguments: [
    { position: 0, name: "router", solidityType: "address", valueKind: "anvil-account", value: "1" },
  ] };
  assert.throws(() => __test.assertDeploymentCandidateSupportedByMessage("Use actor-1 as router", plan), /verified local mock or use a supported fork/);
  plan.constructorArguments[0].name = "lendingPool";
  assert.throws(() => __test.assertDeploymentCandidateSupportedByMessage("Use actor-1 as lendingPool", plan), /verified local mock or use a supported fork/);
  for (const name of ["priceFeed", "swapTarget", "strategy"]) {
    plan.constructorArguments[0].name = name;
    assert.throws(() => __test.assertDeploymentCandidateSupportedByMessage(`Use actor-1 as ${name}`, plan), /not an explicit disposable EOA role/);
  }
});

test("constructor values are bound to their named fields rather than a message-wide token set", () => {
  const plan = { decision: "deploy", transactionValueWei: "0", constructorArguments: [
    { position: 0, name: "fee", solidityType: "uint256", valueKind: "literal", value: "1000" },
    { position: 1, name: "supply", solidityType: "uint256", valueKind: "literal", value: "5" },
  ] };
  assert.throws(() => __test.assertDeploymentCandidateSupportedByMessage("fee 5, supply 1000", plan), /constructor field fee/);
  plan.constructorArguments[0].value = "5";
  plan.constructorArguments[1].value = "1000";
  assert.doesNotThrow(() => __test.assertDeploymentCandidateSupportedByMessage("fee 5, supply 1000", plan));
  plan.constructorArguments[0].value = "1000";
  assert.throws(() => __test.assertDeploymentCandidateSupportedByMessage("fee 5 supply 1000", plan), /constructor field fee/);
});

test("multiple disposable actor roles cannot borrow each other's actor values", () => {
  const plan = { decision: "deploy", transactionValueWei: "0", constructorArguments: [
    { position: 0, name: "owner", solidityType: "address", valueKind: "anvil-account", value: "0" },
    { position: 1, name: "guardian", solidityType: "address", valueKind: "anvil-account", value: "1" },
  ] };
  assert.doesNotThrow(() => __test.assertDeploymentCandidateSupportedByMessage("owner actor-0 guardian actor-1", plan));
  plan.constructorArguments[0].value = "1";
  assert.throws(() => __test.assertDeploymentCandidateSupportedByMessage("owner actor-0 guardian actor-1", plan), /constructor field owner/);
});

test("failed follow-up restores evidence and appended plans", () => {
  const originalAction = { id: "A-1", status: "running", evidenceRevision: 1 };
  const operation = { id: "OP-1", committed: false };
  Object.defineProperty(operation, "_rollback", { enumerable: false, value: {
    evidenceRevision: 1,
    evidenceReview: { status: "completed", questionResults: [{ questionId: "Q-1", status: "not-verified" }] },
    testPlans: [{ id: "P-1" }],
    campaign: { plansReturned: 1 },
    suitePlan: [{ id: "S-1", status: "planned" }],
    findings: [{ id: "F-1", evidence: [] }],
    auditSynthesis: { answer: "original" },
    reportMarkdown: "original report",
    reportRevisions: [{ revision: 1 }],
    followupActions: [originalAction], toolRuns: [{ tool: "forge" }], stages: [], anvil: { status: "completed" },
    developerDeploymentPlan: null, operationLoop: { status: "evidence-exhausted", iteration: 2 },
    status: "partial",
  } });
  const job = {
    evidenceRevision: 2, evidenceReview: { status: "running" }, ai: { result: { testPlans: [{ id: "P-1" }, { id: "FU-2" }] } },
    testCampaign: { plansReturned: 2 }, suitePlan: [], findings: [], auditSynthesis: { answer: "changed" }, reportMarkdown: "changed", reportRevisions: [{ revision: 2 }],
    followup: { actions: [{ id: "new" }] }, toolRuns: [], stages: [], anvil: { status: "running" },
    developerDeploymentPlan: null, operationLoop: { status: "running", iteration: 3 }, status: "completed",
  };
  __test.rollbackFollowupState(job, operation);
  assert.equal(job.evidenceRevision, 1);
  assert.deepEqual(job.ai.result.testPlans, [{ id: "P-1" }]);
  assert.deepEqual(job.testCampaign, { plansReturned: 1 });
  assert.equal(job.reportMarkdown, "original report");
  assert.deepEqual(job.followup.actions, [originalAction]);
  assert.deepEqual(job.toolRuns, [{ tool: "forge" }]);
  assert.deepEqual(job.operationLoop, { status: "evidence-exhausted", iteration: 2 });
});

test("Anvil cancellation is recorded as cancelled rather than failed", () => {
  const action = { id: "A", evidenceRevision: 1, status: "running" };
  const operation = { id: "OP", actionId: "A", tool: "anvil", planId: "PLAN", committed: true };
  const job = { evidenceRevision: 1, developerDeploymentPlan: { id: "PLAN", status: "approved" }, followup: { actions: [action], status: "running", active: operation }, worklog: [], updatedAt: "" };
  const error = new Error("Targeted check cancelled by user");
  error.code = "AUDIT_CANCELLED";
  __test.failFollowup(job, operation, error);
  assert.equal(operation.status, "cancelled");
  assert.equal(job.developerDeploymentPlan.status, "proposed");
});

test("follow-up is terminal before its report snapshot is taken", () => {
  const operation = { status: "running", error: "old" };
  const action = { status: "running" };
  const job = { evidenceRevision: 2, followup: { status: "running", active: operation }, worklog: [], updatedAt: "" };
  __test.completeFollowupState(job, operation, action);
  assert.equal(operation.status, "completed");
  assert.equal(action.status, "consumed");
  assert.equal(job.followup.status, "idle");
  assert.equal(job.followup.active, null);
});

test("controller execution uses a selected time window, is revision-bound, and never accepts arbitrary commands", async () => {
  const source = await readFile(new URL("../src/server/audit.js", import.meta.url), "utf8");
  const codex = await readFile(new URL("../src/server/ai/codex-app-server.js", import.meta.url), "utf8");
  assert.match(source, /Date\.now\(\) \+ job\.testCampaign\.timeoutMinutes \* 60_000/);
  assert.match(source, /Two AI-controller rounds produced no new accepted evidence/);
  assert.match(source, /executedCount < 64/);
  assert.match(source, /evidenceRevision !== job\.evidenceRevision/);
  assert.match(source, /\["controller", "developer-context"\]\.includes\(action\.tool\)/);
  assert.match(source, /runAiControlledAudit/);
  assert.match(source, /designAuditCampaign/);
  assert.match(codex, /Act like the primary human auditor/);
  assert.match(codex, /Do not generate a harness merely to rediscover a sourceConclusion/);
  assert.match(source, /assertSubmittedSourceUnchanged\(job\)/);
  assert.match(source, /runEnv\.FOUNDRY_OFFLINE = "false"/);
  assert.match(source, /if \(!fork\) forgeArgs\.push\("--offline"\)/);
  assert.doesNotMatch(source, /body\.(?:command|args|path|source|code|rpcUrl)/);
});
