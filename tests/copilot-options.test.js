import test from "node:test";
import assert from "node:assert/strict";
import { deriveCopilotOptions } from "../src/web/copilot-options.js";

function lastRunShape() {
  return {
    status: "partial",
    evidenceRevision: 2,
    reportState: { status: "awaiting-testing" },
    auditSynthesis: { status: "completed", answer: "No blocker found in the completed targeted scope." },
    testCampaign: { passed: 12, invalid: 1 },
    verificationResults: [
      { id: "Q-ACCOUNT", status: "not-verified", question: "Do transfers conserve supply?", answer: "Source and existing tests support conservation.", nextCheck: { tool: "forge", objective: "Run an exact transfer-conservation property", reason: "Runtime proof is required" } },
      { id: "Q-EVENT", status: "not-verified", question: "Are transfer events exact?", answer: "Receipt logs were not checked.", nextCheck: { tool: "forge", objective: "Assert event topics and values", reason: "Receipt evidence is missing" } },
      { id: "Q-COMPAT", status: "not-verified", question: "Does the compiler range work?", answer: "Only Solidity 0.8.28 was compiled.", nextCheck: { tool: "compiler-matrix", objective: "Compile supported versions", reason: "Other versions were not run" } },
      { id: "Q-APPROVE", status: "developer-decision", question: "Is allowance overwrite intended?", answer: "The source implements conventional overwrite behavior.", nextCheck: { tool: "none" } },
    ],
    followup: { status: "idle", actions: [
      { id: "A-CONTROLLER", questionIds: ["Q-ACCOUNT", "Q-EVENT"], evidenceRevision: 2, tool: "controller", runnable: true, status: "open" },
    ] },
  };
}

test("bottom audit controls expose one AI-led campaign instead of per-question actions", () => {
  const view = deriveCopilotOptions(lastRunShape());
  assert.equal(view.visible, true);
  assert.equal(view.verdictTitle, "AI auditor opinion available");
  assert.match(view.verdictSummary, /AI auditor authored/i);
  assert.doesNotMatch(view.summary, /supported properties|failed contract properties|recommended stronger checks/i);
  assert.deepEqual(view.items.map((item) => item.kind), ["campaign", "finish"]);
  assert.equal(view.items[0].actionId, "A-CONTROLLER");
  assert.equal(view.items[0].title, "Continue testing");
  assert.equal(view.items.at(-1).kind, "finish");
});

test("information-needed detail includes a concrete Anvil blocker", () => {
  const view = deriveCopilotOptions({
    ...lastRunShape(),
    reportState: { status: "awaiting-input", reason: "Constructor argument owner address is required" },
    operationLoop: { status: "needs-input", stopReason: "Constructor argument owner address is required", decisions: [{ status: "needs-input", requestedInput: "Constructor argument owner address is required" }] },
    anvil: { status: "needs-input", inputRequired: true, reason: "Constructor argument owner address is required" },
  });
  const feedback = view.items.find((item) => item.kind === "feedback");
  assert.match(feedback.detail, /Constructor argument owner address is required/);
  assert.equal(feedback.focusDialogue, true);
});

test("internal Anvil artifact failures never ask the developer for information", () => {
  const job = lastRunShape();
  job.verificationResults = job.verificationResults.filter((item) => item.status !== "developer-decision");
  job.reportState = { status: "ready" };
  job.anvil = { status: "needs-input", reason: "Foundry produced no concrete, fully linked Target.sol deployment artifacts" };
  const view = deriveCopilotOptions(job);
  assert.equal(view.items.some((item) => item.kind === "feedback"), false);
});

test("Anvil input state cannot bypass the controller's explicit terminal request gate", () => {
  const job = lastRunShape();
  job.reportState = { status: "ready" };
  job.followup.actions = [];
  job.operationLoop = { status: "completed", stopReason: "Audit concluded with the deployment limitation recorded", decisions: [{ status: "conclude", requestedInput: "" }] };
  job.anvil = { status: "needs-input", inputRequired: true, reason: "Constructor argument owner address is required" };
  const view = deriveCopilotOptions(job);
  assert.equal(view.items.some((item) => item.kind === "feedback"), false);
});

test("developer-decision evidence never manufactures an information request", () => {
  const job = lastRunShape();
  job.reportState = { status: "ready" };
  job.followup.actions = [];
  const view = deriveCopilotOptions(job);
  assert.equal(view.items.some((item) => item.kind === "feedback"), false);
});

test("next-action cards stay hidden while the autonomous audit is still running", () => {
  const job = lastRunShape();
  job.status = "running";
  job.reportState = { status: "waiting-for-audit" };
  assert.equal(deriveCopilotOptions(job).visible, false);
});

test("campaign controls collapse to one running state", () => {
  const job = lastRunShape();
  job.followup.actions[0].status = "running";
  job.followup.status = "running";
  job.followup.active = { id: "OP-1" };
  let view = deriveCopilotOptions(job);
  assert.equal(view.items.find((item) => item.kind === "campaign").stateLabel, "AI-led testing is active");
  assert.equal(view.items.find((item) => item.kind === "campaign").actionId, null);
  assert.equal(view.items.find((item) => item.kind === "campaign").cancelOperationId, "OP-1");

  job.followup.actions[0].status = "consumed";
  job.followup.status = "idle";
  view = deriveCopilotOptions(job);
  assert.equal(view.items.some((item) => item.kind === "campaign"), false);
  assert.equal(view.items.at(-1).kind, "finish");
});

test("recommended campaigns are presented as a direct run choice", () => {
  const job = lastRunShape();
  job.followup.actions[0].recommendedCampaign = true;
  const campaign = deriveCopilotOptions(job).items.find((item) => item.kind === "campaign");
  assert.equal(campaign.title, "Run recommended tests");
  assert.equal(campaign.stateLabel, "AI selects the pertinent checks");
  assert.match(campaign.detail, /generate and validate the Foundry tests/i);
});
