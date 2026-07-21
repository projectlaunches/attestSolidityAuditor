import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { createAudit, getJob, initializeAuditPersistence } from "../src/server/audit.js";

const source = [
  "pragma solidity ^0.8.20;",
  "contract Vault {",
  "  function withdraw(address payable recipient) external { recipient.transfer(address(this).balance); }",
  "}",
].join("\n");

function profile(overrides = {}) {
  return {
    contractProfile: { archetypes: ["custom-contract"], trustedRoles: [], assets: ["native currency"], externalDependencies: [], intendedBehaviors: [], assumptions: [] },
    contractSummary: "A small native-currency vault.",
    threatModel: "Untrusted callers must not be able to redirect the balance.",
    sourceConclusions: [],
    sourceFindings: [],
    deploymentPlan: { decision: "skip", decisionReason: "unsupported", environment: "fresh-anvil", targetContract: "Vault", constructorArguments: [], transactionValueWei: "0", rationale: "No deployment needed for this source-only check", limitations: [] },
    verificationQuestions: [],
    limitations: [],
    ...overrides,
  };
}

function fixtureCodex(profileResult, decision = { status: "conclude", assessment: "The selected-scope opinion is supported.", operations: [], coverageUpdates: [], requestedInput: "" }) {
  return {
    profile: async () => structuredClone(profileResult),
    planAuditOperations: async () => structuredClone(decision),
    cancelActiveReview: async () => {},
  };
}

function capabilities() {
  return { codex: { available: true, version: "test" }, analyzers: [] };
}

async function waitFor(id, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = getJob(id);
    if (job && predicate(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Audit ${id} did not reach the expected state`);
}

test("AI review surfaces an exact-cited source blocker without requiring an analyzer", async (context) => {
  const projectRoot = await mkdtemp(path.join("/tmp", "attest-lifecycle-review-"));
  context.after(() => rm(projectRoot, { recursive: true, force: true }));
  const sourceFinding = {
    id: "SF-UNRESTRICTED-WITHDRAW",
    title: "Any caller can drain the vault",
    summary: "The external withdrawal sends the entire balance to a caller-selected recipient.",
    category: "authorization",
    classification: "vulnerability",
    severity: "high",
    confidence: "high",
    rationale: "No modifier or caller check protects the external function.",
    impact: "Any caller can redirect all native currency held by the contract.",
    trigger: "An arbitrary account calls withdraw with its chosen recipient.",
    action: "Restrict withdrawal authority and retest the authorization boundary.",
    evidence: [{ lineStart: 3, lineEnd: 3, quote: "function withdraw(address payable recipient) external { recipient.transfer(address(this).balance); }", why: "The callable function has no access check." }],
    relatedQuestionIds: [],
  };
  const opinion = "Do not deploy this contract with funds. High severity: any caller can drain the vault through the unrestricted withdraw function.";
  const created = createAudit({ projectRoot, capabilities: capabilities(), codex: fixtureCodex(profile({ sourceFindings: [sourceFinding] }), { status: "conclude", assessment: opinion, operations: [], coverageUpdates: [], requestedInput: "" }), source, fileName: "Vault.sol", auditDepth: "review" });
  const job = await waitFor(created.id, (item) => item.reportState?.status === "ready");
  assert.equal(job.status, "completed");
  assert.equal(job.findings.length, 1);
  assert.equal(job.findings[0].id, sourceFinding.id);
  assert.equal(job.auditSynthesis.answer, opinion);
  assert.equal("releaseDecision" in job, false);
  assert.match(job.reportMarkdown, /Any caller can drain the vault/);
  assert.match(job.reportMarkdown, /Restrict withdrawal authority/);
});

test("targeted mode concludes from source and leaves optional assurance non-blocking", async (context) => {
  const projectRoot = await mkdtemp(path.join("/tmp", "attest-lifecycle-optional-"));
  context.after(() => rm(projectRoot, { recursive: true, force: true }));
  const safeSource = "pragma solidity ^0.8.20;\ncontract Counter { uint256 public value; function increment() external { value += 1; } }\n";
  const question = {
    id: "Q-OPTIONAL-RUNTIME",
    question: "Does a disposable runtime call increment value by one?",
    rationale: "Runtime evidence would add assurance but cannot change the visible source behavior.",
    priority: "low",
    category: "state-transition",
    expectedEvidence: "A Foundry call on a disposable fixture",
    materiality: "optional-assurance",
    requiredEvidenceKinds: ["source", "foundry"],
    sufficientEvidenceRoutes: [["source", "foundry"]],
  };
  const conclusion = {
    id: "SC-WITHDRAW-FLOW",
    statement: "increment adds one to value.",
    category: "state-transition",
    classification: "neutral-fact",
    severity: "info",
    confidence: "high",
    rationale: "The function body contains the direct state update.",
    evidence: [{ lineStart: 2, lineEnd: 2, quote: "value += 1", why: "Direct state update." }],
    relatedQuestionIds: [],
  };
  const created = createAudit({ projectRoot, capabilities: capabilities(), codex: fixtureCodex(profile({ sourceConclusions: [conclusion], verificationQuestions: [question] })), source: safeSource, fileName: "Counter.sol", auditDepth: "targeted" });
  const job = await waitFor(created.id, (item) => item.reportState?.status === "ready");
  assert.equal(job.status, "completed");
  assert.equal(job.toolRuns.length, 0);
  assert.equal(job.auditSynthesis.answer, "The selected-scope opinion is supported.");
  assert.equal("releaseDecision" in job, false);
  assert.equal(job.reportState.status, "ready");
});

test("targeted mode pauses for a genuinely opinion-critical unanswered question", async (context) => {
  const projectRoot = await mkdtemp(path.join("/tmp", "attest-lifecycle-required-"));
  context.after(() => rm(projectRoot, { recursive: true, force: true }));
  const question = {
    id: "Q-REQUIRED-AUTH",
    question: "Can an untrusted caller withdraw all funds?",
    rationale: "The answer determines immediate funds safety.",
    priority: "critical",
    category: "authorization",
    expectedEvidence: "A source trace plus an adversarial Foundry property",
    materiality: "required-for-opinion",
    requiredEvidenceKinds: ["source", "foundry"],
    sufficientEvidenceRoutes: [["source", "foundry"]],
  };
  const decision = { status: "needs-input", assessment: "The required execution route is unavailable.", operations: [], coverageUpdates: [], requestedInput: "Enable a supported local execution route or explicitly close with this limitation." };
  const created = createAudit({ projectRoot, capabilities: capabilities(), codex: fixtureCodex(profile({ verificationQuestions: [question] }), decision), source, fileName: "Vault.sol", auditDepth: "targeted" });
  const job = await waitFor(created.id, (item) => item.status === "partial" && item.reportState?.status === "awaiting-input");
  assert.equal(job.reportMarkdown, null);
  assert.equal(job.auditSynthesis.answer, null);
  assert.match(job.reportState.reason, /Enable a supported local execution route/);
});

test("final job state and report revision are durably committed", async (context) => {
  const projectRoot = await mkdtemp(path.join("/tmp", "attest-lifecycle-persist-"));
  context.after(() => rm(projectRoot, { recursive: true, force: true }));
  const caps = capabilities();
  await initializeAuditPersistence({ projectRoot, capabilities: caps, codex: fixtureCodex(profile()) });
  const created = createAudit({ projectRoot, capabilities: caps, codex: fixtureCodex(profile()), source, fileName: "Vault.sol", auditDepth: "review" });
  const job = await waitFor(created.id, (item) => item.reportState?.status === "ready");
  const root = path.join(projectRoot, "work", "jobs", job.id);
  const state = JSON.parse(await readFile(path.join(root, "state.json"), "utf8"));
  const manifest = JSON.parse(await readFile(path.join(root, "reports", "manifest.json"), "utf8"));
  assert.equal(state.reportState.status, "ready");
  assert.equal(manifest.currentRevision, 1);
  assert.equal(manifest.revisions[0].evidenceRevision, job.evidenceRevision);
  assert.match(await readFile(path.join(root, "reports", "revisions", "000001", "findings.md"), "utf8"), /Attest audit/);
});

test("AI profile failure terminates every downstream stage with an actionable cause", async (context) => {
  const projectRoot = await mkdtemp(path.join("/tmp", "attest-lifecycle-profile-failure-"));
  context.after(() => rm(projectRoot, { recursive: true, force: true }));
  const codex = fixtureCodex(profile());
  codex.profile = async () => { throw new Error("invalid_json_schema: requiredForOpinion is missing from required"); };
  const created = createAudit({ projectRoot, capabilities: capabilities(), codex, source, fileName: "Vault.sol", auditDepth: "targeted" });
  const job = await waitFor(created.id, (item) => item.status === "failed");
  assert.equal(job.reportState.status, "failed");
  assert.equal(job.stages.find((item) => item.id === "ai-profile").status, "failed");
  assert.equal(job.stages.find((item) => item.id === "operation-loop").status, "skipped");
  assert.equal(job.stages.find((item) => item.id === "evidence-review").status, "skipped");
  assert.equal(job.stages.find((item) => item.id === "report").status, "failed");
  assert.equal(job.stages.every((item) => ["completed", "failed", "skipped", "timed-out"].includes(item.status)), true);
  assert.equal(job.operationLoop.status, "skipped");
  assert.match(job.operationLoop.stopReason, /requiredForOpinion/);
  assert.equal(job.evidenceReview.status, "skipped");
  assert.doesNotMatch(job.stages.find((item) => item.id === "ai-profile").message, /will retry/i);
  assert.match(job.reportState.reason, /requiredForOpinion/);
});

test("the shipped SmokeCounter target completes the AI-led targeted workflow", async (context) => {
  const projectRoot = await mkdtemp(path.join("/tmp", "attest-lifecycle-smoke-counter-"));
  context.after(() => rm(projectRoot, { recursive: true, force: true }));
  const smokeSource = await readFile(new URL("../samples/SmokeCounter.sol", import.meta.url), "utf8");
  const conclusion = {
    id: "SC-INCREMENT",
    statement: "Each successful increment call increases value by exactly one.",
    category: "state-transition",
    classification: "neutral-fact",
    severity: "info",
    confidence: "high",
    rationale: "The only state-changing statement adds one to value.",
    evidence: [{ lineStart: 8, lineEnd: 8, quote: "value += 1;", why: "This is the complete increment state transition." }],
    relatedQuestionIds: [],
  };
  const smokeProfile = profile({
    contractProfile: { archetypes: ["custom-contract"], trustedRoles: [], assets: [], externalDependencies: [], intendedBehaviors: ["increment a counter"], assumptions: [] },
    contractSummary: "A constructor-free counter with one state-changing function.",
    threatModel: "No funds, roles, or external calls are present.",
    sourceConclusions: [conclusion],
    deploymentPlan: { decision: "deploy", decisionReason: "deploy-ready", environment: "fresh-anvil", targetContract: "SmokeCounter", constructorArguments: [], transactionValueWei: "0", rationale: "The target has no constructor inputs", limitations: [] },
  });
  const created = createAudit({ projectRoot, capabilities: capabilities(), codex: fixtureCodex(smokeProfile), source: smokeSource, fileName: "SmokeCounter.sol", auditDepth: "targeted" });
  const job = await waitFor(created.id, (item) => item.reportState?.status === "ready");
  assert.equal(job.status, "completed");
  assert.equal(job.sourceConclusions.length, 1);
  assert.equal(job.findings.length, 0);
  assert.equal(job.reportState.status, "ready");
  assert.equal(job.stages.every((item) => ["completed", "failed", "skipped", "timed-out"].includes(item.status)), true);
  assert.match(job.reportMarkdown, /SmokeCounter/);
});
