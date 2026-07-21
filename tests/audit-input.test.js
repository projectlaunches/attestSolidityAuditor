import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { __test } from "../src/server/audit.js";

test("chat-supplied constructor values create a revision-bound local Anvil action without executing", async (context) => {
  const root = await mkdtemp(path.join("/tmp", "attest-chat-input-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const artifactDir = path.join(root, "out", "Target.sol");
  await mkdir(artifactDir, { recursive: true });
  await writeFile(path.join(artifactDir, "SimpleToken.json"), JSON.stringify({
    abi: [{ type: "constructor", stateMutability: "nonpayable", inputs: [
      { name: "owner", type: "address", internalType: "address" },
      { name: "name", type: "string", internalType: "string" },
      { name: "initialSupply", type: "uint256", internalType: "uint256" },
    ] }],
    bytecode: { object: "0x60006000", linkReferences: {} },
    metadata: { settings: { compilationTarget: { "src/Target.sol": "SimpleToken" } } },
    ast: { nodes: [{ nodeType: "ContractDefinition", name: "SimpleToken", id: 1, linearizedBaseContracts: [1] }] },
  }));
  const job = {
    jobDir: root, sourceHash: "source-hash", runAnvil: true, evidenceRevision: 1,
    verificationQuestions: [{ id: "Q-DEPLOY" }], developerEvidence: [], developerDeploymentPlan: null,
    evidenceReview: { questionResults: [] }, operationLoop: { status: "needs-input", stopReason: "Constructor values required" }, followup: { actions: [] },
    anvil: { requested: true, status: "needs-input" }, reportMarkdown: null,
    reportState: { status: "awaiting-testing" }, worklog: [], updatedAt: "",
  };
  const questionMessage = { id: "MSG-1", text: "Use the local deployer as owner, name Test Token, and initial supply 1,000,000" };
  const plan = {
    decision: "deploy", decisionReason: "deploy-ready", environment: "fresh-anvil", targetContract: "SimpleToken",
    constructorArguments: [
      { position: 0, name: "owner", solidityType: "address", valueKind: "anvil-account", value: "0", rationale: "developer chose local deployer" },
      { position: 1, name: "name", solidityType: "string", valueKind: "literal", value: "Test Token", rationale: "developer fixture" },
      { position: 2, name: "initialSupply", solidityType: "uint256", valueKind: "literal", value: "1000000", rationale: "developer fixture" },
    ],
    transactionValueWei: "0", rationale: "Developer supplied a disposable fixture", limitations: ["local only"],
  };
  const result = await __test.applyCopilotDeveloperInputs(job, {
    deploymentPlanCandidates: [{ deploymentPlan: plan, explicitlyProvidedFields: ["owner", "name", "initialSupply"], summary: "Disposable token fixture" }],
    developerContextCandidates: [],
  }, questionMessage);

  assert.equal(result.status, "accepted");
  assert.equal(job.evidenceRevision, 2);
  assert.equal(job.anvil.status, "ready");
  assert.match(job.developerDeploymentPlan.id, /^PLAN-[A-F0-9]{12}$/);
  assert.equal(job.developerDeploymentPlan.plan.planSource, "developer-chat");
  assert.equal(job.followup.actions.length, 1);
  assert.equal(job.followup.actions[0].tool, "controller");
  assert.equal(job.followup.actions[0].status, "open");
  assert.equal(job.followup.actions[0].runnable, true);
  assert.equal(job.followup.status, undefined);
  assert.equal(job.developerDeploymentPlan.status, "proposed");
  assert.equal(job.reportState.status, "awaiting-testing");
  assert.equal(job.developerEvidence[0].provenance, "developer-chat");
  assert.equal(job.developerEvidence[0].fieldProvenance[0].provenance, "developer-chat");
  assert.equal(job.developerEvidence[0].fieldProvenance.at(-1).provenance, "server-zero-default");

  await __test.refreshDeploymentFixturePlan(job, { id: "OP-DEPLOY", kind: "anvil-deployment" }, Date.now() + 5_000, () => false);
  assert.equal(job.developerDeploymentPlan.status, "approved");
  assert.equal(job.aiDeploymentPlan.planSource, "developer-chat");
  assert.equal(job.aiDeploymentPlan.targetContract, "SimpleToken");
  assert.equal(job.aiDeploymentPlan.constructorArguments[2].value, "1000000");
  assert.match(job.worklog.at(-1).message, /Using developer-provided disposable deployment fixture/);
});

test("chat-supplied audit context creates an automatic evidence re-review action", async () => {
  const job = {
    sourceHash: "source-hash", runAnvil: false, evidenceRevision: 3,
    verificationQuestions: [{ id: "Q-OWNER" }], developerEvidence: [], developerDeploymentPlan: null,
    evidenceReview: { questionResults: [] }, operationLoop: { status: "needs-input", stopReason: "Role trust is unknown" }, followup: { actions: [] },
    reportState: { status: "awaiting-testing" }, reportMarkdown: null, worklog: [], updatedAt: "",
  };
  const result = await __test.applyCopilotDeveloperInputs(job, {
    deploymentPlanCandidates: [],
    developerContextCandidates: [{ category: "trusted-role", statement: "The owner is trusted to change fees", relatedQuestionIds: ["Q-OWNER"] }],
  }, { id: "MSG-CONTEXT", text: "The owner is trusted to change fees" });
  assert.equal(result.status, "accepted");
  assert.equal(job.evidenceRevision, 4);
  assert.equal(job.developerEvidence[0].relatedQuestionIds[0], "Q-OWNER");
  assert.equal(job.followup.actions[0].tool, "developer-context");
  assert.equal(job.followup.actions[0].runnable, true);
  assert.equal(job.followup.actions[0].acceptedDeveloperEvidence, true);
  assert.match(result.summary, /being applied/i);
});

test("a question about intent is not converted into developer evidence", async () => {
  const job = {
    sourceHash: "source-hash", runAnvil: false, evidenceRevision: 1,
    verificationQuestions: [{ id: "Q-OWNER" }], developerEvidence: [], developerDeploymentPlan: null,
    evidenceReview: { questionResults: [] }, operationLoop: { status: "needs-input" }, followup: { actions: [] },
    reportState: { status: "awaiting-testing" }, reportMarkdown: null, worklog: [], updatedAt: "",
  };
  const result = await __test.applyCopilotDeveloperInputs(job, {
    deploymentPlanCandidates: [],
    developerContextCandidates: [{ category: "trusted-role", statement: "owner is trusted", relatedQuestionIds: ["Q-OWNER"] }],
  }, { id: "MSG-Q", text: "Is it true that owner is trusted?" });
  assert.equal(result.status, "rejected");
  assert.equal(job.developerEvidence.length, 0);
  assert.equal(job.evidenceRevision, 1);
  assert.match(result.summary, /question or hypothetical/i);
});
