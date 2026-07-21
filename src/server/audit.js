import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "./command.js";
import { normalizeSlitherOutput } from "./adapters/slither.js";
import { normalizeAderynReport } from "./adapters/aderyn.js";
import { normalizeSolhintOutput } from "./adapters/solhint.js";
import { effectiveTestPlans } from "./test-plan-state.js";
import { renderFindingsMarkdown } from "./findings-report.js";
import { buildBaselineSuite, profileContract } from "./planner.js";
import { normalizeTestCampaign, resolveTestCampaign } from "./campaign.js";
import { inspectDeploymentArtifacts, runFreshAnvilDeployment, selectDeployableArtifact, validateDeveloperDeploymentPlan } from "./anvil.js";
import { buildReviewPresentation } from "./review-presentation.js";
import { assertCopilotQuestionSafe, normalizeCopilotQuestion, validateCopilotResult } from "./copilot.js";
import { applyEvidenceReview, defaultNextCheckForQuestion, markEvidenceReviewUnavailable } from "./evidence-review.js";
import { resolveForkNetwork, verifyForkNetwork, verifyPinnedForkBlock } from "./fork-networks.js";
import {
  AUDIT_CONTROLLER_VERSION,
  controllerCapabilityCatalog,
  fullCoverageObligations,
  normalizeAuditDepth,
  normalizeControllerDecision,
  operationEvidenceRecord,
} from "./audit-operations.js";
import { createJobStore } from "./job-store.js";

const MAX_SOURCE_BYTES = 250_000;
const MAX_RETAINED_JOBS = 100;
const MAX_JOB_STORE_BYTES = 2_000_000_000;
const ATTEST_TEST_SUPPORT = `// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

interface AttestVm {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function expectEmit(bool, bool, bool, bool) external;
    function warp(uint256) external;
    function roll(uint256) external;
    function deal(address, uint256) external;
    function assume(bool) external;
}

abstract contract AttestTest {
    AttestVm private constant ATTEST_VM = AttestVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    function _prank(address actor) internal { ATTEST_VM.prank(actor); }
    function _startPrank(address actor) internal { ATTEST_VM.startPrank(actor); }
    function _stopPrank() internal { ATTEST_VM.stopPrank(); }
    function _expectRevert() internal { ATTEST_VM.expectRevert(); }
    function _expectRevert(bytes4 selector) internal { ATTEST_VM.expectRevert(selector); }
    function _expectRevert(bytes memory data) internal { ATTEST_VM.expectRevert(data); }
    function _expectEmit(bool topic1, bool topic2, bool topic3, bool data) internal { ATTEST_VM.expectEmit(topic1, topic2, topic3, data); }
    function _warp(uint256 timestamp) internal { ATTEST_VM.warp(timestamp); }
    function _roll(uint256 blockNumber) internal { ATTEST_VM.roll(blockNumber); }
    function _deal(address actor, uint256 amount) internal { ATTEST_VM.deal(actor, amount); }
    function _assume(bool condition) internal { ATTEST_VM.assume(condition); }
}
`;
const jobs = new Map();
const auditQueue = [];
let activeAudits = 0;
let jobStore = null;

function now() { return new Date().toISOString(); }

async function runWithAiRetry(job, label, operation, attempts = 2) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    throwIfCancelled(job);
    try {
      return await operation(attempt);
    } catch (error) {
      if (job.cancelRequested) throw cancelledError("Audit cancelled by user");
      if (["AUDIT_CANCELLED", "FOLLOWUP_CANCELLED"].includes(error?.code)) throw error;
      lastError = error;
      if (attempt >= attempts || !isRetryableAiFailure(error)) break;
      addEvent(job, "ai", "retrying", `${label} was interrupted; retrying once with completed progress preserved`, { attempt, error: String(error.message || error).slice(0, 500) });
    }
  }
  throw lastError;
}

function isRetryableAiFailure(error) {
  return /\b(?:timeout|timed out|temporar|connection|closed|reset|unavailable|rate limit|429|502|503|504|internal server|econn)\b/i.test(String(error?.message || error || ""));
}

function addEvent(job, stage, status, message, details = null) {
  job.worklog.push({ id: randomUUID(), at: now(), stage, status, message, details });
  job.updatedAt = now();
  schedulePersist(job);
}

export async function initializeAuditPersistence({ projectRoot, capabilities, codex }) {
  jobStore = createJobStore({ root: path.join(projectRoot, "work", "jobs") });
  await jobStore.cleanupTempFiles();
  await jobStore.prune({ maxJobs: MAX_RETAINED_JOBS, maxBytes: MAX_JOB_STORE_BYTES });
  const restored = (await jobStore.listStates()).sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  for (const state of restored.slice(-MAX_RETAINED_JOBS)) {
    if (!state?.id || jobs.has(state.id)) continue;
    let recoveredState = state;
    const manifest = await jobStore.readReportManifest(state.id);
    if (Number.isSafeInteger(manifest?.currentRevision)) {
      const committedState = await jobStore.loadCommittedReportState(state.id, manifest.currentRevision);
      const checkpointRevision = Math.max(0, ...(state.reportRevisions || []).map((item) => Number(item.revision) || 0));
      if (committedState?.id === state.id && (manifest.currentRevision > checkpointRevision || (state.reportState?.status === "ready" && !state.reportMarkdown))) {
        recoveredState = committedState;
      }
    }
    const job = { ...recoveredState, projectRoot, jobDir: path.join(projectRoot, "work", "jobs", state.id), capabilities, codex };
    normalizeRestoredJob(job);
    jobs.set(job.id, job);
    if (recoveredState !== state) await jobStore.saveState(job.id, durableJobSnapshot(job));
  }
  return jobs.size;
}

export async function prepareAuditShutdown() {
  for (const job of jobs.values()) {
    const auditActive = ["queued", "running", "cancelling"].includes(job.status);
    const followupActive = ["queued", "running"].includes(job.followup?.status);
    const copilotActive = job.copilot?.status === "running";
    if (!auditActive && !followupActive && !copilotActive) continue;
    if (auditActive || followupActive) job.cancelRequested = true;
    if (auditActive) job.status = "cancelling";
    addEvent(job, "recovery", "checkpoint", "Local service is stopping; current evidence was checkpointed for truthful restart recovery");
  }
  await jobStore?.flush?.();
}

function normalizeRestoredJob(job) {
  job.sourceFindings ||= [];
  job.worklog ||= [];
  job.reportRevisions ||= [];
  job.followup ||= { status: "idle", active: null, history: [], actions: [], defaultNetwork: "ethereum" };
  job.followup.actions ||= [];
  job.followup.history ||= [];
  job.followup.status ||= "idle";
  const priorRecommendedActions = job.followup.actions.filter((item) => item.recommendedCampaign);
  if (priorRecommendedActions.some((item) => item.status === "consumed")) job.followup.recommendedCampaignConsumed = true;
  if (!Number.isInteger(job.followup.recommendedCampaignOfferedRevision)) {
    const latestPriorRevision = Math.max(0, ...priorRecommendedActions.map((item) => Number(item.evidenceRevision) || 0));
    if (latestPriorRevision) job.followup.recommendedCampaignOfferedRevision = latestPriorRevision;
    else if (job.followup.recommendedCampaignOffered) job.followup.recommendedCampaignOfferedRevision = job.evidenceRevision;
  }
  const interruptedAudit = ["queued", "running", "cancelling"].includes(job.status);
  const interruptedFollowup = ["queued", "running"].includes(job.followup?.status)
    || ["queued", "running"].includes(job.followup?.active?.status);
  if (interruptedAudit) {
    job.status = job.aiProfile?.status === "completed" ? "partial" : "failed";
    job.cancelRequested = false;
    job.operationLoop ||= {};
    job.operationLoop.status = "blocked";
    job.operationLoop.stopReason = "The local service restarted during this audit; preserved evidence is available, but the interrupted operation was not silently replayed";
    job.reportState = { status: "interrupted", reason: job.operationLoop.stopReason, finalizedAt: null, finalizedBy: null, retryable: false };
    job.worklog.push({ id: randomUUID(), at: now(), stage: "recovery", status: "interrupted", message: job.operationLoop.stopReason, details: null });
  }
  if (interruptedFollowup) {
    const active = job.followup.active;
    if (active && ["queued", "running"].includes(active.status)) {
      active.status = "cancelled";
      active.error = "The local service restarted during additional testing";
      active.finishedAt = now();
      const action = (job.followup.actions || []).find((item) => item.id === active.actionId);
      if (action && action.evidenceRevision === job.evidenceRevision) action.status = "open";
    }
    job.followup.status = "idle";
    job.followup.active = null;
    if (!interruptedAudit) {
      const reason = "The local service restarted during additional testing; preserved evidence remains available and the interrupted continuation can be run again";
      job.reportState = { status: "interrupted", reason, finalizedAt: null, finalizedBy: null, retryable: true };
      job.worklog.push({ id: randomUUID(), at: now(), stage: "recovery", status: "interrupted", message: reason, details: null });
    }
  }
  if (job.copilot?.status === "running") {
    const reason = "The local service restarted before the previous Audit Copilot answer completed. No audit evidence was changed; ask the question again if it is still needed.";
    job.copilot.status = "idle";
    job.copilot.error = reason;
    job.copilot.messages ||= [];
    job.copilot.messages.push({ id: randomUUID(), at: now(), role: "assistant", kind: "recovery", text: reason, citations: [], suggestedNextSteps: [] });
    job.worklog.push({ id: randomUUID(), at: now(), stage: "copilot", status: "interrupted", message: reason, details: null });
  }
  if (["completed", "partial"].includes(job.status) && job.operationLoop?.status === "completed") {
    ensureRecommendedTestingAction(job);
  }
}

function durableJobSnapshot(job) {
  const { codex: _codex, capabilities: _capabilities, ...state } = job;
  return JSON.parse(JSON.stringify({ persistenceVersion: 1, ...state }));
}

function schedulePersist(job) {
  // Report projections are deliberately detached from the canonical job.
  // Never let their intermediate state race into state.json.
  if (!jobStore || !job?.id || jobs.get(job.id) !== job) return;
  const snapshot = durableJobSnapshot(job);
  void jobStore.saveState(job.id, snapshot).catch((error) => {
    job.persistence = { status: "failed", error: String(error.message || error), at: now() };
  });
}

function stage(job, id, status, message) {
  const item = job.stages.find((entry) => entry.id === id);
  if (!item) return;
  item.status = status;
  item.message = message;
  if (status === "running") item.startedAt = now();
  if (["completed", "failed", "skipped", "timed-out"].includes(status)) item.finishedAt = now();
  addEvent(job, id, status, message);
}

function sourceHash(source) {
  return createHash("sha256").update(source).digest("hex");
}

function safeName(name) {
  const base = path.basename(name || "Target.sol");
  return /^[A-Za-z0-9_.-]+\.sol$/.test(base) ? base : "Target.sol";
}

function publicJob(job, { includeSource = false } = {}) {
  const presentation = buildReviewPresentation(job);
  return {
    id: job.id,
    fileName: job.fileName,
    ...(includeSource ? { source: job.source } : {}),
    sourceHash: job.sourceHash,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    stages: job.stages,
    worklog: job.worklog,
    toolRuns: job.toolRuns,
    findings: presentation.findings,
    reviewTouchpoints: presentation.touchpoints,
    reviewSummary: presentation.reviewSummary,
    coverageObligations: presentation.coverageObligations,
    verificationResults: presentation.verificationResults,
    verificationSummary: presentation.verificationSummary,
    qualityFindings: job.qualityFindings,
    declaredContext: job.declaredContext,
    auditDepth: job.auditDepth,
    executionPermissions: job.executionPermissions,
    operationLoop: job.operationLoop,
    contractProfile: job.contractProfile,
    suitePlan: job.suitePlan,
    aiContractProfile: job.aiContractProfile,
    sourceConclusions: job.sourceConclusions,
    sourceFindings: job.sourceFindings,
    aiProfile: job.aiProfile,
    aiSuitePlan: job.aiSuitePlan,
    aiDeploymentPlan: job.aiDeploymentPlan,
    developerDeploymentPlan: job.developerDeploymentPlan,
    developerEvidence: job.developerEvidence,
    verificationQuestions: job.verificationQuestions,
    evidenceReview: job.evidenceReview,
    deploymentArtifacts: job.deploymentArtifacts,
    compileSettings: job.compileSettings,
    compilerAvailability: job.compilerAvailability,
    testCampaign: job.testCampaign,
    anvil: job.anvil,
    ai: job.ai,
    auditSynthesis: job.auditSynthesis,
    copilot: job.copilot,
    limitations: job.limitations,
    reportMarkdown: job.reportMarkdown,
    reportState: job.reportState,
    sourceIntegrity: job.sourceIntegrity,
    evidenceRevision: job.evidenceRevision,
    reportRevisions: (job.reportRevisions || []).map(({ revision, evidenceRevision, at, trigger, operationId }) => ({ revision, evidenceRevision, at, trigger, operationId })),
    followup: job.followup,
  };
}

export function getJob(id) {
  const job = jobs.get(id);
  return job ? publicJob(job, { includeSource: true }) : null;
}

export function listJobs() {
  return [...jobs.values()].map(publicJob).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getReportRevision(id, revision) {
  const job = jobs.get(id);
  if (!job) return null;
  const item = (job.reportRevisions || []).find((entry) => entry.revision === revision);
  return item ? { revision: item.revision, markdown: item.markdown, snapshot: item.snapshot } : undefined;
}

export async function askAuditCopilot(id, { question } = {}) {
  const job = jobs.get(id);
  if (!job) return null;
  if (!["completed", "partial", "failed", "cancelled"].includes(job.status)) {
    throw copilotError("Audit Copilot questions become available after the audit run finishes", 409);
  }
  if (job.reportState?.status === "publishing") throw copilotError("Final findings are being committed; wait for publication to finish", 409);
  if (!job.codex || !job.capabilities.codex.available) throw copilotError("Codex app-server is unavailable", 503);
  if (["queued", "running"].includes(job.followup?.status)) throw copilotError("Wait for the active AI-controlled audit to finish before asking another question", 409);
  if (job.copilot.status === "running") throw copilotError("Audit Copilot is already answering a question", 409);
  const normalizedQuestion = normalizeCopilotQuestion(question);
  assertCopilotQuestionSafe(normalizedQuestion);
  if (isExplicitFollowupRunRequest(normalizedQuestion)) {
    let actions = currentFollowupActions(job);
    if (!actions.length) {
      ensureRecommendedTestingAction(job, { force: true });
      actions = currentFollowupActions(job);
    }
    if (actions.length !== 1) throw copilotError(actions.length ? "The audit continuation changed; refresh the audit before continuing" : "No runnable audit continuation is currently available", 409);
    job.copilot.messages.push({ id: randomUUID(), at: now(), role: "user", kind: "authorization", text: normalizedQuestion, actionId: actions[0].id, evidenceRevision: job.evidenceRevision });
    addEvent(job, "followup", "authorized", `Developer authorized the rendered ${actions[0].tool} action through Audit Copilot`);
    return await queueAuditFollowup(id, { actionId: actions[0].id, evidenceRevision: job.evidenceRevision, network: actions[0].networkId || job.followup.defaultNetwork });
  }
  const questionMessage = {
    id: randomUUID(),
    at: now(),
    role: "user",
    kind: "question",
    text: normalizedQuestion,
  };
  job.copilot.messages.push(questionMessage);
  job.copilot.status = "running";
  job.copilot.error = null;
  addEvent(job, "copilot", "running", "Developer follow-up submitted to Audit Copilot");
  try {
    const presentation = buildReviewPresentation(job);
    const result = await job.codex.discuss({
      operationKey: `${job.jobDir}:copilot:${questionMessage.id}`,
      jobDir: job.jobDir,
      source: job.source,
      sourceHash: job.sourceHash,
      question: normalizedQuestion,
      auditContext: {
        fileName: job.fileName,
        status: job.status,
        declaredContext: job.declaredContext,
        contractProfile: job.contractProfile,
        reviewSummary: presentation.reviewSummary,
        currentAuditOpinion: job.auditSynthesis?.answer || job.operationLoop?.stopReason || null,
        findings: job.findings.map((finding) => ({
          id: finding.id,
          title: finding.title,
          severity: finding.severity,
          verification: finding.verification,
          location: finding.location,
          aiReview: finding.aiReview,
        })),
        qualityDiagnostics: job.qualityFindings.length,
        toolRuns: job.toolRuns.map(({ tool, status, version, timedOut }) => ({ tool, status, version, timedOut })),
        suitePlan: job.suitePlan,
        testCampaign: job.testCampaign,
        deploymentArtifacts: job.deploymentArtifacts,
        aiDeploymentPlan: job.aiDeploymentPlan,
        developerDeploymentPlan: job.developerDeploymentPlan,
        anvil: job.anvil,
        sourceConclusions: job.sourceConclusions,
        verificationQuestions: job.verificationQuestions,
        verificationResults: job.evidenceReview?.questionResults || [],
        currentFollowupActions: currentFollowupActions(job).map(({ id, tool, objective, reason, networkId, evidenceRevision }) => ({ id, tool, objective, reason, networkId, evidenceRevision })),
        limitations: job.limitations,
      },
    });
    const validated = validateCopilotResult({
      source: job.source,
      findingIds: job.findings.map((finding) => finding.id),
    }, result);
    const developerInput = await applyCopilotDeveloperInputs(job, validated, questionMessage);
    const answerMessage = {
      id: randomUUID(),
      at: now(),
      role: "assistant",
      kind: "answer",
      text: validated.answer,
      citations: validated.citations,
      relatedFindingIds: validated.relatedFindingIds,
      suggestedNextSteps: validated.suggestedNextSteps,
      developerInput,
      action: developerInput?.action || null,
    };
    job.copilot.messages.push(answerMessage);
    job.copilot.status = "idle";
    addEvent(job, "copilot", "completed", developerInput?.status === "accepted"
      ? `Audit Copilot answered and recorded developer-provided evidence at revision ${job.evidenceRevision}`
      : `Audit Copilot answered with ${validated.citations.length} source-validated citation(s)`);
    if (developerInput?.status === "accepted" && developerInput.action?.id) {
      answerMessage.action = {
        kind: "authorized-followup",
        actionId: developerInput.action.id,
        evidenceRevision: developerInput.action.evidenceRevision,
        objective: developerInput.action.objective,
      };
      addEvent(job, "followup", "authorized", `Developer-provided evidence automatically authorized ${developerInput.action.tool === "developer-context" ? "evidence re-review" : "the continuing AI-controlled audit"}`);
      return await queueAuditFollowup(id, {
        actionId: developerInput.action.id,
        evidenceRevision: developerInput.action.evidenceRevision,
        network: developerInput.action.networkId || job.followup.defaultNetwork,
      });
    }
    if (validated.requestedAction === "run-current-continuation") {
      const actions = currentFollowupActions(job);
      if (actions.length !== 1) {
        addEvent(job, "followup", "not-authorized", actions.length
          ? "Audit Copilot identified a run request, but more than one server action was available; use the named action control"
          : "Audit Copilot identified a run request, but no current server-issued action was runnable");
        return publicJob(job);
      }
      answerMessage.action = {
        kind: "authorized-followup",
        actionId: actions[0].id,
        evidenceRevision: actions[0].evidenceRevision,
        objective: actions[0].objective,
      };
      addEvent(job, "followup", "authorized", `Developer authorized the server-issued ${actions[0].tool} action through Audit Copilot`);
      return await queueAuditFollowup(id, {
        actionId: actions[0].id,
        evidenceRevision: actions[0].evidenceRevision,
        network: actions[0].networkId || job.followup.defaultNetwork,
      });
    }
    return publicJob(job);
  } catch (error) {
    job.copilot.status = "failed";
    job.copilot.error = error.message;
    addEvent(job, "copilot", "failed", `Audit Copilot did not complete: ${error.message}`);
    throw copilotError(error.message, error.statusCode || 502);
  }
}

async function applyCopilotDeveloperInputs(job, validated, questionMessage) {
  const knownQuestionIds = new Set((job.verificationQuestions || []).map((item) => item.id));
  const accepted = [];
  const rejected = [];
  for (const candidate of validated.developerContextCandidates || []) {
    const statement = String(candidate.statement || "").trim();
    if (!statement || !questionMessage.text.toLowerCase().includes(statement.toLowerCase())) {
      rejected.push("A proposed context statement was not recorded because it was not stated verbatim by the developer");
      continue;
    }
    if (isQuestionOnlyContext(questionMessage.text)) {
      rejected.push("A question or hypothetical was not recorded as developer intent; state the intended behavior or trusted-role assumption directly");
      continue;
    }
    const relatedQuestionIds = [...new Set((candidate.relatedQuestionIds || []).filter((id) => knownQuestionIds.has(id)))];
    const digest = sourceHash(JSON.stringify([job.sourceHash, candidate.category, statement, relatedQuestionIds]));
    if (job.developerEvidence.some((item) => item.digest === digest)) continue;
    const record = {
      id: randomUUID(), at: now(), sourceMessageId: questionMessage.id, evidenceRevision: job.evidenceRevision + 1,
      kind: "audit-context", category: candidate.category, statement, relatedQuestionIds,
      provenance: "developer-chat", validation: "accepted", digest,
    };
    job.developerEvidence.push(record);
    accepted.push(record);
  }

  let generatedAction = null;
  const deploymentCandidate = validated.deploymentPlanCandidates?.[0];
  if (deploymentCandidate) {
    try {
      if (!job.runAnvil) throw copilotError("Fresh Anvil was not selected for this audit; the values were not turned into an executable plan", 422);
      if (["publishing", "ready"].includes(job.reportState?.status)) throw copilotError("Testing is already closed; start a new audit to use different deployment inputs", 409);
      assertDeploymentCandidateSupportedByMessage(questionMessage.text, deploymentCandidate.deploymentPlan);
      const checked = await validateDeveloperDeploymentPlan(job.jobDir, deploymentCandidate.deploymentPlan);
      const planPayload = {
        sourceHash: job.sourceHash,
        artifactSha256: checked.artifactSha256,
        targetContract: checked.contract,
        evidenceRevision: job.evidenceRevision + 1,
        plan: checked.plan,
      };
      const planId = `PLAN-${sourceHash(JSON.stringify(planPayload)).slice(0, 12).toUpperCase()}`;
      const digest = sourceHash(JSON.stringify([questionMessage.id, planPayload]));
      const unresolved = new Set(unresolvedControllerQuestionIds(job));
      let deploymentQuestionIds = (job.verificationQuestions || [])
        .filter((item) => unresolved.has(item.id))
        .filter((item) => (item.requiredEvidenceKinds || []).some((kind) => ["anvil-deployment", "anvil-observation", "anvil-scenario"].includes(kind)))
        .map((item) => item.id);
      if (!deploymentQuestionIds.length && job.operationLoop?.status === "needs-input" && /\b(?:anvil|deploy|constructor|fixture)\b/i.test(job.operationLoop?.stopReason || "")) {
        deploymentQuestionIds = [...unresolved];
      }
      if (!deploymentQuestionIds.length) {
        const questionId = `Q-DEPLOYMENT-${planId.slice(-12)}`;
        const question = {
          id: questionId,
          question: `Does validated disposable fixture ${planId} successfully deploy the compiled target and produce matching runtime bytecode?`,
          rationale: "The developer supplied the previously missing local fixture values and explicitly continued testing.",
          expectedEvidence: "A successful fresh-Anvil deployment receipt plus deployed bytecode bound to the compiled artifact",
          priority: "medium",
          category: "deployment",
          materiality: job.auditDepth === "full" ? "required-for-opinion" : "optional-assurance",
          requiredEvidenceKinds: ["anvil-deployment"],
          sufficientEvidenceRoutes: [["anvil-deployment"]],
        };
        job.verificationQuestions = mergeStableVerificationQuestions(job.verificationQuestions, [question]);
        if (job.ai?.result) job.ai.result.verificationQuestions = structuredClone(job.verificationQuestions);
        deploymentQuestionIds = [questionId];
      }
      const record = {
        id: randomUUID(), at: now(), sourceMessageId: questionMessage.id, evidenceRevision: job.evidenceRevision + 1,
        kind: "deployment-configuration", relatedQuestionIds: deploymentQuestionIds, provenance: "developer-chat",
        validation: "accepted", digest, planId, sourceHash: job.sourceHash, artifactSha256: checked.artifactSha256,
        summary: String(deploymentCandidate.summary || `Local fixture for ${checked.contract}`).trim(),
        explicitlyProvidedFields: (deploymentCandidate.explicitlyProvidedFields || []).slice(0, 66),
        fieldProvenance: [
          ...checked.plan.constructorArguments.map((arg) => ({ field: `constructorArguments[${arg.position}]`, name: arg.name, provenance: "developer-chat" })),
          { field: "transactionValueWei", name: "transactionValueWei", provenance: checked.plan.transactionValueWei === "0" && !/(?:deployment\s+value|msg\.value|transaction\s+value)[^\n]{0,40}\b0\b|\b0\s*wei\b/i.test(questionMessage.text) ? "server-zero-default" : "developer-chat" },
        ],
        normalizedPlan: checked.plan,
      };
      job.developerEvidence.push(record);
      accepted.push(record);
      job.developerDeploymentPlan = { id: planId, status: "proposed", createdAt: record.at, sourceMessageId: questionMessage.id, sourceHash: job.sourceHash, artifactSha256: checked.artifactSha256, plan: checked.plan };
      job.anvil = { requested: true, status: "ready", reason: `Developer-provided local fixture ${planId} passed compiled-ABI validation`, planId };
    } catch (error) {
      rejected.push(error.message);
    }
  }

  if (!accepted.length) {
    return rejected.length ? { status: "rejected", summary: rejected.join(" "), rejected } : null;
  }

  job.evidenceRevision += 1;
  for (const item of job.followup.actions) if (item.status === "open") item.status = "stale";
  const relatedQuestionIds = [...new Set(accepted.flatMap((item) => item.relatedQuestionIds || []))];
  const deploymentAccepted = job.developerDeploymentPlan?.sourceMessageId === questionMessage.id;
  const questionById = new Map((job.verificationQuestions || []).map((item) => [item.id, item]));
  generatedAction = {
    id: randomUUID(), evidenceRevision: job.evidenceRevision, questionId: relatedQuestionIds.length === 1 ? relatedQuestionIds[0] : null,
    questionIds: relatedQuestionIds,
    tool: deploymentAccepted ? "controller" : "developer-context",
    objective: deploymentAccepted ? "Continue the AI-controlled audit with the validated local deployment fixture" : "Apply the developer's answer to the audit conclusion",
    reason: deploymentAccepted ? "The required deployment inputs are now validated and execution can continue." : "The developer supplied contract intent or a trust assumption tied to the audit's open question(s).",
    networkId: null,
    runnable: true, status: "open",
    required: relatedQuestionIds.some((id) => questionById.get(id)?.materiality === "required-for-opinion"),
    acceptedDeveloperEvidence: true,
  };
  job.followup.actions.push(generatedAction);
  job.reportMarkdown = null;
  job.reportState = { status: "awaiting-testing", reason: deploymentAccepted ? "A validated local Anvil fixture is entering the continuing AI-controlled audit" : "Developer-provided context is entering evidence review", finalizedAt: null, finalizedBy: null };
  addEvent(job, "developer-input", "accepted", `${accepted.length} developer-provided evidence record(s) accepted at evidence revision ${job.evidenceRevision}`, {
    recordIds: accepted.map((item) => item.id),
    planId: deploymentAccepted ? job.developerDeploymentPlan.id : null,
  });
  return {
    status: "accepted",
    summary: deploymentAccepted
      ? `${job.developerDeploymentPlan.id} is validated against the compiled ABI and the audit is continuing with it.`
      : `${accepted.length} developer-provided context record(s) were added and are being applied to the audit conclusion.`,
    recordIds: accepted.map((item) => item.id),
    normalizedPlan: deploymentAccepted ? job.developerDeploymentPlan.plan : null,
    contextStatements: accepted.filter((item) => item.kind === "audit-context").map((item) => ({ category: item.category, statement: item.statement, relatedQuestionIds: item.relatedQuestionIds })),
    action: generatedAction,
    rejected,
  };
}

function assertDeploymentCandidateSupportedByMessage(message, plan) {
  if (plan?.decision !== "deploy") throw copilotError("The supplied information is still incomplete, so no deployment plan was created", 422);
  const text = String(message || "");
  const args = plan.constructorArguments || [];
  const eoaRoleName = /^(?:owner|admin|administrator|guardian|treasury|recipient|fee\s*recipient|beneficiary|operator|controller|manager|governor|minter|pauser|signer|deployer)$/i;
  for (const arg of args) {
    const fieldName = normalizedFieldName(arg.name);
    if (!fieldName) throw copilotError(`Constructor argument ${arg.position} has no field name, so chat input cannot bind a value safely`, 422);
    if (arg.solidityType === "address" && (!eoaRoleName.test(fieldName) || arg.valueKind !== "anvil-account")) {
      throw copilotError(`${arg.name || "The address input"} is not an explicit disposable EOA role; provide a verified local mock or use a supported fork check`, 422);
    }
    const value = String(arg.value ?? "");
    if (arg.valueKind === "anvil-account") {
      if (!fieldBoundActorSupported(text, arg, args)) throw copilotError(`Actor ${value} was not explicitly bound to constructor field ${arg.name}`, 422);
      continue;
    }
    if (!fieldBoundLiteralSupported(text, arg, args)) throw copilotError(`The proposed value for constructor field ${arg.name || arg.position} was not explicitly bound to that field in the developer message`, 422);
  }
  const transactionValueWei = String(plan.transactionValueWei ?? "0");
  const transactionTokens = numericTokensIn(text.replace(/\bactor[- ]?\d+\b/ig, " "));
  if (transactionValueWei !== "0" && !transactionTokens.includes(transactionValueWei)) {
    throw copilotError("The proposed payable deployment value was not explicitly present in the developer message", 422);
  }
}

function normalizedFieldName(name) {
  return String(name || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function fieldLabels(arg) {
  const normalized = normalizedFieldName(arg.name);
  const labels = [normalized];
  if (/^(?:initial|total|max|min)\s+/.test(normalized)) labels.push(normalized.replace(/^(?:initial|total|max|min)\s+/, ""));
  return [...new Set(labels.filter(Boolean))];
}

function inputClauses(text) {
  return String(text || "").split(/(?<!\d),|,(?!\d)|[;\n]|\s+\band\b\s+/i).map((item) => item.trim()).filter(Boolean);
}

function clauseForField(text, arg) {
  const patterns = fieldLabels(arg).map((label) => new RegExp(`\\b${escapeRegex(label).replace(/\\ /g, "\\s+")}\\b`, "i"));
  return inputClauses(text).filter((clause) => patterns.some((pattern) => pattern.test(clause)));
}

function fieldBoundActorSupported(text, arg, args) {
  const value = String(arg.value ?? "");
  const actorPattern = new RegExp(`\\bactor[- ]?${escapeRegex(value)}\\b`, "i");
  return clauseForField(text, arg).some((clause) => {
    const afterField = fieldValueSpan(clause, arg, args, false);
    if (actorPattern.test(afterField) || (value === "0" && /\b(?:local\s+)?deployer\b|\bmsg\.sender\b/i.test(afterField))) return true;
    const labels = fieldLabels(arg).map((label) => escapeRegex(label).replace(/\\ /g, "\\s+")).join("|");
    const reverseActor = new RegExp(`\\bactor[- ]?${escapeRegex(value)}\\b[^,;\\n]{0,24}\\b(?:as|for)\\s+(?:${labels})\\b`, "i");
    const reverseDeployer = new RegExp(`\\b(?:local\\s+)?deployer\\b[^,;\\n]{0,24}\\b(?:as|for)\\s+(?:${labels})\\b`, "i");
    return reverseActor.test(clause) || (value === "0" && reverseDeployer.test(clause));
  });
}

function fieldBoundLiteralSupported(text, arg, args) {
  const value = String(arg.value ?? "");
  return clauseForField(text, arg).some((clause) => {
    const afterField = fieldValueSpan(clause, arg, args, false);
    return /^-?\d+$/.test(value)
      ? numericTokensIn(afterField).includes(value)
      : Boolean(value) && afterField.toLowerCase().includes(value.toLowerCase());
  });
}

function fieldValueSpan(clause, arg, args, includeBeforeField) {
  const lower = clause.toLowerCase();
  const ownMatches = fieldLabels(arg).map((label) => ({ label, index: lower.indexOf(label) })).filter((item) => item.index >= 0)
    .sort((left, right) => left.index - right.index || right.label.length - left.label.length);
  const own = ownMatches[0];
  if (!own) return "";
  const otherMatches = args.filter((item) => item !== arg).flatMap((item) => fieldLabels(item).map((label) => ({ label, index: lower.indexOf(label) })))
    .filter((item) => item.index >= 0);
  const nextIndex = otherMatches.filter((item) => item.index > own.index).reduce((value, item) => Math.min(value, item.index), clause.length);
  if (!includeBeforeField) return clause.slice(own.index + own.label.length, nextIndex);
  const previousEnd = otherMatches.filter((item) => item.index < own.index).reduce((value, item) => Math.max(value, item.index + item.label.length), 0);
  return clause.slice(previousEnd, nextIndex);
}

function numericTokensIn(text) {
  return [...String(text || "").matchAll(/-?\d[\d,_]*/g)].map((match) => match[0].replace(/[,_]/g, ""));
}

function isQuestionOnlyContext(message) {
  const text = String(message || "").trim();
  if (/\b(?:i confirm|i declare|for this audit|treat .+ as|assume .+ is|the intended behavior is|the trusted role is)\b/i.test(text)) return false;
  return /\?$/.test(text) || /^(?:is|are|am|was|were|do|does|did|should|could|can|would|will|what|why|how|when|where|who)\b/i.test(text);
}

export async function cancelAudit(id) {
  const job = jobs.get(id);
  if (!job) return null;
  if (["completed", "partial", "failed", "cancelled"].includes(job.status)) return publicJob(job);
  job.cancelRequested = true;
  if (job.status !== "queued") job.status = "cancelling";
  addEvent(job, "job", "cancel-requested", "Audit cancellation requested");
  const queuedIndex = auditQueue.findIndex((task) => task.kind === "audit" && task.job === job);
  if (queuedIndex >= 0) {
    auditQueue.splice(queuedIndex, 1);
    finalizeCancellation(job);
  } else if (job.ai.status === "running" || job.aiProfile?.status === "running" || job.evidenceReview?.status === "running") {
    const iteration = job.operationLoop?.iteration || 0;
    const operationId = job.operationLoop?.activeOperation?.id || "";
    await Promise.all([
      job.codex?.cancelActiveReview?.(job.jobDir).catch(() => {}),
      job.codex?.cancelActiveReview?.(`${job.jobDir}:controller:${iteration}`).catch(() => {}),
      operationId ? job.codex?.cancelActiveReview?.(`${job.jobDir}:controller-test:${operationId}`).catch(() => {}) : null,
      job.codex?.cancelActiveReview?.(`${job.jobDir}:controller-evidence:${iteration}`).catch(() => {}),
    ]);
  }
  return publicJob(job);
}

export async function queueAuditFollowup(id, { actionId, evidenceRevision, network = "ethereum" } = {}) {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.reportState?.status === "publishing") throw copilotError("Testing is closing; wait for the findings update to finish", 409);
  if (!job.followup || job.followup.status === "running" || job.followup.status === "queued") throw copilotError("A targeted verification pass is already active", 409);
  if (job.copilot.status === "running") throw copilotError("Wait for Audit Copilot to finish before resuming the audit", 409);
  if (!Number.isInteger(evidenceRevision) || evidenceRevision !== job.evidenceRevision) throw copilotError("This recommendation is stale; use the latest audit conclusion", 409);
  const action = currentFollowupActions(job).find((item) => item.id === actionId);
  if (!action) throw copilotError("The audit continuation is unknown, already consumed, or no longer applicable", 409);
  if (!["controller", "developer-context"].includes(action.tool)) throw copilotError(`The ${action.tool} recommendation is no longer part of the active audit controller`, 409);
  const operation = {
    id: randomUUID(), actionId: action.id, questionId: action.questionId, questionIds: action.questionIds || [], tool: action.tool,
    objective: action.objective, network: null, evidenceRevision, planId: null,
    status: "queued",
    createdAt: now(), startedAt: null, finishedAt: null, cancelRequested: false, error: null,
  };
  action.status = "queued";
  job.followup.status = "queued";
  job.followup.active = operation;
  job.followup.history.push(operation);
  addEvent(job, "followup", "queued", `Authorized AI-controlled audit continuation queued: ${action.objective}`);
  auditQueue.push({ kind: "followup", job, operation });
  queueMicrotask(drainQueue);
  return publicJob(job);
}

export async function finalizeAuditReport(id) {
  const job = jobs.get(id);
  if (!job) return null;
  if (!["completed", "partial", "failed"].includes(job.status)) throw copilotError("Testing can be closed only after the initial audit reaches a terminal state", 409);
  if (["queued", "running"].includes(job.followup?.status) || job.copilot?.status === "running") throw copilotError("Wait for the active AI or testing operation to finish before generating findings", 409);
  if (job.reportState?.status === "ready") return publicJob(job);
  if (job.reportState?.status === "publishing") throw copilotError("Findings publication is already active", 409);
  if (job.reportState?.status === "failed" && job.reportState?.retryable !== true) throw copilotError(job.reportState.reason || "This audit stopped before final findings could be generated; correct the audit failure and rerun", 409);
  const openActions = currentFollowupActions(job);
  for (const action of openActions) action.status = "declined";
  addEvent(job, "testing", "closed", `Developer closed testing with ${openActions.length} audit continuation(s) recorded as not run`);
  await publishFinalFindings(job, { trigger: "developer-closed-testing", finalizedBy: "developer", reason: "Developer closed testing with the recorded unresolved checks" });
  return publicJob(job);
}

export async function cancelAuditFollowup(id, operationId) {
  const job = jobs.get(id);
  if (!job) return null;
  const operation = job.followup?.history?.find((item) => item.id === operationId);
  if (!operation || !["queued", "running"].includes(operation.status)) throw copilotError("Targeted verification pass is not active", 409);
  operation.cancelRequested = true;
  if (operation.status === "queued") {
    const queuedIndex = auditQueue.findIndex((task) => task.kind === "followup" && task.operation === operation);
    if (queuedIndex >= 0) auditQueue.splice(queuedIndex, 1);
    operation.status = "cancelled";
    operation.finishedAt = now();
    const action = job.followup.actions.find((item) => item.id === operation.actionId);
    if (action) action.status = "open";
    if (operation.tool === "anvil" && job.developerDeploymentPlan?.id === operation.planId) {
      job.developerDeploymentPlan.status = "proposed";
      job.developerDeploymentPlan.approvedAt = null;
    }
    job.followup.status = "idle";
    job.followup.active = null;
  } else {
    const iteration = job.operationLoop?.iteration || 0;
    const activeOperationId = job.operationLoop?.activeOperation?.id || "";
    await Promise.all([
      job.codex?.cancelActiveReview?.(`${job.jobDir}:followup:${operation.id}`).catch(() => {}),
      job.codex?.cancelActiveReview?.(`${job.jobDir}:controller:${iteration}`).catch(() => {}),
      activeOperationId ? job.codex?.cancelActiveReview?.(`${job.jobDir}:controller-test:${activeOperationId}`).catch(() => {}) : null,
      job.codex?.cancelActiveReview?.(`${job.jobDir}:controller-evidence:${iteration}`).catch(() => {}),
    ]);
  }
  addEvent(job, "followup", "cancel-requested", operation.tool === "controller" ? "AI-controlled audit cancellation requested" : "Evidence-review cancellation requested");
  return publicJob(job);
}

export function createAudit({ projectRoot, capabilities, codex, source, fileName, useAi = true, auditDepth = "targeted", allowLocalExecution, allowAnvil, allowForks = false, runGeneratedTests = false, runAnvil = false, testCampaign = {}, declaredContext = {} }) {
  if (jobs.size >= MAX_RETAINED_JOBS) {
    const oldestTerminal = [...jobs.values()]
      .filter((item) => ["completed", "partial", "failed", "cancelled"].includes(item.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (oldestTerminal) {
      jobs.delete(oldestTerminal.id);
      void jobStore?.deleteJob?.(oldestTerminal.id).catch(() => {});
    }
    else throw new Error("The local audit queue is full; wait for an active audit to finish before starting another");
  }
  if (typeof source !== "string" || !source.trim()) throw new Error("Solidity source is required");
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) throw new Error("Source exceeds the 250 KB MVP limit");
  if (!/\b(contract|library|interface|abstract\s+contract)\b/.test(source)) {
    throw new Error("No Solidity contract, library, or interface declaration was found");
  }
  if (!useAi) throw new Error("The AI auditor is required for review, targeted verification, and full-suite audits");
  const depth = normalizeAuditDepth(auditDepth);
  const executionPermissions = {
    localExecution: Boolean(allowLocalExecution ?? runGeneratedTests),
    anvil: Boolean(allowAnvil ?? runAnvil),
    forks: Boolean(allowForks),
  };
  if (depth === "review") Object.assign(executionPermissions, { localExecution: false, anvil: false, forks: false });

  const id = randomUUID();
  const createdAt = now();
  const job = {
    id,
    fileName: safeName(fileName),
    source,
    sourceHash: sourceHash(source),
    status: "queued",
    cancelRequested: false,
    createdAt,
    updatedAt: createdAt,
    projectRoot,
    jobDir: path.join(projectRoot, "work", "jobs", id),
    capabilities,
    codex,
    useAi: true,
    auditDepth: depth,
    executionPermissions,
    runGeneratedTests: executionPermissions.localExecution,
    runAnvil: executionPermissions.anvil,
    testCampaign: normalizeTestCampaign(testCampaign),
    declaredContext: normalizeDeclaredContext(declaredContext),
    stages: [
      { id: "intake", label: "Validate source", status: "queued", message: "Waiting" },
      { id: "ai-profile", label: "AI whole-contract assessment", status: "queued", message: "Waiting" },
      { id: "operation-loop", label: "AI-selected evidence operations", status: "queued", message: "Waiting" },
      { id: "evidence-review", label: "AI evidence adjudication", status: "queued", message: "Waiting" },
      { id: "report", label: "Cross-check and report", status: "queued", message: "Waiting" },
    ],
    worklog: [],
    toolRuns: [],
    findings: [],
    qualityFindings: [],
    contractProfile: null,
    suitePlan: [],
    aiContractProfile: null,
    sourceConclusions: [],
    sourceFindings: [],
    aiProfile: { status: useAi ? "queued" : "disabled", error: null },
    aiSuitePlan: [],
    aiDeploymentPlan: null,
    developerDeploymentPlan: null,
    developerEvidence: [],
    verificationQuestions: [],
    evidenceReview: { status: useAi ? "queued" : "disabled", testResults: [], questionResults: [], additionalPasses: [] },
    deploymentArtifacts: [],
    compileSettings: { autoDetectSolc: true, offline: "cache-first", compilerDownload: "fallback", optimizer: true, optimizerRuns: 200 },
    compilerAvailability: { status: "unknown", requirement: declaredCompilerRequirement(source), reason: null },
    anvil: { requested: Boolean(runAnvil), status: runAnvil ? "queued" : "disabled" },
    ai: { requested: Boolean(useAi), status: useAi ? "queued" : "disabled", result: null, error: null, progress: null },
    auditSynthesis: { status: "queued", answer: null, citations: [], suggestedNextSteps: [], error: null },
    copilot: { status: "idle", error: null, messages: [] },
    limitations: [
      "This MVP accepts one Solidity file; imports and external dependencies may not resolve.",
      "A passing automated run is not proof of security or proof that all reachable states were explored.",
      "Echidna and Halmos require meaningful properties/harnesses and are not invoked blindly.",
      "Generated test code is a proposal until it compiles and executes successfully in isolation.",
    ],
    reportMarkdown: null,
    reportState: { status: "waiting-for-audit", reason: "Selected testing has not reached a terminal evidence state", finalizedAt: null, finalizedBy: null },
    sourceIntegrity: { status: "pending", expectedHash: sourceHash(source), checkedAt: null, error: null },
    evidenceRevision: 0,
    reportRevisions: [],
    operationLoop: {
      controllerVersion: AUDIT_CONTROLLER_VERSION,
      status: "queued",
      iteration: 0,
      activeOperation: null,
      history: [],
      evidenceLedger: [],
      decisions: [],
      stopReason: null,
      coverageObligations: [],
      coverageQuestions: [],
      deadlineAt: null,
    },
    followup: { status: "idle", active: null, history: [], actions: [], defaultNetwork: "ethereum" },
  };
  jobs.set(id, job);
  addEvent(job, "job", "queued", `Audit created for ${job.fileName}; depth ${job.auditDepth}; source hash ${job.sourceHash.slice(0, 12)}…`);
  auditQueue.push({ kind: "audit", job });
  queueMicrotask(drainQueue);
  return publicJob(job);
}

function drainQueue() {
  if (activeAudits >= 1) return;
  const task = auditQueue.shift();
  if (!task) return;
  const { job } = task;
  activeAudits += 1;
  const runner = task.kind === "followup" ? runFollowup(job, task.operation) : runAudit(job);
  runner
    .catch((error) => task.kind === "followup" ? failFollowup(job, task.operation, error) : error?.code === "AUDIT_CANCELLED" ? finalizeCancellation(job) : failJob(job, error))
    .finally(() => {
      activeAudits -= 1;
      drainQueue();
    });
}

async function runAudit(job) {
  throwIfCancelled(job);
  job.status = "running";
  stage(job, "intake", "running", "Validating and fingerprinting source");
  await prepareJob(job);
  await assertSubmittedSourceUnchanged(job);
  throwIfCancelled(job);
  stage(job, "intake", "completed", "Source accepted; isolated Foundry job created");
  job.contractProfile = profileContract(job.source);
  if (job.declaredContext.contractType !== "auto" && !job.contractProfile.archetypes.includes(job.declaredContext.contractType)) {
    job.contractProfile.archetypes.unshift(job.declaredContext.contractType);
  }
  job.suitePlan = buildBaselineSuite(job.contractProfile, job.declaredContext);
  job.testCampaign = resolveTestCampaign(job.testCampaign, job.suitePlan);

  await runAiProfile(job);
  await assertSubmittedSourceUnchanged(job);
  if (job.aiProfile.status !== "completed") throw new Error(job.aiProfile.error || "AI whole-contract assessment did not complete");
  initializeAiStateFromProfile(job);

  if (job.auditDepth === "full") await runFullQualityDiagnostics(job);
  await runAiControlledAudit(job);
  await assertSubmittedSourceUnchanged(job);
  throwIfCancelled(job);

  job.evidenceRevision = Math.max(1, job.evidenceRevision);
  refreshFollowupActions(job);

  corroborate(job.findings);
  const finalStatus = deriveFinalStatus(job);
  addEvent(job, "report", "summary", `AI auditor reached a ${job.operationLoop.status} decision after ${job.operationLoop.iteration} planning round(s) and ${job.toolRuns.filter((run) => run.status === "completed" && run.evidenceEligible !== false).length} completed evidentiary tool run(s)`);
  job.status = finalStatus;
  await settleReportAfterTesting(job, "initial-audit");
}

async function runFullQualityDiagnostics(job) {
  const capability = toolCapability(job, "solhint");
  if (!capability.available) {
    addEvent(job, "quality", "unavailable", "Pinned Solhint quality diagnostics are unavailable; this does not corroborate or negate security findings");
    return;
  }
  throwIfCancelled(job);
  const configPath = path.join(job.jobDir, ".solhint.json");
  await writeFile(configPath, `${JSON.stringify({ extends: "solhint:recommended" }, null, 2)}\n`, { mode: 0o600 });
  const result = await runCommand(capability.command, ["--formatter", "json", "src/Target.sol"], {
    cwd: job.jobDir,
    timeoutMs: 60_000,
    maxOutputBytes: 1_000_000,
    env: analysisEnvironment(job.jobDir),
    isCancelled: () => job.cancelRequested,
  });
  throwIfCancelled(job);
  let diagnostics = [];
  let parseError = null;
  try { diagnostics = normalizeSolhintOutput(result.stdout, capability.version).slice(0, 500); }
  catch (error) { parseError = error.message; }
  const status = !parseError && !result.signal && !result.timedOut && !result.truncated ? "completed" : result.timedOut ? "timed-out" : "failed";
  job.qualityFindings = diagnostics;
  const run = toToolRun("solhint-quality", capability.version, status, result);
  run.evidenceEligible = false;
  run.findingCount = diagnostics.length;
  run.parseError = parseError;
  job.toolRuns.push(run);
  await writeFile(path.join(job.jobDir, "artifacts", "solhint.stdout.txt"), result.stdout);
  await writeFile(path.join(job.jobDir, "artifacts", "solhint.stderr.txt"), result.stderr);
  addEvent(job, "quality", status, status === "completed"
    ? `Solhint recorded ${diagnostics.length} non-corroborating quality diagnostic(s)`
    : `Solhint quality diagnostics did not complete: ${parseError || result.error || "tool execution failed"}`);
}

function initializeAiStateFromProfile(job) {
  const profile = job.aiProfile.result;
  job.ai = {
    requested: true,
    status: "completed",
    error: null,
    progress: null,
    result: {
      contractProfile: profile.contractProfile,
      contractSummary: profile.contractSummary,
      threatModel: profile.threatModel,
      moneyFlow: normalizeAuditModelList(profile.moneyFlow),
      permissionFlow: normalizeAuditModelList(profile.permissionFlow),
      trustAssumptions: normalizeAuditModelList(profile.trustAssumptions),
      invariants: normalizeAuditModelList(profile.invariants),
      sourceConclusions: profile.sourceConclusions || [],
      sourceFindings: profile.sourceFindings || [],
      deploymentPlan: profile.deploymentPlan,
      verificationQuestions: profile.verificationQuestions || [],
      reviewedFindings: [],
      testPlans: [],
      suitePlan: job.suitePlan,
      limitations: profile.limitations || [],
    },
  };
  job.aiContractProfile = profile.contractProfile || null;
  job.aiDeploymentPlan = profile.deploymentPlan || null;
  job.sourceConclusions = profile.sourceConclusions || [];
  job.sourceFindings = profile.sourceFindings || [];
  job.findings.push(...job.sourceFindings.map((finding, index) => normalizeSourceFinding(job, finding, index)));
  job.verificationQuestions = profile.verificationQuestions || [];
  const sourceAnswerByQuestion = new Map();
  for (const conclusion of job.sourceConclusions) {
    for (const questionId of conclusion.relatedQuestionIds || []) {
      const existing = sourceAnswerByQuestion.get(questionId) || [];
      existing.push(conclusion);
      sourceAnswerByQuestion.set(questionId, existing);
    }
  }
  job.evidenceReview = {
    status: "pending",
    testResults: [],
    questionResults: job.verificationQuestions.map((question) => {
      const conclusions = sourceAnswerByQuestion.get(question.id) || [];
      const sourceRouteSufficient = (question.sufficientEvidenceRoutes || []).some((route) => route.length === 1 && route[0] === "source");
      if (conclusions.length && sourceRouteSufficient) {
        return {
          questionId: question.id,
          status: "ai-supported",
          answer: conclusions.map((item) => item.statement).join(" "),
          confidence: conclusions.every((item) => item.confidence === "high") ? "high" : "medium",
          relatedTestIds: [],
          sourceEvidence: conclusions.flatMap((item) => item.evidence || []),
          evidenceClasses: ["source"],
          assurance: "source-supported",
          nextCheck: { needed: false, tool: "none", objective: "", reason: "The whole-contract source trace directly establishes this behavior" },
        };
      }
      return {
        questionId: question.id,
        status: "not-verified",
        answer: "Not established: the AI auditor has not yet obtained a sufficient evidence route for this question.",
        confidence: "low",
        relatedTestIds: [],
        sourceEvidence: [],
        evidenceClasses: [],
        assurance: "not-verified",
        nextCheck: defaultNextCheckForQuestion(question, { objective: question.expectedEvidence }, question.rationale),
      };
    }),
    additionalPasses: [],
  };
}

async function runAiControlledAudit(job, { resume = false, isCancelled = () => job.cancelRequested } = {}) {
  const loop = job.operationLoop;
  const catalog = controllerCapabilityCatalog(job.capabilities, job.executionPermissions);
  loop.status = "running";
  loop.stopReason = null;
  loop.deadlineAt = new Date(Date.now() + job.testCampaign.timeoutMinutes * 60_000).toISOString();
  stage(job, "operation-loop", "running", resume ? "AI-controlled audit resumed with preserved evidence" : `AI is selecting ${job.auditDepth === "full" ? "full-suite" : job.auditDepth === "review" ? "source-review" : "targeted"} evidence operations`);

  const deadline = Date.parse(loop.deadlineAt);
  let noProgressRounds = 0;
  let executedCount = loop.evidenceLedger.length;
  while (Date.now() < deadline && executedCount < 64) {
    throwIfControllerCancelled(job, isCancelled);
    await assertSubmittedSourceUnchanged(job);
    loop.iteration += 1;
    const operationKey = `${job.jobDir}:controller:${loop.iteration}`;
    addEvent(job, "operation-loop", "checkpoint", `AI auditor is deciding the next evidence operation (round ${loop.iteration})`);
    const rawDecision = await runWithAiRetry(job, "controller planning", () => job.codex.planAuditOperations({
      operationKey,
      jobDir: job.jobDir,
      source: job.source,
      sourceHash: job.sourceHash,
      depth: job.auditDepth,
      capabilityCatalog: catalog,
      coverageObligations: loop.coverageObligations,
      contractModel: {
        contractProfile: job.aiContractProfile,
        contractSummary: job.ai.result.contractSummary,
        threatModel: job.ai.result.threatModel,
        moneyFlow: job.ai.result.moneyFlow || [],
        permissionFlow: job.ai.result.permissionFlow || [],
        trustAssumptions: job.ai.result.trustAssumptions || [],
        invariants: job.ai.result.invariants || [],
        developerEvidence: job.developerEvidence || [],
        developerDeploymentPlan: job.developerDeploymentPlan || null,
      },
      sourceConclusions: job.sourceConclusions,
      verificationQuestions: [...job.verificationQuestions, ...loop.coverageQuestions.filter((item) => !job.verificationQuestions.some((question) => question.id === item.id))],
      evidenceReview: job.evidenceReview,
      findings: job.findings.map(compactFindingForAi),
      toolRuns: job.toolRuns.map(compactToolRunForAi),
      operationHistory: loop.history.map(compactOperationForAi),
      declaredContext: job.declaredContext,
      timeoutMs: Math.max(5_000, deadline - Date.now()),
    }));
    await assertSubmittedSourceUnchanged(job);
    const decision = normalizeControllerDecision(rawDecision, {
      questionIds: controllerOperationQuestionIds(job),
      priorSpecDigests: loop.evidenceLedger.map((item) => item.specDigest),
      retryableSpecDigests: retryableControllerSpecDigests(job, loop.history),
      priorOperationIds: loop.history.map((item) => item.id),
      sourceHash: job.sourceHash,
      serverApprovedInapplicableKinds: loop.coverageObligations.filter((item) => item.status === "inapplicable").map((item) => item.kind),
    });
    applyCoverageUpdates(loop.coverageObligations, decision.coverageUpdates);
    loop.decisions.push({ iteration: loop.iteration, at: now(), status: decision.status, assessment: decision.assessment, requestedInput: decision.requestedInput, operationIds: decision.operations.map((item) => item.id), coverageUpdates: decision.coverageUpdates || [] });
    addEvent(job, "operation-loop", "decision", decision.assessment, { status: decision.status, operations: decision.operations.map((item) => ({ id: item.id, kind: item.kind, questionId: item.questionId, objective: item.objective })) });

    if (decision.status !== "continue") {
      loop.status = decision.status === "conclude" ? "completed" : decision.status;
      loop.stopReason = decision.status === "needs-input" ? decision.requestedInput : decision.assessment;
      break;
    }

    let roundProgress = false;
    for (const operation of decision.operations) {
      if (Date.now() >= deadline || executedCount >= 64) break;
      throwIfControllerCancelled(job, isCancelled);
      materializeControllerQuestion(job, operation.questionId);
      const history = {
        id: operation.id,
        kind: operation.kind,
        questionId: operation.questionId,
        objective: operation.objective,
        rationale: operation.rationale,
        specDigest: operation.specDigest,
        status: "validated",
        recommendedAt: now(),
        sourceHash: job.sourceHash,
        evidenceRevision: job.evidenceRevision,
      };
      loop.history.push(history);
      loop.activeOperation = { id: operation.id, kind: operation.kind, questionId: operation.questionId, objective: operation.objective };
      addEvent(job, "operation-loop", "running", `${operation.kind}: ${operation.objective}`, { operationId: operation.id, questionId: operation.questionId });
      const beforeRuns = job.toolRuns.length;
      let execution;
      try {
        execution = await executeControllerOperation(job, operation, catalog, deadline, isCancelled);
      } catch (error) {
        if (["AUDIT_CANCELLED", "FOLLOWUP_CANCELLED"].includes(error?.code)) throw error;
        execution = { status: "failed", blocker: error.message, evidenceDigest: null };
      }
      await assertSubmittedSourceUnchanged(job);
      const toolRunIds = job.toolRuns.slice(beforeRuns).map((item) => item.runId).filter(Boolean);
      const evidence = operationEvidenceRecord({ job, operation, status: execution.status, toolRunIds, evidenceDigest: execution.evidenceDigest, blocker: execution.blocker });
      if (execution.status === "completed") {
        for (const prior of loop.evidenceLedger.filter((item) => item.specDigest === operation.specDigest && item.status !== "completed" && !item.supersededBy)) prior.supersededBy = operation.id;
        for (const prior of job.toolRuns.filter((run) => run.operationSpecDigest === operation.specDigest && run.operationId !== operation.id && run.status !== "completed" && !run.supersededBy)) prior.supersededBy = operation.id;
      }
      loop.evidenceLedger.push(evidence);
      Object.assign(history, { status: execution.status, finishedAt: now(), toolRunIds, evidenceDigest: execution.evidenceDigest, blocker: execution.blocker || null });
      executedCount += 1;
      updateCoverageObligation(job, operation, execution);
      roundProgress ||= Boolean(execution.evidenceDigest && !loop.evidenceLedger.slice(0, -1).some((item) => item.evidenceDigest === execution.evidenceDigest));
      addEvent(job, "operation-loop", execution.status, execution.blocker || `${operation.kind} returned evidence for AI adjudication`, { operationId: operation.id, questionId: operation.questionId, toolRunIds });
    }
    loop.activeOperation = null;

    throwIfControllerCancelled(job, isCancelled);
    await adjudicateControllerEvidence(job);
    reconcileFullCoverageAfterAdjudication(job);
    await assertSubmittedSourceUnchanged(job);
    job.evidenceRevision += 1;
    const newlyTerminal = terminalQuestionCount(job);
    roundProgress ||= newlyTerminal > Number(loop.lastTerminalQuestionCount || 0);
    loop.lastTerminalQuestionCount = newlyTerminal;
    noProgressRounds = roundProgress ? 0 : noProgressRounds + 1;
    if (noProgressRounds >= 2) {
      loop.status = "blocked";
      loop.stopReason = "Two AI-controller rounds produced no new accepted evidence or question-state transition";
      break;
    }
  }

  if (loop.status === "running") {
    loop.status = "evidence-exhausted";
    loop.stopReason = Date.now() >= deadline
      ? "The selected audit time window ended; completed evidence was preserved"
      : "The controller reached the 64-operation safety envelope; completed evidence was preserved";
  }
  if (loop.approvedTestingCampaign?.status === "active") {
    loop.approvedTestingCampaign.status = "completed";
    loop.approvedTestingCampaign.completedAt = now();
    loop.approvedTestingCampaign.result = loop.stopReason || "The AI-selected recommended property campaign reached a conclusion";
  }
  loop.activeOperation = null;
  const stageStatus = loop.status === "completed" ? "completed" : loop.status === "needs-input" ? "skipped" : "failed";
  stage(job, "operation-loop", stageStatus, loop.stopReason || "AI-controlled audit loop finished");
}

async function executeControllerOperation(job, operation, catalog, deadline, isCancelled) {
  const capability = catalog.find((item) => item.kind === operation.kind);
  if (!capability) return { status: "blocked", blocker: `Operation ${operation.kind} is not registered`, evidenceDigest: null };
  if (!capability.installed) return { status: "unavailable", blocker: `${operation.kind} is not installed`, evidenceDigest: null };
  if (!capability.authorized) return { status: "not-authorized", blocker: `${operation.kind} was not authorized for this audit depth selection`, evidenceDigest: null };
  const question = controllerQuestionById(job, operation.questionId);
  if (!question) return { status: "blocked", blocker: "The referenced verification question is no longer unresolved", evidenceDigest: null };
  if (["foundry", "anvil-deployment", "anvil-scenario", "fork"].includes(operation.kind)) {
    const prepared = await ensureCompiledArtifacts(job, deadline, isCancelled, operation);
    if (!prepared.ok) return { status: prepared.status, blocker: prepared.reason, evidenceDigest: null };
  }
  const before = job.toolRuns.length;
  if (operation.kind === "slither") {
    await runSlither(job, toolCapability(job, "slither"), { operation, detectors: operation.slitherDetectors, deadline, isCancelled });
  } else if (operation.kind === "aderyn") {
    await runAderyn(job, toolCapability(job, "aderyn"), { operation, severity: operation.aderynSeverity, deadline, isCancelled });
  } else if (operation.kind === "compiler-matrix") {
    await runCompilerMatrix(job, operation, deadline, isCancelled);
  } else if (operation.kind === "foundry" || operation.kind === "fork") {
    const campaign = await runControllerFoundryOperation(job, operation, question, deadline, isCancelled);
    if (campaign?.status === "budget-exhausted") return { status: "budget-exhausted", blocker: campaign.reason, evidenceDigest: null };
  } else if (["anvil-deployment", "anvil-scenario"].includes(operation.kind)) {
    await refreshDeploymentFixturePlan(job, operation, deadline, isCancelled);
    await runAnvilStage(job, job.aiDeploymentPlan, isCancelled, operation.kind === "anvil-scenario" ? operation.scenario : null, operation);
  }
  const runs = job.toolRuns.slice(before);
  const successful = runs.length > 0 && runs.every((run) => run.status === "completed");
  const scenarioSucceeded = operation.kind !== "anvil-scenario" || ["completed", "property-failure"].includes(job.anvil?.scenario?.status);
  const evidenceDigest = sourceHash(JSON.stringify({ operation: operation.specDigest, runs: runs.map(compactToolRunForDigest), scenario: job.anvil?.scenario || null }));
  return {
    status: successful && scenarioSucceeded ? "completed" : runs.some((run) => run.status === "timed-out") ? "timed-out" : "failed",
    blocker: successful && scenarioSucceeded ? null : job.anvil?.reason || runs.find((run) => run.status !== "completed")?.error || `${operation.kind} did not produce complete evidence`,
    evidenceDigest,
  };
}

async function refreshDeploymentFixturePlan(job, operation, deadline, isCancelled) {
  throwIfControllerCancelled(job, isCancelled);
  job.deploymentArtifacts = await inspectDeploymentArtifacts(job.jobDir);
  const developerPlan = job.developerDeploymentPlan;
  if (developerPlan?.status === "proposed" && developerPlan.sourceHash === job.sourceHash) {
    const checked = await validateDeveloperDeploymentPlan(job.jobDir, developerPlan.plan);
    if (checked.artifactSha256 !== developerPlan.artifactSha256) throw new Error("The validated developer deployment fixture no longer matches the compiled artifact");
    job.aiDeploymentPlan = checked.plan;
    developerPlan.status = "approved";
    developerPlan.approvedAt = now();
    addEvent(job, "operation-loop", "checkpoint", `Using developer-provided disposable deployment fixture ${developerPlan.id}`);
    return;
  }
  const deterministic = await selectDeployableArtifact(job.jobDir, null);
  if (deterministic.status === "ready") {
    job.aiDeploymentPlan = deterministic.deploymentPlan;
    addEvent(job, "operation-loop", "checkpoint", `Selected ${deterministic.contract} deterministically for disposable Anvil deployment`);
    return;
  }
  if (!job.codex?.planDeploymentFixture) {
    job.aiDeploymentPlan = {
      decision: "needs-input", decisionReason: "planning-failed", environment: "fresh-anvil", targetContract: "",
      constructorArguments: [], transactionValueWei: "0",
      rationale: "Compiled constructor metadata is available, but the AI fixture planner is unavailable",
      limitations: ["Provide explicit constructor fixtures through Audit Copilot or retry with the AI service available"],
    };
    return;
  }
  const plan = await runWithAiRetry(job, "fresh-Anvil fixture planning", () => job.codex.planDeploymentFixture({
    operationKey: `${job.jobDir}:deployment-plan:${operation.id}`,
    jobDir: job.jobDir,
    source: job.source,
    sourceHash: job.sourceHash,
    deploymentArtifacts: job.deploymentArtifacts,
    contractModel: {
      contractProfile: job.aiContractProfile,
      contractSummary: job.ai?.result?.contractSummary,
      threatModel: job.ai?.result?.threatModel,
      moneyFlow: job.ai?.result?.moneyFlow || [],
      permissionFlow: job.ai?.result?.permissionFlow || [],
      trustAssumptions: job.ai?.result?.trustAssumptions || [],
      invariants: job.ai?.result?.invariants || [],
      declaredContext: job.declaredContext,
      developerEvidence: job.developerEvidence || [],
      developerDeploymentPlan: job.developerDeploymentPlan || null,
    },
    timeoutMs: Math.max(5_000, deadline - Date.now()),
  }));
  throwIfControllerCancelled(job, isCancelled);
  if (plan?.decision === "deploy") {
    const selected = await selectDeployableArtifact(job.jobDir, plan);
    if (selected.status !== "ready") throw new Error(`AI deployment fixture did not match the compiled ABI: ${selected.reason}`);
    job.aiDeploymentPlan = selected.deploymentPlan;
  } else {
    job.aiDeploymentPlan = plan;
  }
  addEvent(job, "operation-loop", "checkpoint", plan?.decision === "deploy"
    ? `AI prepared an ABI-validated disposable deployment fixture for ${plan.targetContract}`
    : `Disposable deployment needs specific input: ${plan?.rationale || "constructor or dependency configuration is unresolved"}`);
}

async function ensureCompiledArtifacts(job, deadline, isCancelled, operation) {
  const standardCompile = job.toolRuns.find((run) => ["forge-bootstrap", "forge"].includes(run.tool) && run.status === "completed");
  if (standardCompile) {
    if (!["anvil-deployment", "anvil-scenario"].includes(operation.kind)) return { ok: true };
    job.deploymentArtifacts = await inspectDeploymentArtifacts(job.jobDir);
    if (job.deploymentArtifacts.length) return { ok: true };
    return { ok: false, status: "failed", reason: "Foundry compilation completed but produced no concrete deployable target artifact" };
  }
  const forge = toolCapability(job, "forge");
  if (!forge.available) return { ok: false, status: "unavailable", reason: "Foundry is unavailable, so compiled artifacts cannot be prepared" };
  addEvent(job, "operation-loop", "checkpoint", `Preparing compiled artifacts required by the AI-selected ${operation.kind} operation`);
  const run = await runForge(job, forge, {
    stageId: null,
    toolName: "forge-bootstrap",
    evidenceEligible: false,
    deadline,
    isCancelled,
    operation,
  });
  if (run.status === "completed") {
    job.deploymentArtifacts = await inspectDeploymentArtifacts(job.jobDir);
    if (["anvil-deployment", "anvil-scenario"].includes(operation.kind) && !job.deploymentArtifacts.length) {
      return { ok: false, status: "failed", reason: "Foundry compilation completed but produced no concrete deployable target artifact" };
    }
    return { ok: true };
  }
  return {
    ok: false,
    status: run.timedOut ? "timed-out" : run.compilerUnavailable ? "unavailable" : "failed",
    reason: run.error || "Foundry could not prepare compiled artifacts",
  };
}

async function runControllerFoundryOperation(job, operation, question, deadline, isCancelled) {
  let fork = null;
  if (operation.kind === "fork") {
    const network = resolveForkNetwork(operation.networkId);
    const pinned = await verifyForkNetwork(network.id);
    fork = { ...network, ...pinned };
  }
  const questions = groupedCampaignQuestions(job, operation, question);
  const capacity = controllerCampaignCapacity(job, operation);
  if (capacity.maxHarnesses === 0) {
    const reason = `The selected ${job.testCampaign.mode} campaign reached its global ${capacity.budget}-property-check budget; completed evidence is preserved`;
    job.testCampaign.budgetExhausted = true;
    job.testCampaign.budgetExhaustedReason = reason;
    addEvent(job, "operation-loop", "budget-exhausted", reason);
    return { status: "budget-exhausted", reason };
  }
  const designed = await runWithAiRetry(job, "contract-specific test campaign design", () => job.codex.designAuditCampaign({
    operationKey: `${job.jobDir}:controller-test:${operation.id}`,
    jobDir: job.jobDir,
    source: job.source,
    sourceHash: job.sourceHash,
    questions: questions.map((item) => ({ ...item, recommendedRoute: operation.kind, objective: operation.objective, reason: operation.rationale })),
    priorPlans: (job.ai.result.testPlans || []).map((plan) => ({ id: plan.id, questionIds: plan.questionIds, executionStatus: plan.executionStatus, executionMessage: plan.executionMessage })),
    contractModel: {
      contractProfile: job.aiContractProfile,
      contractSummary: job.ai.result.contractSummary,
      threatModel: job.ai.result.threatModel,
      moneyFlow: job.ai.result.moneyFlow || [],
      permissionFlow: job.ai.result.permissionFlow || [],
      trustAssumptions: job.ai.result.trustAssumptions || [],
      invariants: job.ai.result.invariants || [],
      declaredContext: job.declaredContext,
      developerEvidence: job.developerEvidence || [],
      developerDeploymentPlan: job.developerDeploymentPlan || null,
    },
    suitePlan: job.suitePlan,
    network: fork ? { id: fork.id, label: fork.label, chainId: fork.chainId, blockNumber: fork.blockNumber, blockHash: fork.blockHash } : null,
    maxHarnesses: capacity.maxHarnesses,
    timeoutMs: Math.max(5_000, deadline - Date.now()),
  }));
  const plans = normalizeCampaignPlans(job, operation, questions, designed?.testPlans, capacity);
  if (!plans.length) throw new Error("AI returned no new valid question-bound Foundry harness");
  job.testCampaign.plansReturned += plans.length;
  job.ai.result.testPlans.push(...plans);
  await runGeneratedTests(job, { plans, controllerOperation: operation, fork, deadlineAt: deadline, isCancelled });
  if (fork) {
    try {
      await verifyPinnedForkBlock(fork.id, fork);
    } catch (error) {
      for (const plan of plans) {
        plan.networkEvidence = null;
        if (plan.executionStatus === "executed-needs-oracle") plan.executionStatus = "not-verified";
        plan.executionMessage = error.message;
      }
      throw error;
    }
  }
}

function groupedCampaignQuestions(job, operation, primary) {
  const unresolved = new Set(controllerOperationQuestionIds(job));
  const approved = new Set(approvedTestingQuestionIds(job));
  const routeKinds = operation.kind === "fork" ? new Set(["fork", "foundry"]) : new Set(["foundry", "anvil-scenario"]);
  const candidates = (job.verificationQuestions || []).filter((item) => unresolved.has(item.id))
    .filter((item) => job.auditDepth === "full" || item.materiality === "required-for-opinion" || approved.has(item.id))
    .filter((item) => (item.sufficientEvidenceRoutes || []).some((route) => route.some((kind) => routeKinds.has(kind)))
      || (item.requiredEvidenceKinds || []).some((kind) => routeKinds.has(kind)));
  return [primary, ...candidates.filter((item) => item.id !== primary.id)].slice(0, 12);
}

async function adjudicateControllerEvidence(job) {
  job.findings = deduplicate(job.findings);
  const hasUnreviewedAnalyzerEvidence = job.findings.some((finding) => !finding.aiReview);
  if (hasUnreviewedAnalyzerEvidence) await runAiReview(job);
  if (job.verificationQuestions.length) await runEvidenceVerification(job);
  else addEvent(job, "operation-loop", "reviewed", "No contract-specific property questions required adjudication; full-mode coverage accounting remains active");
  corroborate(job.findings);
}

function unresolvedControllerQuestionIds(job) {
  const results = new Map((job.evidenceReview?.questionResults || []).map((item) => [item.questionId, item.status]));
  return (job.verificationQuestions || []).filter((item) => !["ai-supported", "ai-supported-concern", "accepted-behavior", "developer-decision"].includes(results.get(item.id))).map((item) => item.id);
}

function requiredUnresolvedQuestionIds(job) {
  if (job.auditDepth === "review") return [];
  const unresolved = new Set(unresolvedControllerQuestionIds(job));
  return (job.verificationQuestions || [])
    .filter((item) => unresolved.has(item.id) && (job.auditDepth === "full" || item.materiality === "required-for-opinion"))
    .map((item) => item.id);
}

function controllerOperationQuestionIds(job) {
  const unresolved = new Set(unresolvedControllerQuestionIds(job));
  const ids = (job.verificationQuestions || [])
    .filter((question) => unresolved.has(question.id))
    .filter((question) => job.auditDepth === "full" || question.materiality === "required-for-opinion")
    .map((question) => question.id);
  for (const question of job.operationLoop?.coverageQuestions || []) {
    const obligation = job.operationLoop.coverageObligations.find((item) => item.kind === question.coverageKind);
    if (obligation?.status === "pending" && !(obligation.completedQuestionIds || []).includes(question.id)) ids.push(question.id);
  }
  for (const id of approvedTestingQuestionIds(job)) {
    if (!job.verificationQuestions.some((question) => question.id === id) || unresolved.has(id)) ids.push(id);
  }
  return [...new Set(ids)];
}

function controllerQuestionById(job, id) {
  return job.verificationQuestions.find((item) => item.id === id)
    || (job.operationLoop?.coverageQuestions || []).find((item) => item.id === id)
    || null;
}

function buildFullCoverageQuestions(obligations, suitePlan = []) {
  const questions = [];
  for (const item of obligations.filter((entry) => entry.status === "pending")) {
    if (item.kind === "foundry") {
      const scenarioQuestions = suitePlan.flatMap((plan) => (plan.preferredTools || []).includes("forge") && plan.environment !== "compile-matrix"
        ? (plan.recommendedScenarios || []).map((scenario) => ({
          id: `Q-FULL-FOUNDRY-${scenario.id}`,
          coverageKind: "foundry",
          controllerCoverageOnly: true,
          suitePlanId: plan.id,
          scenarioId: scenario.id,
          question: `Use Foundry to verify the ${plan.vector.toLowerCase()} scenario: ${scenario.title}`,
          rationale: plan.rationale,
          expectedEvidence: `A source-bound Foundry property with an AI-reviewed oracle for ${scenario.title}`,
          requiredEvidenceKinds: ["foundry"],
        })) : []);
      item.requiredQuestionIds = scenarioQuestions.map((question) => question.id);
      item.completedQuestionIds = [];
      questions.push(...scenarioQuestions);
      continue;
    }
    questions.push({
      id: `Q-FULL-${item.kind.toUpperCase().replace(/[^A-Z0-9]+/g, "-")}`,
      coverageKind: item.kind,
      controllerCoverageOnly: true,
      question: `Run the complete authorized ${item.kind} coverage class and record whether it completed`,
      rationale: "Full audit depth requires server-accounted coverage for every authorized installed operation class",
      expectedEvidence: `A source-bound completed ${item.kind} operation meeting the server-owned full-coverage scope`,
      requiredEvidenceKinds: [item.kind === "slither" || item.kind === "aderyn" ? "analyzer" : item.kind],
    });
  }
  return questions;
}

function terminalQuestionCount(job) {
  return (job.evidenceReview?.questionResults || []).filter((item) => ["ai-supported", "ai-supported-concern", "accepted-behavior", "developer-decision"].includes(item.status)).length;
}

function updateCoverageObligation(job, operation, execution) {
  const item = job.operationLoop.coverageObligations.find((entry) => entry.kind === operation.kind);
  if (!item) return;
  if (execution.status !== "completed") {
    item.status = operation.kind === "foundry" || operation.kind === "fork"
      ? execution.status === "budget-exhausted" ? "budget-exhausted" : "pending"
      : ["unavailable", "not-authorized", "timed-out", "cancelled"].includes(execution.status) ? execution.status : "failed";
    item.reason = execution.blocker || `${operation.kind} did not complete`; 
    return;
  }
  const scopeComplete = operation.kind === "slither" ? operation.slitherDetectors.length === 0
    : operation.kind === "aderyn" ? operation.aderynSeverity === "all"
      : operation.kind === "compiler-matrix" ? compilerMatrixScopeComplete(job.source, operation.compilerVersions)
        : operation.kind === "foundry" ? recordFoundryFullScopeExecution(item, operation)
        : true;
  item.status = scopeComplete ? "completed" : operation.kind === "foundry" ? "pending" : "failed";
  item.reason = scopeComplete ? "Server-owned full-coverage scope completed" : `The ${operation.kind} operation completed only a partial scope; full coverage remains pending`;
}

function retryableControllerSpecDigests(job, history = []) {
  const unresolved = new Set(unresolvedControllerQuestionIds(job));
  const retryablePlanStates = new Set(["invalid-test", "not-verified", "executed-needs-oracle", "rejected", "timed-out"]);
  const attempts = new Map();
  for (const item of history) {
    if (!["foundry", "fork"].includes(item.kind) || !item.specDigest) continue;
    const list = attempts.get(item.specDigest) || [];
    list.push(item);
    attempts.set(item.specDigest, list);
  }
  return [...attempts.entries()]
    .filter(([, items]) => {
      if (items.length >= 2) return false;
      const latest = items.at(-1);
      if (latest?.status === "failed") return true;
      if (latest?.status !== "completed" || !unresolved.has(latest.questionId)) return false;
      const relatedPlans = (job.ai?.result?.testPlans || []).filter((plan) => plan.followupOperationId === latest.id || (plan.questionIds || []).includes(latest.questionId));
      return !relatedPlans.length || relatedPlans.some((plan) => retryablePlanStates.has(plan.executionStatus)
        || (plan.executionStatus === "failed" && plan.failureKind !== "property-failure"));
    })
    .map(([digest]) => digest);
}

function recordFoundryFullScopeExecution(obligation, operation) {
  obligation.executedQuestionIds ||= [];
  if (!obligation.executedQuestionIds.includes(operation.questionId)) obligation.executedQuestionIds.push(operation.questionId);
  return false;
}

function reconcileFullCoverageAfterAdjudication(job) {
  if (job.auditDepth !== "full") return;
  const foundry = job.operationLoop.coverageObligations.find((item) => item.kind === "foundry");
  if (!foundry || !Array.isArray(foundry.requiredQuestionIds) || !foundry.requiredQuestionIds.length) return;
  const results = new Map((job.evidenceReview?.questionResults || []).map((item) => [item.questionId, item.status]));
  foundry.completedQuestionIds = foundry.requiredQuestionIds.filter((id) => ["ai-supported", "ai-supported-concern"].includes(results.get(id)));
  if (foundry.completedQuestionIds.length === foundry.requiredQuestionIds.length) {
    foundry.status = "completed";
    foundry.reason = `All ${foundry.requiredQuestionIds.length} server-planned Foundry scenario properties executed and received AI-reviewed oracles`;
  } else {
    foundry.status = "pending";
    foundry.reason = `${foundry.completedQuestionIds.length} of ${foundry.requiredQuestionIds.length} server-planned Foundry scenario properties have AI-reviewed execution evidence`;
  }
}

function compilerMatrixScopeComplete(source, versions) {
  const exact = String(source).match(/\bpragma\s+solidity\s+([0-9]+\.[0-9]+\.[0-9]+)\s*;/)?.[1] || null;
  return exact ? versions.length === 1 && versions[0] === exact : new Set(versions).size >= 2;
}

function toolCapability(job, id) {
  return job.capabilities.analyzers.find((item) => item.id === id) || { id, command: id, available: false, version: null };
}

function assessCoverageApplicability(job) {
  const profile = job.aiContractProfile || {};
  const externalDependencies = Array.isArray(profile.externalDependencies) ? profile.externalDependencies.filter(Boolean) : [];
  const concreteTarget = /\bcontract\s+[A-Za-z_$][A-Za-z0-9_$]*(?:\s+is\b|\s*\{)/.test(job.source);
  const hasRuntimeSurface = /\b(?:public|external)\b/.test(job.source);
  const integrationSignals = externalDependencies.length > 0 || /\b(?:oracle|router|pair|factory|bridge|pool|feed|aggregator|chainlink|uniswap|pancake|delegatecall|staticcall|\.call\s*\{|IUniswap)\b/i.test(job.source);
  const exactPragma = /\bpragma\s+solidity\s+[0-9]+\.[0-9]+\.[0-9]+\s*;/.test(job.source);
  return {
    slither: { applicable: true, reason: "Static source analysis applies to Solidity source" },
    aderyn: { applicable: true, reason: "Independent static source analysis applies to Solidity source" },
    "compiler-matrix": exactPragma
      ? { applicable: false, reason: "The source pins one exact Solidity compiler; a compatibility matrix would not add a supported version" }
      : { applicable: true, reason: "A compatible compiler range is declared" },
    foundry: concreteTarget && hasRuntimeSurface
      ? { applicable: true, reason: "A concrete runtime contract exposes behavior suitable for property testing" }
      : { applicable: false, reason: "No concrete callable runtime target exists for Foundry property execution" },
    "anvil-deployment": concreteTarget
      ? { applicable: true, reason: "A concrete compiled contract can be deployed to a disposable local chain" }
      : { applicable: false, reason: "No concrete deployable target exists" },
    "anvil-scenario": concreteTarget && hasRuntimeSurface
      ? { applicable: true, reason: "A concrete runtime contract can be deployed to a disposable local chain" }
      : { applicable: false, reason: "No concrete deployable runtime target exists" },
    fork: integrationSignals
      ? { applicable: true, reason: "The contract depends on external chain state or integrations" }
      : { applicable: false, reason: "No external chain-state dependency was identified, so a fork would not answer a contract-specific question" },
  };
}

function applyCoverageUpdates(obligations, updates = []) {
  for (const update of updates || []) {
    const item = obligations.find((entry) => entry.kind === update.kind && entry.status === "inapplicable");
    if (item && update.status === "inapplicable") item.reason = update.reason || item.reason;
  }
}

function compactFindingForAi(finding) {
  return { id: finding.id, title: finding.title, severity: finding.severity, category: finding.category, location: finding.location, verification: finding.verification, aiReview: finding.aiReview };
}

function normalizeSourceFinding(job, finding, index) {
  const evidence = Array.isArray(finding.evidence) ? finding.evidence : Array.isArray(finding.sourceEvidence) ? finding.sourceEvidence : [];
  const first = evidence[0] || {};
  const location = {
    file: "src/Target.sol",
    lineStart: Number.isInteger(first.lineStart) ? first.lineStart : null,
    lineEnd: Number.isInteger(first.lineEnd) ? first.lineEnd : Number.isInteger(first.lineStart) ? first.lineStart : null,
    contract: first.contract || finding.contract || null,
    function: first.function || finding.function || null,
  };
  if (Number.isInteger(first.sourceStart) && Number.isInteger(first.sourceLength)) {
    location.sourceStart = first.sourceStart;
    location.sourceLength = first.sourceLength;
  }
  const classification = finding.classification || "vulnerability";
  return {
    id: String(finding.id || `AI-SOURCE-${index + 1}`),
    title: String(finding.title || "AI source finding"),
    summary: String(finding.summary || finding.impact || "The AI source review identified a security-relevant behavior."),
    severity: ["critical", "high", "medium", "low", "info"].includes(finding.severity) ? finding.severity : "unknown",
    confidence: ["high", "medium", "low"].includes(finding.confidence) ? finding.confidence : "medium",
    verification: "ai-reviewed",
    category: String(finding.category || "logic"),
    location,
    evidence: evidence.map((item) => ({
      kind: "ai-source-review",
      tool: "codex",
      toolVersion: job.capabilities?.codex?.version || null,
      detectorId: String(finding.id || `AI-SOURCE-${index + 1}`),
      description: String(item.why || item.description || finding.summary || finding.title || "Source-supported AI finding"),
      quote: item.quote || null,
      sourceValidated: item.sourceValidated === true,
      sourceStart: Number.isInteger(item.sourceStart) ? item.sourceStart : null,
      sourceLength: Number.isInteger(item.sourceLength) ? item.sourceLength : null,
      location: { ...location },
    })),
    aiReview: {
      sourceValidated: true,
      verdict: classification === "false-positive" ? "reject" : "likely",
      confidence: ["high", "medium", "low"].includes(finding.confidence) ? finding.confidence : "medium",
      classification,
      rationale: String(finding.rationale || finding.summary || finding.impact || "Validated during whole-contract source review"),
      impact: String(finding.impact || finding.summary || ""),
      trigger: String(finding.trigger || finding.condition || ""),
      action: String(finding.action || finding.recommendation || "Review this behavior before production use."),
      evidence: evidence.map((item) => ({ ...item, sourceValidated: item.sourceValidated === true })),
    },
    testPlans: [],
    origin: "ai-source-review",
  };
}

function compactToolRunForAi(run) {
  return { runId: run.runId, tool: run.tool, operationKind: run.operationKind, questionId: run.questionId, sourceHash: run.sourceHash, status: run.status, version: run.version, timedOut: run.timedOut, error: run.error, outputDigest: run.outputDigest, evidenceEligible: run.evidenceEligible !== false };
}

function compactOperationForAi(item) {
  return { id: item.id, kind: item.kind, questionId: item.questionId, objective: item.objective, status: item.status, specDigest: item.specDigest, evidenceDigest: item.evidenceDigest, blocker: item.blocker };
}

function compactToolRunForDigest(run) {
  return { tool: run.tool, status: run.status, version: run.version, exitCode: run.exitCode, timedOut: run.timedOut, cancelled: run.cancelled, outputDigest: run.outputDigest };
}

async function runFollowup(job, operation) {
  Object.defineProperty(operation, "_rollback", {
    value: captureFollowupState(job),
    enumerable: false,
  });
  operation.status = "running";
  operation.startedAt = now();
  job.followup.status = "running";
  const action = job.followup.actions.find((item) => item.id === operation.actionId);
  activateRecommendedTestingCampaign(job, action);
  if (action) action.status = "running";
  addEvent(job, "followup", "running", operation.tool === "controller" ? "AI-controlled audit resumed" : `Reviewing developer context: ${operation.objective}`);
  await assertSubmittedSourceUnchanged(job);
  if (operation.tool === "developer-context") {
    await runEvidenceVerification(job, { followup: operation });
  } else if (operation.tool === "controller") {
    await runAiControlledAudit(job, { resume: true, isCancelled: () => operation.cancelRequested || job.cancelRequested });
  } else throw copilotError("The requested follow-up path was removed with the fixed pipeline", 409);
  await assertSubmittedSourceUnchanged(job);
  job.evidenceRevision += 1;
  if (action?.recommendedCampaign) job.followup.recommendedCampaignConsumed = true;
  completeFollowupState(job, operation, action);
  refreshFollowupActions(job);
  corroborate(job.findings);
  job.status = deriveFinalStatus(job);
  await settleReportAfterTesting(job, operation.tool === "controller" ? "controller-resume" : "developer-context-followup", operation.id);
  operation.committed = true;
}

function normalizeCampaignPlans(job, operation, questions, value, suppliedCapacity = null) {
  job.testCampaign ||= { generatedTestBudget: 0, plansTruncated: 0 };
  const allowedQuestionIds = new Set(questions.map((question) => question.id));
  const knownFindingIds = new Set(job.findings.map((finding) => finding.id));
  const knownSuiteIds = new Set(job.suitePlan.map((suite) => suite.id));
  const existingSignatures = new Set((job.ai?.result?.testPlans || []).map((plan) => campaignPlanSignature(plan)));
  const seen = new Set(existingSignatures);
  const capacity = suppliedCapacity || controllerCampaignCapacity(job, operation);
  let newSlotsUsed = 0;
  let retrySlotUsed = false;
  const plans = [];
  for (const plan of Array.isArray(value) ? value : []) {
    const questionIds = [...new Set((plan?.questionIds || []).filter((id) => allowedQuestionIds.has(id)))];
    const oracleBindings = normalizeOracleBindings(plan?.oracleBindings, questionIds, plan?.code);
    const signature = campaignPlanSignature(plan);
    if (!questionIds.length || (questionIds.length > 1 && !oracleBindings.length) || seen.has(signature)) continue;
    const correctedRetry = capacity.retryAllowed && !retrySlotUsed && questionIds[0] === operation.questionId;
    if (!correctedRetry && newSlotsUsed >= capacity.remaining) continue;
    seen.add(signature);
    plans.push({
      ...plan,
      id: `AC-${job.evidenceRevision + 1}-${operation.id.slice(0, 8)}-${plans.length + 1}`,
      findingIds: (plan.findingIds || []).filter((id) => knownFindingIds.has(id)),
      suitePlanIds: (plan.suitePlanIds || []).filter((id) => knownSuiteIds.has(id)),
      questionIds,
      oracleBindings,
      executionStatus: "not-run",
      followupOperationId: operation.id,
      operationSpecDigest: operation.specDigest,
    });
    if (correctedRetry) retrySlotUsed = true;
    else newSlotsUsed += 1;
    if (plans.length >= capacity.maxHarnesses) break;
  }
  job.testCampaign.plansTruncated = Number(job.testCampaign.plansTruncated || 0) + Math.max(0, (Array.isArray(value) ? value.length : 0) - plans.length);
  return plans;
}

function controllerCampaignCapacity(job, operation) {
  const budget = Math.max(0, Number(job.testCampaign?.generatedTestBudget || 0));
  const remaining = Math.max(0, budget - effectiveTestPlans(job).length);
  const priorHistory = (job.operationLoop?.history || []).filter((item) => item.id !== operation.id);
  const retryAllowed = ["foundry", "fork"].includes(operation.kind)
    && retryableControllerSpecDigests(job, priorHistory).includes(operation.specDigest);
  return {
    budget,
    remaining,
    retryAllowed,
    maxHarnesses: Math.min(2, remaining + Number(retryAllowed)),
  };
}

function campaignPlanSignature(plan) {
  return JSON.stringify([String(plan?.code || "").replace(/\s+/g, " ").trim(), String(plan?.expectedBehavior || "").trim(), [...(plan?.questionIds || [])].sort()]);
}

function normalizeOracleBindings(value, questionIds, code) {
  const allowedQuestions = new Set(questionIds || []);
  const functions = new Set([...stripSolidityStrings(stripSolidityComments(String(code || ""))).matchAll(/\bfunction\s+((?:test[A-Za-z0-9_]*|invariant_[A-Za-z0-9_]*))\s*\(/g)].map((match) => match[1]));
  const seenFunctions = new Set();
  const bindings = [];
  for (const item of Array.isArray(value) ? value : []) {
    const testFunction = typeof item?.testFunction === "string" ? item.testFunction.trim() : "";
    const boundQuestions = [...new Set((item?.questionIds || []).filter((id) => allowedQuestions.has(id)))];
    if (!functions.has(testFunction) || seenFunctions.has(testFunction) || !boundQuestions.length) return [];
    seenFunctions.add(testFunction);
    bindings.push({ testFunction, questionIds: boundQuestions });
  }
  if (!bindings.length) return [];
  if (seenFunctions.size !== functions.size) return [];
  const covered = new Set(bindings.flatMap((item) => item.questionIds));
  if ([...allowedQuestions].some((id) => !covered.has(id))) return [];
  return bindings;
}

function currentFollowupActions(job, { requiredOnly = false } = {}) {
  return (job.followup?.actions || [])
    .filter((item) => item.evidenceRevision === job.evidenceRevision && item.status === "open" && item.runnable)
    .filter((item) => !requiredOnly || item.required !== false);
}

function isExplicitFollowupRunRequest(value) {
  const text = String(value || "").trim();
  if (!text || /\?$/.test(text) || /^(?:can|could|would|should|what|why|how)\b/i.test(text)) return false;
  return /^(?:(?:please\s+)?run\s+(?:it|this\s+(?:check|test|pass)|that\s+(?:check|test|pass)|the\s+(?:suggested|recommended)\s+(?:check|test|pass))|(?:please\s+)?continue\s+(?:testing|the\s+audit|audit))[.!]?$/i.test(text)
    || /^(?:i\s+)?(?:approve|authorize)\b.*\b(?:further|farther|additional|recommended|focused)?\s*(?:testing|tests?|checks?|campaign|audit)\b[.!]?$/i.test(text)
    || /^(?:yes[, ]+)?(?:please\s+)?(?:run|start|begin|continue|proceed\s+with|go\s+ahead\s+with)\b.*\b(?:testing|tests?|checks?|campaign|audit)\b[.!]?$/i.test(text)
    || /^(?:yes[, ]+)?(?:go\s+ahead|proceed|do\s+it)[.!]?$/i.test(text);
}

function recommendedTestingQuestions(job) {
  const capabilities = new Map(controllerCapabilityCatalog(job.capabilities, job.executionPermissions).map((item) => [item.kind, item]));
  const executableKind = (kind) => {
    if (kind === "foundry") return capabilities.get("foundry")?.executable;
    if (["anvil-deployment", "anvil-observation"].includes(kind)) return capabilities.get("anvil-deployment")?.executable;
    if (kind === "anvil-scenario") return capabilities.get("anvil-scenario")?.executable;
    if (kind === "fork") return capabilities.get("fork")?.executable;
    if (kind === "compiler-matrix") return capabilities.get("compiler-matrix")?.executable;
    if (kind === "analyzer") return capabilities.get("slither")?.executable || capabilities.get("aderyn")?.executable;
    return false;
  };
  return (job.verificationQuestions || [])
    .filter((question) => question.materiality === "optional-assurance")
    .filter((question) => (question.requiredEvidenceKinds || []).some(executableKind))
    .map((question) => ({ ...question, optionalRecommended: true }));
}

function ensureRecommendedTestingAction(job, { force = false } = {}) {
  if (job.auditDepth !== "targeted" || ["queued", "running"].includes(job.followup?.status)) return null;
  const existing = currentFollowupActions(job).find((item) => item.tool === "controller");
  if (existing) return existing;
  if (job.followup.recommendedCampaignConsumed) return null;
  if (!force && job.followup.recommendedCampaignOfferedRevision === job.evidenceRevision) return null;
  const terminal = new Set((job.evidenceReview?.questionResults || [])
    .filter((item) => ["ai-supported", "ai-supported-concern", "accepted-behavior", "developer-decision"].includes(item.status))
    .map((item) => item.questionId));
  const attempted = new Set((job.operationLoop?.history || []).map((item) => item.questionId));
  const candidates = recommendedTestingQuestions(job).filter((item) => !terminal.has(item.id) && !attempted.has(item.id));
  if (!candidates.length) return null;
  job.operationLoop.coverageQuestions = mergeStableVerificationQuestions(job.operationLoop.coverageQuestions || [], candidates);
  const action = {
    id: randomUUID(), evidenceRevision: job.evidenceRevision, questionId: null,
    questionIds: candidates.map((item) => item.id),
    tool: "controller",
    objective: "Run the AI-selected optional verification checks",
    reason: "The selected-scope opinion is complete; the AI identified specific runtime evidence that can provide stronger assurance.",
    networkId: null,
    runnable: true, status: "open", required: false, recommendedCampaign: true,
  };
  job.followup.actions.push(action);
  job.followup.recommendedCampaignOffered = true;
  job.followup.recommendedCampaignOfferedRevision = job.evidenceRevision;
  return action;
}

function activateRecommendedTestingCampaign(job, action) {
  if (action?.tool !== "controller" || !(action.questionIds || []).length) return;
  job.operationLoop.prematureConclusionCount = 0;
  job.operationLoop.approvedTestingCampaign = {
    actionId: action.id,
    questionIds: [...new Set(action.questionIds || [])],
    status: "active",
    startedHistoryLength: job.operationLoop.history.length,
    authorizedAt: now(),
  };
}

function approvedTestingQuestionIds(job) {
  const campaign = job.operationLoop?.approvedTestingCampaign;
  return campaign?.status === "active" ? campaign.questionIds || [] : [];
}

function materializeControllerQuestion(job, questionId) {
  if (job.verificationQuestions.some((item) => item.id === questionId)) return;
  const question = (job.operationLoop?.coverageQuestions || []).find((item) => item.id === questionId);
  if (!question) return;
  job.verificationQuestions = mergeStableVerificationQuestions(job.verificationQuestions, [question]);
  if (job.ai?.result) job.ai.result.verificationQuestions = structuredClone(job.verificationQuestions);
}

function completeFollowupState(job, operation, action) {
  operation.status = "completed";
  operation.error = null;
  operation.finishedAt = now();
  if (action) action.status = "consumed";
  job.followup.status = "idle";
  job.followup.active = null;
  addEvent(job, "followup", "completed", `AI-controlled audit continuation completed; conclusion revised to evidence revision ${job.evidenceRevision}`);
  operation.completionEventId = job.worklog.at(-1)?.id || null;
}

function captureFollowupState(job) {
  return {
    evidenceRevision: job.evidenceRevision,
    evidenceReview: structuredClone(job.evidenceReview),
    testPlans: structuredClone(job.ai?.result?.testPlans || []),
    campaign: structuredClone(job.testCampaign),
    suitePlan: structuredClone(job.suitePlan),
    findings: structuredClone(job.findings),
    auditSynthesis: structuredClone(job.auditSynthesis),
    reportMarkdown: job.reportMarkdown,
    reportState: structuredClone(job.reportState),
    reportRevisions: structuredClone(job.reportRevisions),
    followupActions: structuredClone(job.followup.actions),
    toolRuns: structuredClone(job.toolRuns),
    stages: structuredClone(job.stages),
    anvil: structuredClone(job.anvil),
    developerDeploymentPlan: structuredClone(job.developerDeploymentPlan),
    operationLoop: structuredClone(job.operationLoop),
    status: job.status,
    worklog: structuredClone(job.worklog),
  };
}

function rollbackFollowupState(job, operation) {
  const rollback = operation?._rollback;
  if (!rollback || operation.committed) return;
  job.evidenceRevision = rollback.evidenceRevision;
  job.evidenceReview = structuredClone(rollback.evidenceReview);
  if (job.ai?.result) job.ai.result.testPlans = structuredClone(rollback.testPlans);
  job.testCampaign = structuredClone(rollback.campaign);
  job.suitePlan = structuredClone(rollback.suitePlan);
  job.findings = structuredClone(rollback.findings);
  job.auditSynthesis = structuredClone(rollback.auditSynthesis);
  job.reportMarkdown = rollback.reportMarkdown;
  job.reportState = structuredClone(rollback.reportState);
  job.reportRevisions = structuredClone(rollback.reportRevisions);
  job.followup.actions = structuredClone(rollback.followupActions);
  job.toolRuns = structuredClone(rollback.toolRuns);
  job.stages = structuredClone(rollback.stages);
  job.anvil = structuredClone(rollback.anvil);
  job.developerDeploymentPlan = structuredClone(rollback.developerDeploymentPlan);
  job.operationLoop = structuredClone(rollback.operationLoop);
  job.status = rollback.status;
  if (Array.isArray(rollback.worklog)) job.worklog = structuredClone(rollback.worklog);
}

function refreshFollowupActions(job, { suppressRecommendedCampaign = false } = {}) {
  for (const item of job.followup.actions) if (item.status === "open") item.status = "stale";
  const unresolved = unresolvedControllerQuestionIds(job);
  const questionById = new Map((job.verificationQuestions || []).map((item) => [item.id, item]));
  const pendingCoverageQuestionIds = job.auditDepth === "full"
    ? (job.operationLoop?.coverageQuestions || []).filter((question) => job.operationLoop.coverageObligations.some((item) => item.kind === question.coverageKind && item.status === "pending")).map((item) => item.id)
    : [];
  const requiredQuestionIds = [...new Set([
    ...unresolved.filter((id) => job.auditDepth === "full" || questionById.get(id)?.materiality === "required-for-opinion"),
    ...pendingCoverageQuestionIds,
  ])];
  const optionalQuestionIds = unresolved.filter((id) => !requiredQuestionIds.includes(id));
  const newContext = (job.developerEvidence || []).some((item) => item.kind === "audit-context" && item.evidenceRevision === job.evidenceRevision);
  const newDeploymentConfiguration = (job.developerEvidence || []).some((item) => item.kind === "deployment-configuration" && item.evidenceRevision === job.evidenceRevision);
  const operationCapReached = (job.operationLoop?.evidenceLedger || []).length >= 64;
  const resumable = !operationCapReached && (job.operationLoop?.status === "evidence-exhausted" || ["blocked", "needs-input"].includes(job.operationLoop?.status));
  const canRunNow = job.operationLoop?.status === "evidence-exhausted" || newContext || newDeploymentConfiguration || job.operationLoop?.status === "blocked";
  if (requiredQuestionIds.length && resumable && canRunNow) {
    job.followup.actions.push({
      id: randomUUID(), evidenceRevision: job.evidenceRevision, questionId: null,
      questionIds: requiredQuestionIds,
      tool: "controller",
      objective: "Continue the AI-controlled audit from the preserved evidence ledger",
      reason: job.operationLoop.stopReason || "Opinion-critical evidence remains unresolved",
      networkId: null,
      runnable: true, status: "open", required: true,
    });
  }
  if (!requiredQuestionIds.length && optionalQuestionIds.length && resumable && canRunNow) {
    job.followup.actions.push({
      id: randomUUID(), evidenceRevision: job.evidenceRevision, questionId: null,
      questionIds: optionalQuestionIds,
      tool: "controller",
      objective: "Run optional recommended verification for stronger assurance",
      reason: "The selected-scope AI opinion is available; these checks are optional stronger assurance.",
      networkId: null,
      runnable: true, status: "open", required: false,
    });
  }
  if (!suppressRecommendedCampaign && !currentFollowupActions(job).length && job.operationLoop?.status === "completed") ensureRecommendedTestingAction(job);
}

async function settleReportAfterTesting(job, trigger, operationId = null) {
  if (job.operationLoop?.status === "needs-input") {
    job.reportMarkdown = null;
    job.reportState = {
      status: "awaiting-input",
      reason: job.operationLoop.stopReason || "The AI auditor needs specific information before it can continue",
      finalizedAt: null,
      finalizedBy: null,
    };
    job.auditSynthesis = { status: "pending-input", answer: null, citations: [], suggestedNextSteps: [], error: null };
    stage(job, "report", "skipped", "The AI auditor requested specific information before completing its opinion");
    return;
  }
  const reason = "AI auditor completed the selected engagement and authored the audit opinion";
  await publishFinalFindings(job, { trigger, operationId, finalizedBy: "automatic", reason });
}

async function publishFinalFindings(job, { trigger, operationId = null, finalizedBy, reason }) {
  if (["queued", "running"].includes(job.followup?.status)) throw copilotError("Targeted testing is still active", 409);
  job.reportState = { status: "publishing", reason, finalizedAt: null, finalizedBy };
  const publicationEvidenceRevision = job.evidenceRevision;
  try {
    await assertSubmittedSourceUnchanged(job);
  } catch (error) {
    job.reportState = { status: "failed", reason: `Findings were not published because source integrity failed: ${error.message}`, finalizedAt: null, finalizedBy, retryable: false };
    job.reportMarkdown = null;
    stage(job, "report", "failed", job.reportState.reason);
    throw error;
  }
  try {
    const completedAt = now();
    const completedProjection = projectCompletedArtifactJob(job, job.status, finalReportCompletionMessage(job), completedAt);
    const artifactJob = {
      ...completedProjection,
      copilot: structuredClone(job.copilot),
      auditSynthesis: structuredClone(job.auditSynthesis),
      reportState: { status: "ready", reason, finalizedAt: completedAt, finalizedBy },
      reportRevisions: [...job.reportRevisions],
      updatedAt: completedAt,
    };
    const presentation = buildReviewPresentation(artifactJob);
    await runFinalSynthesis(artifactJob, presentation, artifactJob.status);
    artifactJob.reportMarkdown = renderFindingsMarkdown(artifactJob);
    const revisionNumber = artifactJob.reportRevisions.length + 1;
    const revision = { revision: revisionNumber, evidenceRevision: artifactJob.evidenceRevision, at: completedAt, trigger, operationId, markdown: artifactJob.reportMarkdown, snapshot: null };
    artifactJob.reportRevisions.push(revision);
    revision.snapshot = structuredClone(publicJob(artifactJob));
    if (job.evidenceRevision !== publicationEvidenceRevision || job.copilot?.status === "running" || ["queued", "running"].includes(job.followup?.status)) {
      throw new Error("Audit evidence changed while findings were being prepared; publication must be retried from the latest revision");
    }
    await writePublishedArtifacts(artifactJob, revision);
    // Persist the complete projection before exposing `ready` through getJob.
    // Otherwise a browser poll can observe readiness while state.json still
    // contains the prior publishing/waiting state and revive it on restart.
    if (jobStore) await jobStore.saveState(job.id, durableJobSnapshot(artifactJob));
    job.stages = artifactJob.stages;
    job.worklog = artifactJob.worklog;
    job.copilot = artifactJob.copilot;
    job.auditSynthesis = artifactJob.auditSynthesis;
    job.reportState = artifactJob.reportState;
    job.reportMarkdown = artifactJob.reportMarkdown;
    job.reportRevisions = artifactJob.reportRevisions;
    job.updatedAt = artifactJob.updatedAt;
  } catch (error) {
    job.reportState = { status: "failed", reason: `Findings publication failed: ${error.message}`, finalizedAt: null, finalizedBy, retryable: true };
    job.reportMarkdown = null;
    stage(job, "report", "failed", job.reportState.reason);
    throw error;
  }
}

function finalReportCompletionMessage(job) {
  const runtimeEvidence = runtimeVerificationCompleted(job);
  if (runtimeEvidence) return "Final findings generated after the selected runtime verification completed";
  if (job.auditDepth === "review") return "Final findings generated after the AI source review completed; no executable testing was selected";
  return "Final findings generated from source review and available analyzer evidence; no runtime property test was executed";
}

function runtimeVerificationCompleted(job) {
  return (job.toolRuns || []).some((run) => run.status === "completed"
    && /^(?:forge-generated:|forge-fork:|anvil-scenario|anvil-deployment)/.test(String(run.tool || "")));
}

async function runFinalSynthesis(job, presentation, finalStatus) {
  const finalDecision = [...(job.operationLoop?.decisions || [])].reverse().find((item) => item.status !== "continue");
  const answer = String(finalDecision?.assessment || job.operationLoop?.stopReason || "").trim();
  if (!answer) throw new Error("The AI auditor reached a terminal state without returning an audit opinion");
  job.auditSynthesis = { status: "completed", basis: "ai-auditor", answer, citations: [], relatedFindingIds: [], suggestedNextSteps: [], error: null };
  job.copilot.messages.push({ id: randomUUID(), at: now(), role: "assistant", kind: "conclusion", text: answer, citations: [], suggestedNextSteps: [] });
  addEvent(job, "synthesis", "completed", "AI auditor's terminal assessment published as the audit conclusion");
}

async function runAnvilStage(job, deploymentPlan = null, isCancelled = () => job.cancelRequested, scenario = null, operation = null) {
  const anvilTool = scenario ? "anvil-scenario" : "anvil-deployment";
  if (!job.executionPermissions?.anvil) {
    addEvent(job, "operation-loop", "not-authorized", "Disposable Anvil execution was not authorized");
    return;
  }
  const capability = job.capabilities.analyzers.find((tool) => tool.id === "anvil");
  if (!capability?.available) {
    job.anvil = { requested: true, status: "unavailable", reason: "Anvil is not installed" };
    job.toolRuns.push(withOperationProvenance(skippedRun(anvilTool, capability?.version, job.anvil.reason), job, operation));
    addEvent(job, "operation-loop", "unavailable", job.anvil.reason);
    return;
  }
  if (!job.toolRuns.some((item) => ["forge-bootstrap", "compiler-matrix"].includes(item.tool) && item.status === "completed")) {
    job.anvil = { requested: true, status: "skipped", reason: "Foundry compilation did not complete" };
    job.toolRuns.push(withOperationProvenance(skippedRun(anvilTool, capability.version, job.anvil.reason), job, operation));
    addEvent(job, "operation-loop", "skipped", job.anvil.reason);
    return;
  }
  addEvent(job, "operation-loop", "checkpoint", deploymentPlan ? "Validating the AI deployment fixture and launching a disposable loopback chain" : "Launching a disposable loopback chain with deterministic target selection");
  try {
    const result = await runFreshAnvilDeployment({ jobDir: job.jobDir, anvilCommand: capability.command || "anvil", deploymentPlan, scenario, isCancelled });
    const inputRequired = result.status === "unsupported" && deploymentPlan?.decision === "needs-input";
    const normalizedStatus = result.status === "unsupported" ? (inputRequired ? "needs-input" : "failed") : result.status;
    job.anvil = { requested: true, ...result, status: normalizedStatus, inputRequired };
    if (result.status === "completed") {
      if (job.developerDeploymentPlan?.status === "approved"
        && sourceHash(JSON.stringify(job.developerDeploymentPlan.plan)) === sourceHash(JSON.stringify(result.effectiveDeploymentPlan || deploymentPlan || null))) {
        job.developerDeploymentPlan.status = "completed";
        job.developerDeploymentPlan.completedAt = now();
        job.developerDeploymentPlan.transactionHash = result.transactionHash;
        job.developerDeploymentPlan.contractAddress = result.contractAddress;
      }
      const normalizedEvidence = {
        status: "completed",
        chainId: result.chainId,
        contract: result.contract,
        contractAddress: result.contractAddress,
        deployer: result.deployer,
        transactionHash: result.transactionHash,
        codeSha256: result.codeSha256,
        artifactSha256: result.artifactSha256 || null,
        deploymentReceipt: structuredClone(result.deploymentReceipt || null),
        observations: structuredClone(result.observations || []),
        scenario: structuredClone(result.scenario || null),
        deploymentPlanDigest: sourceHash(JSON.stringify(result.effectiveDeploymentPlan || deploymentPlan || null)),
      };
      const scenarioExecutionFailed = result.scenario?.status === "failed";
      const scenarioFoundConcern = result.scenario?.status === "property-failure";
      job.toolRuns.push(withOperationProvenance({ tool: anvilTool, version: capability.version, status: scenarioExecutionFailed ? "failed" : "completed", exitCode: scenarioExecutionFailed ? 1 : 0, timedOut: false, truncated: false, commandSummary: scenario ? "anvil typed ABI scenario (loopback endpoint redacted)" : "anvil disposable deployment (loopback endpoint redacted)", error: scenarioExecutionFailed ? "One or more typed scenario steps could not execute" : null, contractOutcome: scenarioFoundConcern ? "expectation-mismatch-awaiting-ai-review" : "expected", environment: result.environment, chainId: result.chainId, contractAddress: result.contractAddress, transactionHash: result.transactionHash, codeSha256: result.codeSha256, normalizedEvidence }, job, operation));
      addEvent(job, "operation-loop", scenarioExecutionFailed ? "failed" : scenarioFoundConcern ? "evidence" : "completed", scenarioFoundConcern ? `Disposable Anvil scenario observed behavior that contradicted the planned expectation for ${result.contract}; AI review is required` : `Disposable Anvil ${scenario ? "scenario" : "deployment"} finished for ${result.contract}; receipt and bytecode verified`);
    } else {
      if (job.developerDeploymentPlan?.status === "approved") {
        job.developerDeploymentPlan.status = "proposed";
        job.developerDeploymentPlan.lastError = result.reason || "Disposable deployment did not complete";
      }
      if (normalizedStatus === "failed") {
        job.toolRuns.push(withOperationProvenance({ tool: anvilTool, version: capability.version, status: "failed", exitCode: null, timedOut: false, truncated: false, commandSummary: scenario ? "anvil typed ABI scenario validation" : "anvil disposable deployment validation", error: result.reason, failureKind: result.failureKind || (scenario ? "scenario-validation" : "deployment-validation") }, job, operation));
        addEvent(job, "operation-loop", "failed", `Anvil operation could not execute: ${result.reason}`);
      } else {
        job.toolRuns.push(withOperationProvenance(skippedRun(anvilTool, capability.version, result.reason), job, operation));
        addEvent(job, "operation-loop", "skipped", `Anvil operation needs input: ${result.reason}`);
      }
    }
  } catch (error) {
    if (job.developerDeploymentPlan?.status === "approved") {
      job.developerDeploymentPlan.status = "proposed";
      job.developerDeploymentPlan.lastError = error.message;
    }
    if (error.code === "AUDIT_CANCELLED") throw error;
    job.anvil = { requested: true, status: "failed", reason: error.message };
    job.toolRuns.push(withOperationProvenance({ tool: anvilTool, version: capability.version, status: "failed", exitCode: null, timedOut: /timed out/i.test(error.message), truncated: false, commandSummary: scenario ? "anvil typed ABI scenario (loopback endpoint redacted)" : "anvil disposable deployment (loopback endpoint redacted)", error: error.message }, job, operation));
    addEvent(job, "operation-loop", "failed", `Fresh Anvil operation failed: ${error.message.slice(0, 240)}`);
  }
}

async function prepareJob(job) {
  await mkdir(path.join(job.jobDir, "src"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(job.jobDir, "test-support"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(job.jobDir, "artifacts"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(job.jobDir, ".tool-home", ".config"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(job.jobDir, ".tool-home", ".cache"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(job.jobDir, "src", "Target.sol"), job.source, { mode: 0o600 });
  await chmod(path.join(job.jobDir, "src", "Target.sol"), 0o400);
  await writeFile(path.join(job.jobDir, "test-support", "AttestTest.sol"), ATTEST_TEST_SUPPORT, { mode: 0o400 });
  const config = [
    "[profile.default]",
    'src = "src"',
    'out = "out"',
    'libs = ["lib"]',
    "optimizer = true",
    "optimizer_runs = 200",
    "auto_detect_solc = true",
    "offline = false",
    "build_info = true",
    "",
    "[fuzz]",
    `runs = ${job.testCampaign.fuzzRuns}`,
    "",
    "[invariant]",
    `runs = ${job.testCampaign.invariantRuns}`,
    `depth = ${job.testCampaign.invariantDepth}`,
    "",
    "[rpc_endpoints]",
    'attest_followup = "${ATTEST_FORK_RPC}"',
    "",
  ].join("\n");
  await writeFile(path.join(job.jobDir, "foundry.toml"), config, { mode: 0o600 });
  if (/\bimport\s+["'{]/.test(job.source)) {
    job.limitations.unshift("Imports were detected; this single-file MVP does not download or trust dependencies automatically.");
    addEvent(job, "intake", "warning", "Import statements detected; dependency resolution may fail");
  }
}

async function runForge(job, capability, options = {}) {
  const stageId = options.stageId === undefined ? "compile" : options.stageId;
  if (stageId) stage(job, stageId, "running", "Running offline Foundry compilation");
  let compilerResolution = "cached-offline";
  const deadline = Number.isFinite(options.deadline) ? options.deadline : Date.now() + 120_000;
  const timeout = (cap) => Math.max(1_000, Math.min(cap, deadline - Date.now()));
  let result = await runCommand(capability.command || "forge", foundryBuildArgs(job.jobDir, { offline: true }), {
    cwd: job.jobDir,
    timeoutMs: timeout(60_000),
    env: foundryEnvironment(job.jobDir),
    isCancelled: options.isCancelled,
  });
  if (result.exitCode !== 0 && isCompilerUnavailable(result)) {
    const missSuffix = stageId || "bootstrap";
    await writeFile(path.join(job.jobDir, "artifacts", `forge-${missSuffix}-offline-miss.stdout.txt`), result.stdout);
    await writeFile(path.join(job.jobDir, "artifacts", `forge-${missSuffix}-offline-miss.stderr.txt`), result.stderr);
    compilerResolution = "foundry-download-fallback";
    addEvent(job, "intake", "checkpoint", "No cached Solidity compiler matched this source; allowing Foundry to fetch the exact compiler version");
    result = await runCommand(capability.command || "forge", foundryBuildArgs(job.jobDir, { offline: false }), {
      cwd: job.jobDir,
      timeoutMs: timeout(120_000),
      env: foundryEnvironment(job.jobDir, { allowCompilerDownload: true }),
      isCancelled: options.isCancelled,
    });
  }
  const metadataOnly = stageId === null && options.evidenceEligible === false;
  const compilerUnavailable = result.exitCode !== 0 && isCompilerUnavailable(result);
  const status = metadataOnly && compilerUnavailable ? "skipped" : result.timedOut ? "timed-out" : result.exitCode === 0 ? "completed" : "failed";
  const run = withOperationProvenance(toToolRun(options.toolName || "forge", capability.version, status, result), job, options.operation || null);
  run.evidenceEligible = options.evidenceEligible !== false;
  run.resolvedCompiler = (result.stdout + "\n" + result.stderr).match(/\bSolc\s+([0-9]+\.[0-9]+\.[0-9]+)/i)?.[1] ?? null;
  run.compilerResolution = compilerResolution;
  if (compilerUnavailable) {
    run.compilerUnavailable = true;
    run.error = compilerUnavailableReason(job);
    if (metadataOnly) disableCompileDependentExecution(job, run.error);
  } else if (status === "completed") {
    job.compilerAvailability = { status: "available", requirement: declaredCompilerRequirement(job.source), reason: null, resolvedCompiler: run.resolvedCompiler, resolution: compilerResolution };
  }
  job.toolRuns.push(run);
  await writeFile(path.join(job.jobDir, "artifacts", "forge.stdout.txt"), result.stdout);
  await writeFile(path.join(job.jobDir, "artifacts", "forge.stderr.txt"), result.stderr);
  if (stageId) stage(job, stageId, status, status === "completed" ? "Foundry compilation completed" : compilerUnavailable ? run.error : conciseFailure("Foundry compilation", result));
  else if (metadataOnly && compilerUnavailable) addEvent(job, "intake", "warning", run.error);
  else addEvent(job, "intake", status, status === "completed" ? "Compiler metadata build completed" : conciseFailure("Foundry metadata build", result));
  return run;
}

async function runSlither(job, capability, options = {}) {
  const operation = options.operation || null;
  const args = [".", "--json", "-", "--exclude-dependencies", "--fail-none"];
  if (options.detectors?.length) args.push("--detect", options.detectors.join(","));
  addEvent(job, "operation-loop", "checkpoint", `Running Slither${options.detectors?.length ? ` with ${options.detectors.length} AI-selected detector(s)` : " with its complete detector set"}`);
  const result = await runCommand(capability.command || "slither", args, {
    cwd: job.jobDir,
    timeoutMs: Number.isFinite(options.deadline) ? Math.max(1_000, Math.min(120_000, options.deadline - Date.now())) : 120_000,
    env: analysisEnvironment(job.jobDir),
    isCancelled: options.isCancelled,
  });
  if (options.isCancelled?.()) throwIfControllerCancelled(job, options.isCancelled);
  let status = result.timedOut ? "timed-out" : "failed";
  let parseError = null;
  let parsedSuccessfully = false;
  let normalized = [];
  try {
    normalized = normalizeSlitherOutput(result.stdout, capability.version).filter(inSealedSource);
    for (const finding of normalized) bindFindingToOperation(finding, job, operation);
    job.findings.push(...normalized);
    parsedSuccessfully = true;
  } catch (error) {
    parseError = error.message;
  }
  if (parsedSuccessfully && result.exitCode === 0 && !result.signal && !result.timedOut && !result.truncated) status = "completed";
  const run = withOperationProvenance({ ...toToolRun("slither", capability.version, status, result), parseError, findingCount: normalized.length }, job, operation);
  job.toolRuns.push(run);
  const suffix = safeArtifactSuffix(operation?.id || "initial");
  await writeFile(path.join(job.jobDir, "artifacts", `slither-${suffix}.stdout.txt`), result.stdout);
  await writeFile(path.join(job.jobDir, "artifacts", `slither-${suffix}.stderr.txt`), result.stderr);
  addEvent(job, "operation-loop", status, status === "completed" ? `Slither produced ${normalized.length} source-scoped finding(s)` : conciseFailure("Slither", result, parseError));
  return run;
}

async function runAderyn(job, capability, options = {}) {
  const operation = options.operation || null;
  addEvent(job, "operation-loop", "checkpoint", `Running checksum-pinned Aderyn${options.severity === "high" ? " for high-severity signals" : " with its complete detector set"}`);
  const suffix = safeArtifactSuffix(operation?.id || "initial");
  const reportPath = path.join(job.jobDir, "artifacts", `aderyn-${suffix}.json`);
  const args = [".", "-o", reportPath];
  if (options.severity === "high") args.push("--highs-only");
  const result = await runCommand(capability.command, args, {
    cwd: job.jobDir,
    timeoutMs: Number.isFinite(options.deadline) ? Math.max(1_000, Math.min(120_000, options.deadline - Date.now())) : 120_000,
    env: analysisEnvironment(job.jobDir),
    isCancelled: options.isCancelled,
  });
  if (options.isCancelled?.()) throwIfControllerCancelled(job, options.isCancelled);
  let status = result.timedOut ? "timed-out" : "failed";
  let parseError = null;
  let findings = [];
  try {
    const reportStat = await stat(reportPath);
    if (reportStat.size > 5_000_000) throw new Error("Aderyn report exceeded the 5 MB evidence limit");
    findings = normalizeAderynReport(await readFile(reportPath, "utf8"), capability.version).filter(inSealedSource).slice(0, 500);
    for (const finding of findings) bindFindingToOperation(finding, job, operation);
  } catch (error) {
    parseError = error.message;
  }
  if (!parseError && result.exitCode === 0 && !result.signal && !result.timedOut && !result.truncated) {
    status = "completed";
    job.findings.push(...findings);
  }
  const run = withOperationProvenance({ ...toToolRun("aderyn", capability.version, status, result), parseError, findingCount: findings.length }, job, operation);
  job.toolRuns.push(run);
  await writeFile(path.join(job.jobDir, "artifacts", `aderyn-${suffix}.stdout.txt`), result.stdout);
  await writeFile(path.join(job.jobDir, "artifacts", `aderyn-${suffix}.stderr.txt`), result.stderr);
  addEvent(job, "operation-loop", status, status === "completed" ? `Aderyn produced ${findings.length} source-scoped finding(s)` : conciseFailure("Aderyn", result, parseError));
  return run;
}

async function runCompilerMatrix(job, operation, deadline, isCancelled) {
  const capability = toolCapability(job, "forge");
  const details = [];
  const artifactRoot = path.join(job.jobDir, "artifacts", `compiler-matrix-${safeArtifactSuffix(operation.id)}`);
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  for (const version of operation.compilerVersions) {
    if (isCancelled()) throwIfControllerCancelled(job, isCancelled);
    if (Date.now() >= deadline) break;
    const versionId = version.replaceAll(".", "-");
    const extraArgs = ["--use", version, "--force", "--skip", "test", "--out", `out-matrix/${versionId}`, "--cache-path", `cache-matrix/${versionId}`];
    let compilerResolution = "cached-offline";
    let result = await runCommand(capability.command || "forge", foundryBuildArgs(job.jobDir, { offline: true, extra: extraArgs }), {
      cwd: job.jobDir,
      timeoutMs: Math.max(1_000, Math.min(60_000, deadline - Date.now())),
      maxOutputBytes: 750_000,
      env: foundryEnvironment(job.jobDir),
      isCancelled,
    });
    if (isCancelled()) throwIfControllerCancelled(job, isCancelled);
    if (result.exitCode !== 0 && isCompilerUnavailable(result) && Date.now() < deadline) {
      compilerResolution = "foundry-download-fallback";
      addEvent(job, "operation-loop", "checkpoint", `No cached Solidity ${version} compiler was available; allowing Foundry to fetch it for the matrix check`);
      result = await runCommand(capability.command || "forge", foundryBuildArgs(job.jobDir, { offline: false, extra: extraArgs }), {
        cwd: job.jobDir,
        timeoutMs: Math.max(1_000, Math.min(120_000, deadline - Date.now())),
        maxOutputBytes: 750_000,
        env: foundryEnvironment(job.jobDir, { allowCompilerDownload: true }),
        isCancelled,
      });
      if (isCancelled()) throwIfControllerCancelled(job, isCancelled);
    }
    const status = result.timedOut ? "timed-out" : result.exitCode === 0 ? "completed" : "failed";
    details.push({ version, status, exitCode: result.exitCode, timedOut: result.timedOut, compilerResolution, outputDigest: sourceHash(`${result.stdout}\n${result.stderr}`), error: result.error || (status === "failed" ? conciseFailure(`Solidity ${version}`, result) : null) });
    await writeFile(path.join(artifactRoot, `${versionId}.stdout.txt`), result.stdout);
    await writeFile(path.join(artifactRoot, `${versionId}.stderr.txt`), result.stderr);
  }
  const status = details.length === operation.compilerVersions.length && details.every((item) => item.status === "completed") ? "completed" : details.some((item) => item.status === "timed-out") ? "timed-out" : "failed";
  const run = withOperationProvenance({
    tool: "compiler-matrix",
    version: capability.version,
    status,
    exitCode: status === "completed" ? 0 : 1,
    timedOut: status === "timed-out",
    truncated: false,
    commandSummary: `forge build --offline against ${operation.compilerVersions.length} AI-selected installed-version profile(s)`,
    error: status === "completed" ? null : "One or more requested offline compiler profiles were unavailable or failed",
    profiles: details,
  }, job, operation);
  job.toolRuns.push(run);
  return run;
}

async function runAiReview(job) {
  const preservedControllerPlans = structuredClone(job.ai?.result?.testPlans || []);
  if (!job.capabilities.codex.available || !job.codex) {
    job.ai.status = "unavailable";
    job.ai.error = "Codex app-server is unavailable";
    addEvent(job, "operation-loop", "failed", job.ai.error);
    return;
  }
  addEvent(job, "operation-loop", "checkpoint", "AI auditor is interpreting normalized analyzer evidence against the whole contract");
  job.ai.status = "running";
  try {
    const deploymentArtifacts = await inspectDeploymentArtifacts(job.jobDir);
    job.deploymentArtifacts = deploymentArtifacts;
    const result = await job.codex.review({
      jobDir: job.jobDir,
      source: job.source,
      sourceHash: job.sourceHash,
      auditDepth: job.auditDepth,
      findings: job.findings,
      toolRuns: job.toolRuns,
      contractProfile: job.contractProfile,
      suitePlan: job.suitePlan,
      declaredContext: job.declaredContext,
      testCampaign: job.testCampaign,
      deploymentArtifacts,
      initialContractModel: job.aiProfile?.status === "completed" ? job.aiProfile.result : null,
      generateTests: false,
      onProgress: async ({ review, progress, message }) => {
        job.ai.progress = progress;
        job.ai.result = validateAiResult(job, review);
        job.sourceConclusions = mergeSourceConclusions(job.sourceConclusions, job.ai.result.sourceConclusions);
        mergeNewSourceFindings(job, job.ai.result.sourceFindings);
        mergeAiReview(job);
        const reviewStage = job.stages.find((item) => item.id === "ai-review");
        if (reviewStage) reviewStage.message = message;
        addEvent(job, "ai-review", "checkpoint", message, progress);
      },
      onReviewComplete: async (review) => {
        const validatedReview = validateAiResult(job, structuredClone(review));
        job.sourceConclusions = mergeSourceConclusions(job.sourceConclusions, validatedReview.sourceConclusions);
        mergeNewSourceFindings(job, validatedReview.sourceFindings);
        const sourceValidated = validatedReview.reviewedFindings.filter((item) => item.sourceValidated).length;
        const manualReview = Math.max(0, job.findings.length - sourceValidated);
        addEvent(job, "operation-loop", "reviewed", `AI reviewed analyzer evidence: ${sourceValidated} source-supported; ${manualReview} still require judgment`);
        job.aiDeploymentPlan = validatedReview.deploymentPlan || null;
      },
    });
    job.ai.result = validateAiResult(job, result);
    job.ai.result.testPlans = mergeTestPlans(preservedControllerPlans, job.ai.result.testPlans);
    job.aiContractProfile = job.ai.result.contractProfile || null;
    job.sourceConclusions = mergeSourceConclusions(job.sourceConclusions, job.ai.result.sourceConclusions);
    mergeNewSourceFindings(job, job.ai.result.sourceFindings);
    job.aiSuitePlan = job.ai.result.suitePlan || [];
    job.aiDeploymentPlan = job.ai.result.deploymentPlan || job.aiDeploymentPlan;
    job.verificationQuestions = mergeStableVerificationQuestions(job.verificationQuestions, job.ai.result.verificationQuestions);
    job.ai.result.verificationQuestions = structuredClone(job.verificationQuestions);
    job.ai.status = "completed";
    mergeAiReview(job);
  } catch (error) {
    if (job.cancelRequested) throw cancelledError("Audit cancelled by user");
    if (["AUDIT_CANCELLED", "FOLLOWUP_CANCELLED"].includes(error?.code)) throw error;
    job.ai.status = "failed";
    job.ai.error = error.message;
    addEvent(job, "operation-loop", "failed", `AI analyzer interpretation did not complete: ${error.message}`);
  }
}

function mergeTestPlans(existing, incoming) {
  const byId = new Map((existing || []).map((item) => [item.id, item]));
  for (const item of incoming || []) if (!byId.has(item.id)) byId.set(item.id, item);
  return [...byId.values()];
}

function mergeStableVerificationQuestions(existing, incoming) {
  const stable = new Map((existing || []).map((item) => [item.id, structuredClone(item)]));
  for (const item of incoming || []) if (item?.id && !stable.has(item.id)) stable.set(item.id, structuredClone(item));
  return [...stable.values()];
}

async function runAiProfile(job) {
  if (!job.capabilities.codex.available || !job.codex) {
    job.aiProfile = { status: "unavailable", error: "Codex app-server is unavailable" };
    stage(job, "ai-profile", "skipped", job.aiProfile.error);
    return;
  }
  stage(job, "ai-profile", "running", "Building the whole-contract model and contract-specific verification questions before analyzer triage");
  job.aiProfile = { status: "running", error: null };
  try {
    const deploymentArtifacts = await inspectDeploymentArtifacts(job.jobDir);
    job.deploymentArtifacts = deploymentArtifacts;
    const result = await runWithAiRetry(job, "whole-contract source review", () => job.codex.profile({
      jobDir: job.jobDir,
      source: job.source,
      sourceHash: job.sourceHash,
      auditDepth: job.auditDepth,
      contractProfile: job.contractProfile,
      suitePlan: job.suitePlan,
      declaredContext: job.declaredContext,
      testCampaign: job.testCampaign,
      deploymentArtifacts,
    }));
    const normalizedQuestions = normalizeVerificationQuestions(result.verificationQuestions);
    result.sourceConclusions = normalizeSourceConclusions(job.source, result.sourceConclusions, new Set(normalizedQuestions.map((question) => question.id)));
    result.sourceFindings = normalizeSourceFindings(job.source, result.sourceFindings, new Set(normalizedQuestions.map((question) => question.id)));
    const reconciled = reconcileVerificationArtifacts({
      questions: normalizedQuestions,
      sourceConclusions: result.sourceConclusions,
      sourceFindings: result.sourceFindings,
    });
    const questions = reconciled.questions;
    result.verificationQuestions = questions;
    result.sourceConclusions = reconciled.sourceConclusions;
    result.sourceFindings = reconciled.sourceFindings;
    job.aiProfile = { status: "completed", error: null, result };
    job.aiContractProfile = result.contractProfile || null;
    job.sourceConclusions = result.sourceConclusions;
    job.aiDeploymentPlan = result.deploymentPlan || null;
    job.verificationQuestions = questions;
    stage(job, "ai-profile", "completed", `${questions.length} contract-specific verification question(s) defined before tool evidence review`);
  } catch (error) {
    if (job.cancelRequested) throw cancelledError("Audit cancelled by user");
    if (["AUDIT_CANCELLED", "FOLLOWUP_CANCELLED"].includes(error?.code)) throw error;
    job.aiProfile = { status: "failed", error: error.message };
    stage(job, "ai-profile", "failed", `AI-first contract modeling did not complete after the bounded retry: ${error.message}`);
  }
}

async function runGeneratedTests(job, options = {}) {
  const followup = options.followup || null;
  const controllerOperation = options.controllerOperation || null;
  const controllerCancelled = typeof options.isCancelled === "function" ? options.isCancelled : null;
  const plans = options.plans || job.ai.result.testPlans.slice(0, job.testCampaign.generatedTestBudget);
  const eventStage = followup ? "followup" : controllerOperation ? "operation-loop" : "tests";
  const fork = options.fork || null;
  if (!plans.length) {
    if (followup) addEvent(job, eventStage, "failed", "Codex returned no targeted test plans");
    else stage(job, "tests", "skipped", "Codex returned no generated test plans");
    return;
  }
  if (followup) addEvent(job, eventStage, "running", `Running ${plans.length} authorized targeted property check(s)${fork ? ` on a read-only ${fork.label} fork` : " locally"}`);
  else stage(job, "tests", "running", `Running ${job.testCampaign.mode} campaign: up to ${plans.length} generated property check(s), ${job.testCampaign.fuzzRuns} fuzz runs each`);
  await mkdir(path.join(job.jobDir, "test"), { recursive: true, mode: 0o700 });
  await cleanupGeneratedHarnesses(job.jobDir);
  const deadline = Number.isFinite(options.deadlineAt) ? options.deadlineAt : Date.now() + job.testCampaign.timeoutMinutes * 60_000;

  const assertNotCancelled = () => {
    if (controllerCancelled?.()) throwIfControllerCancelled(job, controllerCancelled);
    if (followup?.cancelRequested) throw followupCancelled();
    throwIfCancelled(job);
  };

  for (const [index, plan] of plans.entries()) {
    assertNotCancelled();
    if (Date.now() >= deadline) {
      plan.executionStatus = "timed-out";
      plan.executionMessage = "Campaign wall-time budget was exhausted before execution";
      job.testCampaign.timedOut += 1;
      job.testCampaign.budgetExhausted = true;
      continue;
    }
    const validation = validateGeneratedTest(job, plan);
    if (!validation.ok) {
      plan.executionStatus = "rejected";
      plan.executionMessage = validation.error;
      job.testCampaign.rejected += 1;
      addEvent(job, eventStage, "rejected", `${plan.title}: ${validation.error}`);
      continue;
    }
    job.testCampaign.plansAccepted += 1;
    job.testCampaign.executed += 1;

    await assertSubmittedSourceUnchanged(job);
    // Forge compiles every Solidity file under test/, even when --match-path is
    // supplied. Reuse one active path so a rejected or non-compiling AI test
    // cannot poison every later attempt in the same audit campaign.
    const relativePath = "test/ActiveGeneratedAudit.t.sol";
    await writeFile(path.join(job.jobDir, relativePath), plan.code, { mode: 0o600 });
    const forgeArgs = ["test", "--root", job.jobDir];
    if (!fork) forgeArgs.push("--offline");
    forgeArgs.push("--fuzz-runs", String(Math.min(job.testCampaign.fuzzRuns, followup || controllerOperation ? 10_000 : job.testCampaign.fuzzRuns)), "--match-path", relativePath, "-vvv");
    if (fork) forgeArgs.push("--fork-url", "attest_followup", "--fork-block-number", String(fork.blockNumber));
    const runEnv = foundryEnvironment(job.jobDir, { allowCompilerDownload: Boolean(fork) });
    if (fork) {
      runEnv.FOUNDRY_OFFLINE = "false";
      runEnv.ATTEST_FORK_RPC = fork.url;
    }
    const forgeCapability = job.capabilities.analyzers.find((tool) => tool.id === "forge");
    let result = await runCommand(forgeCapability?.command || "forge", forgeArgs, {
      cwd: job.jobDir,
      timeoutMs: Math.max(1_000, Math.min(90_000, deadline - Date.now())),
      env: runEnv,
      isCancelled: controllerCancelled || (() => followup ? followup.cancelRequested : job.cancelRequested),
    });
    assertNotCancelled();
    if (fork) result = redactForkResult(result, fork.url, fork.label);
    await assertSubmittedSourceUnchanged(job);
    const discoveredPassingTest = /\[PASS\]/.test(result.stdout + result.stderr);
    const executionStatus = result.exitCode === 0 && discoveredPassingTest ? "executed-needs-oracle" : result.timedOut ? "timed-out" : "failed";
    const failureKind = executionStatus === "failed" ? classifyGeneratedTestFailure(result) : null;
    const status = generatedToolRunStatus(result, failureKind);
    const toolRun = withOperationProvenance({
      ...toToolRun(fork ? `forge-fork:${fork.id}:${plan.id}` : `forge-generated:${plan.id}`, forgeCapability?.version, status, result),
      harnessHash: sourceHash(plan.code),
      testPlanId: plan.id,
      contractOutcome: failureKind === "unverified-assertion" ? "assertion-failure-awaiting-ai-review" : null,
    }, job, controllerOperation || (followup?.kind ? followup : null));
    if (fork) {
      plan.networkEvidence = { id: fork.id, label: fork.label, chainId: fork.chainId, blockNumber: fork.blockNumber, blockHash: fork.blockHash, endpointHost: fork.endpointHost };
      toolRun.networkEvidence = structuredClone(plan.networkEvidence);
    }
    job.toolRuns.push(toolRun);
    const artifactPrefix = followup ? `followup-${safeRunId}-${index + 1}` : `generated-test-${index + 1}`;
    await writeFile(path.join(job.jobDir, "artifacts", `${artifactPrefix}.stdout.txt`), result.stdout);
    await writeFile(path.join(job.jobDir, "artifacts", `${artifactPrefix}.stderr.txt`), result.stderr);
    plan.executionStatus = executionStatus;
    plan.failureKind = failureKind;
    plan.executionMessage = plan.executionStatus === "executed-needs-oracle" ? "Generated assertions executed successfully; their security-property oracle still requires independent semantic review" : result.exitCode === 0 ? "Forge discovered no passing generated test" : conciseFailure("Generated Foundry test", result);
    plan.executionEvidence = compactForgeEvidence(result);

    if (plan.executionStatus === "executed-needs-oracle") {
      job.testCampaign.awaitingOracle = (job.testCampaign.awaitingOracle || 0) + 1;
      for (const id of plan.findingIds) {
        const finding = job.findings.find((item) => item.id === id);
        if (finding) finding.evidence.push({
          kind: "generated-test-execution",
          tool: "forge",
          toolVersion: job.capabilities.analyzers.find((tool) => tool.id === "forge")?.version,
          detectorId: plan.id,
          description: `Generated test executed: ${plan.expectedBehavior}`,
          reproduced: false,
        });
      }
    } else if (plan.executionStatus === "timed-out") job.testCampaign.timedOut += 1;
    else job.testCampaign.failed += 1;
    for (const suiteId of plan.suitePlanIds || []) {
      const suite = job.suitePlan.find((item) => item.id === suiteId);
      if (suite) {
        if (!suite.generatedTestIds.includes(plan.id)) suite.generatedTestIds.push(plan.id);
        suite.status = plan.executionStatus === "executed-needs-oracle" ? "test-executed-needs-oracle" : plan.executionStatus;
      }
    }
    addEvent(job, eventStage, plan.executionStatus, `${plan.title}: ${plan.executionMessage}`);
  }

  if (!followup && !controllerOperation) {
    const status = generatedTestStageStatus(job.testCampaign);
    stage(job, "tests", status, `${job.testCampaign.executed || 0} executed; ${job.testCampaign.awaitingOracle || 0} awaiting oracle review; ${job.testCampaign.rejected} rejected before Forge; ${job.testCampaign.failed} failed; ${job.testCampaign.timedOut} timed out`);
  }
}

async function cleanupGeneratedHarnesses(jobDir) {
  const testDir = path.join(jobDir, "test");
  let entries;
  try { entries = await readdir(testDir, { withFileTypes: true }); }
  catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const owned = /^(?:ActiveGeneratedAudit|GeneratedAudit\d+|Followup[A-Za-z0-9]+_\d+)\.t\.sol$/;
  for (const entry of entries) {
    if (!entry.isFile() || !owned.test(entry.name)) continue;
    await unlink(path.join(testDir, entry.name));
  }
}

function redactForkResult(result, rpcUrl, label) {
  const redact = (value) => String(value || "").split(rpcUrl).join(`[${label} RPC redacted]`);
  return { ...result, args: [], commandSummary: `forge test --fork-url [${label} RPC redacted]`, stdout: redact(result.stdout), stderr: redact(result.stderr) };
}

function followupCancelled() {
  const error = new Error("Targeted verification pass cancelled by user");
  error.code = "FOLLOWUP_CANCELLED";
  return error;
}

async function runEvidenceVerification(job, options = {}) {
  const followup = options.followup || null;
  const controller = !followup;
  const previousEvidenceReview = followup ? structuredClone(job.evidenceReview) : null;
  const plans = effectiveTestPlans(job);
  if (!job.verificationQuestions.length) {
    const reason = "AI review returned no contract-specific verification questions";
    markEvidenceReviewUnavailable(job, reason);
    if (followup) addEvent(job, "followup", "failed", reason);
    else stage(job, "evidence-review", "skipped", reason);
    return;
  }
  if (followup) addEvent(job, "followup", "running", `Re-reviewing all accumulated evidence against ${job.verificationQuestions.length} verification question(s)`);
  else stage(job, "evidence-review", "running", `AI is adjudicating accumulated evidence against ${job.verificationQuestions.length} verification question(s)`);
  job.evidenceReview = { status: "running", error: null, testResults: [], questionResults: [], additionalPasses: [] };
  try {
    await assertSubmittedSourceUnchanged(job);
    const result = await runWithAiRetry(job, "evidence adjudication", () => job.codex.verifyEvidence({
      operationKey: followup ? `${job.jobDir}:followup:${followup.id}` : controller ? `${job.jobDir}:controller-evidence:${job.operationLoop.iteration}` : job.jobDir,
      jobDir: job.jobDir,
      source: job.source,
      sourceHash: job.sourceHash,
      contractModel: {
        contractProfile: job.aiContractProfile,
        contractSummary: job.ai?.result?.contractSummary,
        threatModel: job.ai?.result?.threatModel,
        moneyFlow: job.ai?.result?.moneyFlow || [],
        permissionFlow: job.ai?.result?.permissionFlow || [],
        trustAssumptions: job.ai?.result?.trustAssumptions || [],
        invariants: job.ai?.result?.invariants || [],
        sourceConclusions: job.sourceConclusions,
        declaredContext: job.declaredContext,
        developerEvidence: (job.developerEvidence || []).map(({ id, kind, category, statement, relatedQuestionIds, planId, summary, validation }) => ({ id, kind, category, statement, relatedQuestionIds, planId, summary, validation })),
      },
      verificationQuestions: job.verificationQuestions,
      testPlans: plans.map((plan) => ({
        id: plan.id,
        title: plan.title,
        questionIds: plan.questionIds,
        oracleBindings: plan.oracleBindings || [],
        findingIds: plan.findingIds,
        suitePlanIds: plan.suitePlanIds,
        testType: plan.testType,
        expectedBehavior: plan.expectedBehavior,
        code: plan.code,
        executionStatus: plan.executionStatus,
        failureKind: plan.failureKind,
        executionMessage: plan.executionMessage,
        executionEvidence: plan.executionEvidence,
        networkEvidence: plan.networkEvidence || null,
      })),
      toolRuns: job.toolRuns.map(({ runId, tool, operationId, operationKind, questionId, sourceHash: runSourceHash, operationSpecDigest, status, exitCode, timedOut, error, outputDigest, networkEvidence, profiles, normalizedEvidence }) => ({ runId, tool, operationId, operationKind, questionId, sourceHash: runSourceHash, operationSpecDigest, status, exitCode, timedOut, error, outputDigest, networkEvidence, profiles, normalizedEvidence })),
      findings: job.findings.map(({ id, title, category, severity, location, evidence, aiReview }) => ({ id, title, category, severity, location, evidence, aiReview })),
      anvil: job.anvil,
      forkEvidence: followup?.networkEvidence || null,
    }));
    await assertSubmittedSourceUnchanged(job);
    applyEvidenceReview(job, result);
    const questions = job.evidenceReview.questionResults;
    const settled = questions.filter((item) => item.status !== "not-verified").length;
    if (followup) addEvent(job, "followup", "completed", `${settled} of ${questions.length} verification question(s) now have an AI-supported conclusion; ${questions.length - settled} still need a targeted check`);
    else stage(job, "evidence-review", "completed", `${settled} of ${questions.length} verification question(s) have an AI-supported conclusion; ${questions.length - settled} remain open`);
  } catch (error) {
    if (job.cancelRequested) throw cancelledError("Audit cancelled by user");
    if (["AUDIT_CANCELLED", "FOLLOWUP_CANCELLED"].includes(error?.code)) throw error;
    if (followup) {
      job.evidenceReview = previousEvidenceReview;
      addEvent(job, "followup", "failed", `AI evidence re-review did not complete: ${error.message}`);
      throw error;
    }
    markEvidenceReviewUnavailable(job, `AI evidence verification did not complete: ${error.message}`);
    stage(job, "evidence-review", "failed", job.evidenceReview.error);
  }
}

function generatedTestStageStatus(campaign) {
  const allRejectedBeforeForge = campaign.executed === 0 && campaign.rejected > 0 && campaign.failed === 0 && campaign.timedOut === 0;
  if (allRejectedBeforeForge) return "skipped";
  const executionFailures = campaign.rejected > 0 || campaign.failed > 0 || campaign.timedOut > 0 || campaign.budgetExhausted;
  return campaign.awaitingOracle > 0 && !executionFailures ? "completed" : "failed";
}

function validateGeneratedTest(job, plan) {
  if (typeof plan.code !== "string" || !plan.code.trim()) return { ok: false, error: "No Solidity test code was supplied" };
  if (Buffer.byteLength(plan.code, "utf8") > 60_000) return { ok: false, error: "Generated test exceeds the 60 KB limit" };
  const executableCode = stripSolidityComments(plan.code);
  const semanticCode = stripSolidityStrings(executableCode);
  if (/\.(?:call|delegatecall|staticcall)\s*(?:\{|\()|keccak256\s*\(\s*["']hevm cheat code["']|\bffi\s*\(|\bvm\s*\.|\bassembly\b|7109709ECfa91a80626fF3989D68f67F5b1DD12D/i.test(executableCode)) return { ok: false, error: "Low-level calls, cheatcodes, assembly, and FFI are not allowed in generated tests" };
  if (/\b(?:interface|library)\s+[A-Za-z_][A-Za-z0-9_]*\b/.test(semanticCode)) return { ok: false, error: "Generated tests may not declare interfaces or libraries; external call types must come from the submitted target" };
  const imports = [...executableCode.matchAll(/\bimport\s+(?:[^"']*from\s+)?["']([^"']+)["']/g)].map((match) => match[1]);
  const canonicalImports = [...executableCode.matchAll(/\bimport\s*["']\.\.\/src\/Target\.sol["']\s*;/g)];
  const allowedImports = new Set(["../src/Target.sol", "../test-support/AttestTest.sol"]);
  const supportImports = imports.filter((item) => item === "../test-support/AttestTest.sol");
  if (canonicalImports.length !== 1 || imports.filter((item) => item === "../src/Target.sol").length !== 1
    || supportImports.length > 1 || imports.some((item) => !allowedImports.has(item))) {
    return { ok: false, error: "Generated tests may import only one bare ../src/Target.sol and the optional app-owned ../test-support/AttestTest.sol" };
  }
  if (supportImports.length && !/\bis\s+AttestTest\b/.test(semanticCode)) return { ok: false, error: "A test importing AttestTest.sol must inherit AttestTest to use the allowlisted wrappers" };
  if (/\b(?:contract|abstract\s+contract)\s+(?:AttestTest|AttestVm)\b/.test(semanticCode)) return { ok: false, error: "Generated tests may not shadow the app-owned test support types" };
  const testFunctions = [...semanticCode.matchAll(/\bfunction\s+(?:test[A-Za-z0-9_]*|invariant_[A-Za-z0-9_]*)\s*\(/g)];
  if (!testFunctions.length) return { ok: false, error: "No Foundry test or invariant function was found" };
  if (testFunctions.length > 20) return { ok: false, error: "Generated harness exceeds the 20 test-function limit" };
  if (!(plan.findingIds?.length || plan.suitePlanIds?.length || plan.questionIds?.length)) return { ok: false, error: "Generated test is not grounded in a known finding, AI-selected question, or selected suite vector" };
  if (job.verificationQuestions?.length && !plan.questionIds?.length) return { ok: false, error: "Generated test does not answer a known verification question" };
  if ((plan.questionIds || []).length > 1 && !normalizeOracleBindings(plan.oracleBindings, plan.questionIds, plan.code).length) return { ok: false, error: "A multi-question harness must bind every test function and every atomic question through complete oracleBindings" };
  const testBodies = testFunctions.map((match) => functionBodyAt(semanticCode, match.index)).filter(Boolean);
  const meaningfulBodies = testBodies.filter((body) => assertionExpressions(body).some((expression) => !clearlyVacuousAssertion(expression)));
  if (!meaningfulBodies.length || meaningfulBodies.length !== testBodies.length) return { ok: false, error: "Every generated test function needs a non-vacuous require/assert check" };
  const sourceContracts = [...stripSolidityComments(job.source).matchAll(/\b(?:abstract\s+)?contract\s+([A-Za-z_][A-Za-z0-9_]*)\b/g)].map((match) => match[1]);
  if (!sourceContracts.length) return { ok: false, error: "No concrete submitted contract is available for direct test provenance" };
  const locallyDeclaredContracts = [...semanticCode.matchAll(/\b(?:abstract\s+)?contract\s+([A-Za-z_][A-Za-z0-9_]*)\b/g)].map((match) => match[1]);
  if (locallyDeclaredContracts.some((name) => sourceContracts.includes(name))) return { ok: false, error: "Generated tests may not shadow a contract declared by ../src/Target.sol" };
  if (hasForbiddenContractCast(semanticCode, [...sourceContracts, ...locallyDeclaredContracts])) return { ok: false, error: "Generated tests may instantiate contract types only with new; arbitrary address-to-contract receivers are not allowed" };
  const targetReceivers = targetReceiversInCode(semanticCode, sourceContracts);
  if (!targetReceivers.length) return { ok: false, error: "Generated tests must instantiate a contract declared in ../src/Target.sol; substitute or derived targets are not accepted" };
  const targetFunctions = (plan.questionIds?.length ? [] : plan.findingIds)
    .map((id) => job.findings.find((finding) => finding.id === id)?.location?.function)
    .filter(Boolean);
  const sourceFunctions = [...stripSolidityComments(job.source).matchAll(/\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map((match) => match[1]);
  const receiverPattern = targetReceivers.map(escapeRegex).join("|");
  const targetMethodCalls = receiverPattern
    ? [...semanticCode.matchAll(new RegExp(`\\b(?:${receiverPattern})\\s*\\.\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*\\(`, "g"))].map((match) => match[1])
    : [];
  const callableSourceFunctions = [...new Set([...sourceFunctions, ...targetMethodCalls])];
  const relevantFunctions = targetFunctions.length ? targetFunctions : callableSourceFunctions;
  if (targetFunctions.length && !meaningfulBodies.some((body) => targetFunctions.some((name) => new RegExp(`\\.${escapeRegex(name)}\\s*\\(`).test(body)))) {
    return { ok: false, error: "Generated code does not reference the affected function" };
  }
  if (!targetFunctions.length && plan.suitePlanIds?.length) {
    if (!meaningfulBodies.some((body) => callableSourceFunctions.some((name) => new RegExp(`\\.${escapeRegex(name)}\\s*\\(`).test(body)))) return { ok: false, error: "Suite-grounded test does not call a source function in an executed test body" };
  }
  if (!meaningfulBodies.every((body) => assertionsGroundedInTarget(body, relevantFunctions, targetReceivers))) return { ok: false, error: "Every assertion must depend on an instance created from ../src/Target.sol" };
  return { ok: true };
}

function hasForbiddenContractCast(code, contractNames) {
  return [...new Set(contractNames)].some((name) => [...code.matchAll(new RegExp(`\\b${escapeRegex(name)}\\s*\\(`, "g"))]
    .some((match) => !/\bnew\s*$/.test(code.slice(Math.max(0, match.index - 24), match.index))));
}

function classifyGeneratedTestFailure(result) {
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (/\[FAIL(?::|\])|Test result:\s*FAILED|Encountered \d+ failing test/i.test(output)) return "unverified-assertion";
  if (/Compiler run failed|Compilation failed|Error \([0-9]+\)|ParserError|TypeError:/i.test(output)) return "harness-error";
  return "execution-error";
}

function validateAiResult(job, result) {
  result.moneyFlow = normalizeAuditModelList(result.moneyFlow || job.ai?.result?.moneyFlow);
  result.permissionFlow = normalizeAuditModelList(result.permissionFlow || job.ai?.result?.permissionFlow);
  result.trustAssumptions = normalizeAuditModelList(result.trustAssumptions || job.ai?.result?.trustAssumptions);
  result.invariants = normalizeAuditModelList(result.invariants || job.ai?.result?.invariants);
  job.testCampaign ||= resolveTestCampaign(normalizeTestCampaign({ mode: "smoke" }), job.suitePlan || []);
  const knownIds = new Set(job.findings.map((finding) => finding.id));
  const sourceLines = job.source.split("\n");
  result.reviewedFindings = (result.reviewedFindings ?? [])
    .filter((review) => knownIds.has(review.findingId))
    .map((review) => ({
      ...review,
      evidence: (review.evidence ?? []).map((evidence) => {
        const validRange = Number.isInteger(evidence.lineStart) && Number.isInteger(evidence.lineEnd) && evidence.lineStart >= 1 && evidence.lineEnd >= evidence.lineStart && evidence.lineEnd <= sourceLines.length;
        const quote = typeof evidence.quote === "string" ? evidence.quote.trim() : "";
        const quotedRange = validRange ? sourceLines.slice(evidence.lineStart - 1, evidence.lineEnd).join("\n") : "";
        return { ...evidence, sourceValidated: Boolean(quote) && quotedRange.includes(quote) };
      }),
    }));
  for (const review of result.reviewedFindings) {
    review.sourceValidated = review.evidence.length > 0 && review.evidence.every((item) => item.sourceValidated);
    if (!review.sourceValidated) {
      review.verdict = "needs-review";
      review.assumptionEffect = `${review.assumptionEffect || ""} Source citations did not validate; classification is not accepted.`.trim();
    }
  }
  const returnedPlans = Array.isArray(result.testPlans) ? result.testPlans : [];
  const seenPlanIds = new Set();
  const uniquePlans = returnedPlans.filter((plan) => {
    const id = typeof plan?.id === "string" ? plan.id.trim() : "";
    if (!id || seenPlanIds.has(id)) return false;
    seenPlanIds.add(id);
    return true;
  });
  const originalQuestionIds = new Set((Array.isArray(result.verificationQuestions) ? result.verificationQuestions : []).map((question) => question?.id).filter(Boolean));
  result.verificationQuestions = normalizeVerificationQuestions(result.verificationQuestions);
  const expandedQuestionIds = new Map();
  for (const question of result.verificationQuestions) {
    const originalId = String(question.id || "").replace(/-(?:STATE|EVENT)$/i, "");
    if (originalQuestionIds.has(originalId) && originalId !== question.id) {
      const ids = expandedQuestionIds.get(originalId) || [];
      ids.push(question.id);
      expandedQuestionIds.set(originalId, ids);
    }
  }
  const questionIds = new Set(result.verificationQuestions.map((question) => question.id));
  result.sourceConclusions = normalizeSourceConclusions(job.source, result.sourceConclusions, questionIds);
  result.sourceFindings = normalizeSourceFindings(job.source, result.sourceFindings, questionIds);
  const reconciled = reconcileVerificationArtifacts({
    questions: result.verificationQuestions,
    sourceConclusions: result.sourceConclusions,
    sourceFindings: result.sourceFindings,
  });
  result.verificationQuestions = reconciled.questions;
  result.sourceConclusions = reconciled.sourceConclusions;
  result.sourceFindings = reconciled.sourceFindings;
  const reconciledQuestionIds = new Set(result.verificationQuestions.map((question) => question.id));
  job.testCampaign.plansReturned = returnedPlans.length;
  job.testCampaign.duplicatePlansRejected = returnedPlans.length - uniquePlans.length;
  job.testCampaign.plansTruncated = Math.max(0, uniquePlans.length - job.testCampaign.generatedTestBudget);
  result.testPlans = uniquePlans.slice(0, job.testCampaign.generatedTestBudget).map((plan) => ({
    ...plan,
    findingIds: plan.findingIds.filter((id) => knownIds.has(id)),
    suitePlanIds: (plan.suitePlanIds ?? []).filter((id) => job.suitePlan.some((suite) => suite.id === id)),
    questionIds: remapPlanQuestionIds(plan, reconciledQuestionIds, expandedQuestionIds),
    executionStatus: "not-run",
  }));
  return result;
}

function normalizeAuditModelList(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => typeof item === "string" ? item.trim().slice(0, 2000) : "")
    .filter(Boolean))].slice(0, 40);
}

function normalizeSourceConclusions(source, items, knownQuestionIds = new Set()) {
  const sourceLines = String(source || "").split("\n");
  const seen = new Set();
  const categories = new Set(["asset-flow", "authorization", "accounting", "state-transition", "external-interaction", "configuration", "compatibility", "other"]);
  const classifications = new Set(["neutral-fact", "vulnerability", "assumption-dependent", "intentional-design", "trust-disclosure", "code-quality"]);
  const severities = new Set(["critical", "high", "medium", "low", "info"]);
  const confidences = new Set(["low", "medium", "high"]);
  return (Array.isArray(items) ? items : []).filter((item) => {
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    if (!id || seen.has(id) || typeof item?.statement !== "string" || !item.statement.trim() || !categories.has(item.category) || !classifications.has(item.classification) || !severities.has(item.severity) || !confidences.has(item.confidence)) return false;
    seen.add(id);
    return true;
  }).slice(0, 40).flatMap((item) => {
    const evidence = (Array.isArray(item.evidence) ? item.evidence : []).flatMap((entry) => {
      const validRange = Number.isInteger(entry?.lineStart) && Number.isInteger(entry?.lineEnd)
        && entry.lineStart >= 1 && entry.lineEnd >= entry.lineStart && entry.lineEnd <= sourceLines.length;
      const quote = typeof entry?.quote === "string" ? entry.quote.trim() : "";
      const quotedRange = validRange ? sourceLines.slice(entry.lineStart - 1, entry.lineEnd).join("\n") : "";
      if (!quote || !quotedRange.includes(quote)) return [];
      return [{ ...entry, quote, sourceValidated: true }];
    });
    if (!evidence.length) return [];
    return [{
      ...item,
      id: item.id.trim(),
      statement: item.statement.trim(),
      rationale: String(item.rationale || "").trim(),
      assurance: "ai-source-supported",
      sourceValidated: true,
      evidence,
      relatedQuestionIds: [...new Set((Array.isArray(item.relatedQuestionIds) ? item.relatedQuestionIds : []).filter((id) => knownQuestionIds.has(id)))],
    }];
  });
}

function mergeSourceConclusions(existing, incoming) {
  const merged = new Map((Array.isArray(existing) ? existing : []).map((item) => [item.id, item]));
  for (const item of Array.isArray(incoming) ? incoming : []) merged.set(item.id, item);
  return [...merged.values()].slice(0, 40);
}

function normalizeSourceFindings(source, items, knownQuestionIds = new Set()) {
  const sourceLines = String(source || "").split("\n");
  const seen = new Set();
  const categories = new Set(["asset-flow", "authorization", "accounting", "state-transition", "external-interaction", "configuration", "compatibility", "logic", "other"]);
  const classifications = new Set(["vulnerability", "assumption-dependent", "intentional-design", "trust-disclosure", "code-quality"]);
  const severities = new Set(["critical", "high", "medium", "low", "info"]);
  const confidences = new Set(["low", "medium", "high"]);
  return (Array.isArray(items) ? items : []).slice(0, 40).flatMap((item) => {
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    if (!id || seen.has(id) || !categories.has(item.category) || !classifications.has(item.classification) || !severities.has(item.severity) || !confidences.has(item.confidence)) return [];
    if (![item.summary, item.rationale, item.impact, item.trigger, item.action].every((value) => typeof value === "string" && value.trim())) return [];
    const evidence = (Array.isArray(item.evidence) ? item.evidence : []).flatMap((entry) => {
      const validRange = Number.isInteger(entry?.lineStart) && Number.isInteger(entry?.lineEnd)
        && entry.lineStart >= 1 && entry.lineEnd >= entry.lineStart && entry.lineEnd <= sourceLines.length;
      const quote = typeof entry?.quote === "string" ? entry.quote.trim() : "";
      const quotedRange = validRange ? sourceLines.slice(entry.lineStart - 1, entry.lineEnd).join("\n") : "";
      return quote && quotedRange.includes(quote) ? [{ ...entry, quote, sourceValidated: true }] : [];
    });
    if (!evidence.length) return [];
    seen.add(id);
    return [{
      ...item,
      id,
      title: String(item.title || "AI source finding").trim(),
      summary: String(item.summary || "").trim(),
      rationale: String(item.rationale || "").trim(),
      sourceValidated: true,
      assurance: "ai-source-supported",
      evidence,
      relatedQuestionIds: [...new Set((item.relatedQuestionIds || []).filter((questionId) => knownQuestionIds.has(questionId)))],
    }];
  });
}

function mergeNewSourceFindings(job, incoming = []) {
  const known = new Set((job.sourceFindings || []).map((item) => item.id));
  const additions = (incoming || []).filter((item) => item?.id && !known.has(item.id));
  if (!additions.length) return;
  const offset = job.sourceFindings.length;
  job.sourceFindings.push(...additions);
  job.findings.push(...additions.map((finding, index) => normalizeSourceFinding(job, finding, offset + index)));
}

function remapPlanQuestionIds(plan, knownQuestionIds, expandedQuestionIds) {
  const remapped = [];
  const planText = `${plan.title || ""} ${plan.expectedBehavior || ""} ${plan.code || ""}`.toLowerCase();
  for (const id of plan.questionIds || []) {
    if (knownQuestionIds.has(id)) {
      remapped.push(id);
      continue;
    }
    const expanded = expandedQuestionIds.get(id) || [];
    if (!expanded.length) continue;
    const stateId = expanded.find((item) => /-STATE$/i.test(item));
    const eventId = expanded.find((item) => /-EVENT$/i.test(item));
    const coversState = /supply|balance|allocat|assign|deployer|owner|metadata/.test(planText);
    const coversEvent = /event|emit|log|topic|recordlogs/.test(planText);
    if (coversState && stateId) remapped.push(stateId);
    if (coversEvent && eventId) remapped.push(eventId);
    if (!coversState && !coversEvent) remapped.push(...expanded);
  }
  return [...new Set(remapped)];
}

function normalizeVerificationQuestions(value) {
  const seen = new Set();
  return splitCompoundVerificationQuestions((Array.isArray(value) ? value : []).slice(0, 20)).filter((question) => {
    if (!question || typeof question.id !== "string" || !question.id.trim() || seen.has(question.id)) return false;
    if (typeof question.question !== "string" || !question.question.trim()) return false;
    seen.add(question.id);
    return true;
  }).slice(0, 40).map((question) => {
    const requiredEvidenceKinds = normalizeRequiredEvidenceKinds(question);
    return {
      ...question,
      materiality: normalizeQuestionMateriality(question),
      requiredEvidenceKinds,
      sufficientEvidenceRoutes: normalizeEvidenceRoutes(question, requiredEvidenceKinds),
    };
  });
}

function reconcileVerificationArtifacts({ questions, sourceConclusions, sourceFindings }) {
  const linkedConclusionIds = new Set((sourceConclusions || []).flatMap((item) => item.relatedQuestionIds || []));
  const kept = [];
  for (const question of questions || []) {
    const kinds = new Set(question.requiredEvidenceKinds || []);
    const routes = Array.isArray(question.sufficientEvidenceRoutes) ? question.sufficientEvidenceRoutes : [];
    const text = `${question.question || ""} ${question.rationale || ""} ${question.expectedEvidence || ""}`;
    const asksForIntent = /\b(?:intent|intended|accepted|acceptable|trusted|expected production|production allocation|policy choice|developer confirmation|should this|is this desired)\b/i.test(text);
    const verifiableKinds = [...kinds].filter((kind) => !["source", "developer-context"].includes(kind));
    const sourceAlreadyConcludesIt = linkedConclusionIds.has(question.id);

    // Developer intent is context for a source fact, not an audit property. A
    // validated source conclusion must never be converted into a question that
    // blocks, expands, or weakens the selected-scope opinion.
    if ((asksForIntent || sourceAlreadyConcludesIt) && verifiableKinds.length === 0) continue;

    if (kinds.has("developer-context")) {
      const requiredEvidenceKinds = (question.requiredEvidenceKinds || []).filter((kind) => kind !== "developer-context");
      const sufficientEvidenceRoutes = routes
        .map((route) => route.filter((kind) => kind !== "developer-context"))
        .filter((route) => route.length > 0);
      if (!requiredEvidenceKinds.length) continue;
      kept.push({
        ...question,
        materiality: asksForIntent ? "optional-assurance" : question.materiality,
        requiredEvidenceKinds,
        sufficientEvidenceRoutes: sufficientEvidenceRoutes.length ? sufficientEvidenceRoutes : [[...requiredEvidenceKinds]],
      });
      continue;
    }
    kept.push(question);
  }

  const keptIds = new Set(kept.map((item) => item.id));
  const trimLinks = (items) => (items || []).map((item) => ({
    ...item,
    relatedQuestionIds: (item.relatedQuestionIds || []).filter((id) => keptIds.has(id)),
  }));
  return {
    questions: kept,
    sourceConclusions: trimLinks(sourceConclusions),
    sourceFindings: trimLinks(sourceFindings),
  };
}

function normalizeQuestionMateriality(question) {
  if (["required-for-opinion", "optional-assurance"].includes(question?.materiality)) return question.materiality;
  const text = `${question?.priority || ""} ${question?.question || ""} ${question?.rationale || ""}`;
  return /\b(?:critical|high|funds?|assets?|custody|withdraw|drain|mint|authorization|untrusted|privilege|ownership|solvency|reentrancy)\b/i.test(text)
    ? "required-for-opinion"
    : "optional-assurance";
}

function normalizeEvidenceRoutes(question, fallbackKinds) {
  const allowed = new Set(["source", "analyzer", "foundry", "anvil-deployment", "anvil-observation", "anvil-scenario", "fork", "compiler-matrix", "developer-context"]);
  const routes = (Array.isArray(question?.sufficientEvidenceRoutes) ? question.sufficientEvidenceRoutes : [])
    .map((route) => (Array.isArray(route) ? [...new Set(route.filter((kind) => allowed.has(kind)))] : []))
    .filter((route) => route.length > 0)
    .slice(0, 8);
  return routes.length ? routes : [[...fallbackKinds]];
}

function splitCompoundVerificationQuestions(questions) {
  return questions.flatMap((question) => {
    const text = String(question?.question || "");
    if (/(?:-STATE|-EVENT)$/i.test(String(question?.id || ""))) return [question];
    const split = text.match(/^(.*?)(?:,?\s+)(?:and|then|while|as\s+well\s+as)\s+((?:emit(?:s|ted|ting)?|log(?:s|ged|ging)?|record(?:s|ed|ing)?|create(?:s|d|ing)?|produce(?:s|d|ing)?)\b.*)$/i);
    const stateAndEvent = split && /deploy|construct|initial/i.test(split[1]) && /supply|balance|allocat|assign|owner/i.test(split[1]);
    if (!stateAndEvent) return [question];
    const baseId = String(question.id || "Q");
    const eventClause = split[2]
      .replace(/^emit(?:s|ted|ting)?\b/i, "emit")
      .replace(/^log(?:s|ged|ging)?\b/i, "log")
      .replace(/^record(?:s|ed|ing)?\b/i, "record")
      .replace(/^create(?:s|d|ing)?\b/i, "create")
      .replace(/^produce(?:s|d|ing)?\b/i, "produce");
    return [
      {
        ...question,
        id: `${baseId}-STATE`,
        question: `${split[1].replace(/[?.!]+$/, "")}?`,
        expectedEvidence: "Fresh Anvil deployment observations proving total supply, actor-0 deployer balance, and actor-1 non-deployer balance",
        requiredEvidenceKinds: ["source", "anvil-deployment", "anvil-observation"],
      },
      {
        ...question,
        id: `${baseId}-EVENT`,
        question: `Does deployment ${eventClause.replace(/[?.!]+$/, "")}?`,
        expectedEvidence: "Fresh Anvil deployment receipt proving the exact emitted event count, emitter, indexed fields, and value",
        requiredEvidenceKinds: ["source", "anvil-deployment", "anvil-observation"],
      },
    ];
  });
}

function normalizeRequiredEvidenceKinds(question) {
  const allowed = new Set(["source", "analyzer", "foundry", "anvil-deployment", "anvil-observation", "anvil-scenario", "fork", "compiler-matrix", "developer-context"]);
  const supplied = (Array.isArray(question.requiredEvidenceKinds) ? question.requiredEvidenceKinds : []).filter((kind) => allowed.has(kind));
  const expected = String(question.expectedEvidence || "").toLowerCase();
  const inferred = ["source"];
  const expectsFoundry = /fuzz|invariant|foundry|forge|executed test|property test/.test(expected);
  if (expectsFoundry) inferred.push("foundry");
  if (/anvil|fresh chain|deployment|bytecode|constructor/.test(expected)) {
    inferred.push("anvil-deployment");
    if (/total\s*supply|totalsupply|balance|owner\s*(?:\(|state|address)|read-only|getter/.test(expected)) inferred.push("anvil-observation");
    if (!expectsFoundry && /scenario|execute|runtime|interaction|transaction|unauthorized|swap|transfer|withdraw|deposit|approve|reentran/.test(expected)) inferred.push("anvil-scenario");
  }
  if (/fork|mainnet|testnet|live chain|chain state/.test(expected)) inferred.push("fork");
  if (/slither|aderyn|mythril|analyzer|static analysis/.test(expected)) inferred.push("analyzer");
  if (/compiler|solc|version matrix/.test(expected)) inferred.push("compiler-matrix");
  if (/developer intent|developer confirmation|configuration input/.test(expected)) inferred.push("developer-context");
  return [...new Set([...supplied, ...inferred])];
}

function normalizeDeclaredContext(context) {
  const allowedTypes = new Set(["auto", "memecoin", "erc20-token", "erc4626-vault", "erc721-nft", "proxy-upgradeable", "governance", "staking-rewards", "amm-dex", "oracle-consumer", "bridge-messaging", "custom-contract"]);
  const trim = (value, max) => typeof value === "string" ? value.trim().slice(0, max) : "";
  const contractType = allowedTypes.has(context.contractType) ? context.contractType : "auto";
  return {
    contractType,
    trustedRoles: trim(context.trustedRoles, 2_000),
    intendedBehaviors: trim(context.intendedBehaviors, 3_000),
    acceptedRisks: trim(context.acceptedRisks, 2_000),
  };
}

function mergeAiReview(job) {
  for (const review of job.ai.result.reviewedFindings) {
    const finding = job.findings.find((item) => item.id === review.findingId);
    if (finding) finding.aiReview = review;
  }
  for (const plan of job.ai.result.testPlans) {
    for (const id of plan.findingIds) {
      const finding = job.findings.find((item) => item.id === id);
      if (finding) finding.testPlans.push(plan);
    }
  }
}

function deduplicate(findings) {
  const merged = [];
  const ordered = findings.map((finding, index) => ({ finding, index }))
    .sort((a, b) => semanticMetadataScore(b.finding) - semanticMetadataScore(a.finding) || a.index - b.index)
    .map((entry) => entry.finding);
  for (const finding of ordered) {
    const candidates = merged.filter((candidate) =>
      candidate.category === finding.category &&
      candidate.location.file === finding.location.file &&
      candidate.location.lineStart != null &&
      candidate.location.lineStart === finding.location.lineStart &&
      (!candidate.location.contract || !finding.location.contract || candidate.location.contract === finding.location.contract) &&
      (!candidate.location.function || !finding.location.function || candidate.location.function === finding.location.function) &&
      sourceSpansCompatible(candidate.location, finding.location)
    );
    const match = candidates.length === 1 ? candidates[0] : null;
    if (match) {
      match.evidence.push(...finding.evidence);
      if (severityRank(finding.severity) > severityRank(match.severity)) match.severity = finding.severity;
      if (confidenceRank(finding.confidence) > confidenceRank(match.confidence)) match.confidence = finding.confidence;
    }
    else merged.push(finding);
  }
  return merged;
}

function semanticMetadataScore(finding) {
  return Number(Boolean(finding.location?.function)) + Number(Boolean(finding.location?.contract)) + Number(Number.isInteger(finding.location?.sourceStart));
}

function sourceSpansCompatible(left, right) {
  if (![left.sourceStart, left.sourceLength, right.sourceStart, right.sourceLength].every(Number.isInteger)) return true;
  const leftEnd = left.sourceStart + left.sourceLength;
  const rightEnd = right.sourceStart + right.sourceLength;
  return left.sourceStart < rightEnd && right.sourceStart < leftEnd;
}

function severityRank(value) {
  return ({ unknown: 0, info: 1, low: 2, medium: 3, high: 4, critical: 5 })[value] ?? 0;
}

function confidenceRank(value) {
  return ({ unknown: 0, low: 1, medium: 2, high: 3 })[value] ?? 0;
}

function corroborate(findings) {
  for (const finding of findings) {
    const deterministicTools = new Set(finding.evidence.filter((e) => ["static", "symbolic", "dynamic-reproduction"].includes(e.kind)).map((e) => e.tool));
    const reproduced = finding.evidence.some((e) => e.kind === "dynamic-reproduction" && e.reproduced);
    if (reproduced) finding.verification = "confirmed-by-test";
    else if (deterministicTools.size >= 2) finding.verification = "corroborated";
    else if (finding.aiReview?.sourceValidated && finding.aiReview.verdict === "reject") finding.verification = "disputed";
    else if (finding.aiReview?.sourceValidated) finding.verification = "ai-reviewed";
    else if (finding.aiReview) finding.verification = "needs-review";
  }
}

function deriveFinalStatus(job) {
  if (job.aiProfile?.status !== "completed") return "failed";
  return job.operationLoop?.status === "completed" ? "completed" : "partial";
}

function generatedToolRunStatus(result, failureKind) {
  if (result.timedOut) return "timed-out";
  if (result.exitCode === 0 || failureKind === "unverified-assertion") return "completed";
  return "failed";
}

async function writePublishedArtifacts(job, revision) {
  const snapshot = revision.snapshot || publicJob(job);
  if (jobStore) {
    await jobStore.commitReportRevision(job.id, {
      revision: revision.revision,
      evidenceRevision: revision.evidenceRevision,
      metadata: { trigger: revision.trigger, operationId: revision.operationId, sourceHash: job.sourceHash },
      artifacts: {
        "findings.md": job.reportMarkdown,
        "evidence.json": snapshot,
        "worklog.json": job.worklog,
        "state.json": durableJobSnapshot(job),
      },
    });
    return;
  }
  const files = [
    ["findings.md", job.reportMarkdown],
    ["evidence.json", JSON.stringify(snapshot, null, 2)],
    ["worklog.json", JSON.stringify(job.worklog, null, 2)],
    [`findings-r${revision.revision}.md`, job.reportMarkdown],
    [`evidence-r${revision.revision}.json`, JSON.stringify(snapshot, null, 2)],
  ];
  const pending = files.map(([name, content]) => ({ finalPath: path.join(job.jobDir, name), tempPath: path.join(job.jobDir, `${name}.tmp-${randomUUID()}`), content }));
  await Promise.all(pending.map((item) => writeFile(item.tempPath, item.content, { mode: 0o600 })));
  for (const item of pending) await rename(item.tempPath, item.finalPath);
}

function projectCompletedArtifactJob(job, finalStatus, message, completedAt = now()) {
  const unresolvedStages = job.stages.filter((item) => item.id !== "report" && !["completed", "failed", "skipped", "timed-out"].includes(item.status));
  const stages = job.stages.map((item) => {
    if (item.id === "report") return { ...item, status: "completed", message, finishedAt: completedAt };
    if (unresolvedStages.includes(item)) return { ...item, status: "skipped", message: "Not required for the finalized audit result", finishedAt: completedAt };
    return { ...item };
  });
  const worklog = [...job.worklog, ...unresolvedStages.map((item) => ({
    id: randomUUID(),
    at: completedAt,
    stage: item.id,
    status: "skipped",
    message: "Not required for the finalized audit result",
    details: null,
  })), {
    id: randomUUID(),
    at: completedAt,
    stage: "report",
    status: "completed",
    message,
    details: null,
  }];
  return { ...job, status: finalStatus, updatedAt: completedAt, stages, worklog };
}

function failJob(job, error) {
  job.status = "failed";
  job.updatedAt = now();
  job.reportMarkdown = null;
  job.reportState = {
    status: "failed",
    reason: `Audit stopped before final findings could be generated: ${error.message}`,
    finalizedAt: null,
    finalizedBy: null,
    retryable: false,
  };
  const stoppedBecause = `Not run because the audit stopped: ${String(error.message || error).slice(0, 500)}`;
  if (job.operationLoop && ["queued", "running"].includes(job.operationLoop.status)) {
    job.operationLoop.status = job.operationLoop.status === "queued" ? "skipped" : "failed";
    job.operationLoop.activeOperation = null;
    job.operationLoop.stopReason = stoppedBecause;
  }
  if (job.evidenceReview && ["queued", "running"].includes(job.evidenceReview.status)) {
    job.evidenceReview.status = job.evidenceReview.status === "queued" ? "skipped" : "failed";
    job.evidenceReview.error = String(error.message || error);
  }
  for (const item of job.stages) {
    if (item.id === "report") {
      if (!["completed", "failed"].includes(item.status)) stage(job, item.id, "failed", job.reportState.reason);
    } else if (item.status === "running") {
      stage(job, item.id, "failed", String(error.message || error));
    } else if (item.status === "queued") {
      stage(job, item.id, "skipped", stoppedBecause);
    }
  }
  addEvent(job, "job", "failed", error.message);
}

function failFollowup(job, operation, error) {
  rollbackFollowupState(job, operation);
  if (operation.completionEventId) job.worklog = job.worklog.filter((item) => item.id !== operation.completionEventId);
  operation.status = ["FOLLOWUP_CANCELLED", "AUDIT_CANCELLED"].includes(error?.code) ? "cancelled" : "failed";
  operation.error = error.message;
  operation.finishedAt = now();
  const action = job.followup.actions.find((item) => item.id === operation.actionId);
  if (action && action.evidenceRevision === job.evidenceRevision) action.status = "open";
  if (operation.tool === "anvil" && job.developerDeploymentPlan?.id === operation.planId) {
    job.developerDeploymentPlan.status = "proposed";
    job.developerDeploymentPlan.approvedAt = null;
  }
  job.followup.status = "idle";
  job.followup.active = null;
  addEvent(job, "followup", operation.status, `${operation.tool === "controller" ? "AI-controlled audit" : "Evidence review"} ${operation.status}: ${error.message}`);
}

function copilotError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function throwIfCancelled(job) {
  if (!job.cancelRequested) return;
  throw cancelledError("Audit cancelled by user");
}

function cancelledError(message) {
  const error = new Error(message);
  error.code = "AUDIT_CANCELLED";
  return error;
}

function throwIfControllerCancelled(job, isCancelled) {
  if (!isCancelled()) return;
  if (job.cancelRequested) throw cancelledError("Audit cancelled by user");
  throw followupCancelled();
}

function finalizeCancellation(job) {
  if (job.status === "cancelled") return;
  job.status = "cancelled";
  job.updatedAt = now();
  for (const item of job.stages) {
    if (["queued", "running"].includes(item.status)) {
      item.status = "skipped";
      item.message = "Cancelled by user";
      item.finishedAt = now();
    }
  }
  if (job.ai.status === "running" || job.ai.status === "queued") {
    job.ai.status = "cancelled";
    job.ai.error = null;
  }
  if (job.aiProfile?.status === "running" || job.aiProfile?.status === "queued") job.aiProfile = { status: "cancelled", error: null };
  if (job.evidenceReview?.status === "running") job.evidenceReview = { ...job.evidenceReview, status: "cancelled", error: null };
  if (job.operationLoop && ["queued", "running"].includes(job.operationLoop.status)) {
    job.operationLoop.status = "cancelled";
    job.operationLoop.activeOperation = null;
    job.operationLoop.stopReason = "Audit cancelled by user";
  }
  job.reportMarkdown = null;
  job.reportState = { status: "cancelled", reason: "Audit cancelled by user before final findings publication", finalizedAt: null, finalizedBy: null };
  addEvent(job, "job", "cancelled", "Audit cancelled by user");
}

function skippedRun(tool, version, reason) {
  return { runId: randomUUID(), tool, version, status: "skipped", exitCode: null, timedOut: false, cancelled: false, truncated: false, commandSummary: null, error: reason, outputDigest: null };
}

function toToolRun(tool, version, status, result) {
  return {
    runId: randomUUID(),
    tool,
    version,
    status,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    cancelled: Boolean(result.cancelled),
    truncated: result.truncated,
    commandSummary: result.commandSummary,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    error: result.error,
    outputDigest: sourceHash(`${result.stdout || ""}\n${result.stderr || ""}`),
  };
}

function withOperationProvenance(run, job, operation) {
  return {
    runId: run.runId || randomUUID(),
    ...run,
    operationId: operation?.id || null,
    operationKind: operation?.kind || null,
    questionId: operation?.questionId || null,
    sourceHash: job.sourceHash,
    operationSpecDigest: operation?.specDigest || null,
    evidenceRevision: job.evidenceRevision,
    outputDigest: run.outputDigest || sourceHash(JSON.stringify({ tool: run.tool, status: run.status, normalizedEvidence: run.normalizedEvidence || null, profiles: run.profiles || null })),
  };
}

function bindFindingToOperation(finding, job, operation) {
  for (const evidence of finding.evidence || []) Object.assign(evidence, {
    operationId: operation?.id || null,
    operationKind: operation?.kind || null,
    questionId: operation?.questionId || null,
    sourceHash: job.sourceHash,
    operationSpecDigest: operation?.specDigest || null,
  });
}

function inSealedSource(finding) {
  const file = String(finding?.location?.file || "").replaceAll("\\", "/").replace(/^\.\//, "");
  return file === "src/Target.sol" || file === "Target.sol";
}

function safeArtifactSuffix(value) {
  return String(value || "operation").replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 96) || "operation";
}

function conciseFailure(label, result, extra = null) {
  if (result.timedOut) return `${label} timed out`;
  const detail = extra || result.error || result.stderr.trim().split("\n").slice(-1)[0] || `exit ${result.exitCode}`;
  return `${label} failed: ${detail.slice(0, 240)}`;
}

function foundryBuildArgs(jobDir, { offline = true, extra = [] } = {}) {
  const args = ["build", "--root", jobDir];
  if (offline) args.push("--offline");
  return [...args, ...extra];
}

function declaredCompilerRequirement(source) {
  const match = stripSolidityComments(String(source || "")).match(/\bpragma\s+solidity\s+([^;]+);/i);
  return match?.[1]?.trim() || null;
}

function isCompilerUnavailable(resultOrMessage) {
  const text = typeof resultOrMessage === "string"
    ? resultOrMessage
    : `${resultOrMessage?.error || ""}\n${resultOrMessage?.stdout || ""}\n${resultOrMessage?.stderr || ""}`;
  return /found solidity sources, but no compiler versions are available|no compiler versions are available|could not find (?:a )?solc|solc(?: compiler)? (?:is )?(?:not found|not installed|unavailable)|compiler(?: version)?(?:s)? (?:is |are )?(?:not found|not installed|unavailable)|offline mode.*(?:compiler|solc)|(?:can(?:not|'t)|unable to|failed to) (?:install|download).*solc|missing solc[^\n]*offline mode/i.test(text);
}

function compilerUnavailableReason(job) {
  const requirement = declaredCompilerRequirement(job.source);
  const scoped = requirement ? ` for pragma ${requirement}` : "";
  return `Local Solidity compiler unavailable${scoped}. Attest tried the user compiler cache and Foundry's compiler-fetch fallback, but compiled artifacts are still unavailable. AI source review will continue, while Foundry, Anvil, fork, and compiler-matrix checks are disabled for this run. Install or cache a matching solc compiler, then rerun local testing.`;
}

function disableCompileDependentExecution(job, reason) {
  job.compilerAvailability = { status: "unavailable", requirement: declaredCompilerRequirement(job.source), reason };
  job.compileSettings = { ...job.compileSettings, compilerStatus: "unavailable", compilerReason: reason };
  job.executionPermissions = { ...job.executionPermissions, localExecution: false, anvil: false, forks: false };
  job.runGeneratedTests = false;
  if (job.anvil?.requested || job.runAnvil) job.anvil = { ...(job.anvil || {}), requested: true, status: "unavailable", reason };
  if (!job.limitations.includes(reason)) job.limitations.unshift(reason);
}

function compactForgeEvidence(result) {
  const combined = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  const lines = combined.split("\n");
  const signalLines = lines.filter((line) => /\[PASS\]|\[FAIL|Suite result:|Failing tests:|Backtrace:|Compiler run|Encountered \d+|Revert\]|Return\]/i.test(line));
  const traceTail = lines.slice(-180);
  const summary = [...new Set([...signalLines, ...traceTail])].join("\n").slice(-24_000);
  return {
    exitCode: result.exitCode,
    timedOut: Boolean(result.timedOut),
    truncated: Boolean(result.truncated),
    summary,
  };
}

async function assertSubmittedSourceUnchanged(job) {
  try {
    const isolatedSource = await readFile(path.join(job.jobDir, "src", "Target.sol"), "utf8");
    if (sourceHash(isolatedSource) !== job.sourceHash || isolatedSource !== job.source) throw new Error("The isolated submitted source changed during the audit; evidence execution was stopped");
    job.sourceIntegrity = { status: "verified", expectedHash: job.sourceHash, checkedAt: now(), error: null };
    return true;
  } catch (error) {
    job.sourceIntegrity = { status: "failed", expectedHash: job.sourceHash, checkedAt: now(), error: error.message };
    throw error;
  }
}

function stripSolidityComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
}

function stripSolidityStrings(source) {
  return source.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
}

function functionBodyAt(source, start) {
  const open = source.indexOf("{", start);
  if (open < 0) return null;
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}" && --depth === 0) return source.slice(open + 1, index);
  }
  return null;
}

function assertionExpressions(body) {
  const expressions = [];
  const pattern = /\b(?:require|assert)\s*\(/g;
  for (const match of body.matchAll(pattern)) {
    const open = match.index + match[0].lastIndexOf("(");
    let depth = 0;
    let end = -1;
    for (let index = open; index < body.length; index++) {
      if (body[index] === "(") depth += 1;
      else if ((body[index] === "," && depth === 1) || (body[index] === ")" && --depth === 0)) { end = index; break; }
    }
    if (end > open) expressions.push(body.slice(open + 1, end).trim());
  }
  return expressions;
}

function clearlyVacuousAssertion(expression) {
  const normalized = expression.replace(/\s+/g, "").replace(/^\((.*)\)$/, "$1");
  if (/^(?:true|false)$/.test(normalized)) return true;
  if (!/[A-Za-z_]/.test(normalized)) return true;
  const equality = normalized.match(/^(.+?)(?:==|>=|<=)(.+)$/);
  return Boolean(equality && equality[1] === equality[2]);
}

function targetReceiversInCode(code, contractNames) {
  const receivers = new Set();
  for (const contractName of contractNames) {
    const escaped = escapeRegex(contractName);
    const declarations = [...code.matchAll(new RegExp(`\\b${escaped}\\s+([A-Za-z_][A-Za-z0-9_]*)\\b`, "g"))].map((match) => match[1]);
    for (const receiver of declarations) {
      const directInitialization = new RegExp(`\\b${escaped}\\s+${escapeRegex(receiver)}\\s*=\\s*new\\s+${escaped}\\s*\\(`).test(code);
      const laterInitialization = new RegExp(`\\b${escapeRegex(receiver)}\\s*=\\s*new\\s+${escaped}\\s*\\(`).test(code);
      if (directInitialization || laterInitialization) receivers.add(receiver);
    }
  }
  return [...receivers];
}

function assertionsGroundedInTarget(body, functionNames, allowedReceivers = []) {
  if (!functionNames.length) return false;
  const callPattern = new RegExp(`\\b([A-Za-z_][A-Za-z0-9_]*)\\s*\\.\\s*(?:${functionNames.map(escapeRegex).join("|")})\\s*\\(`, "g");
  const allowed = new Set(allowedReceivers);
  const receivers = [...body.matchAll(callPattern)].map((match) => match[1]).filter((receiver) => allowed.has(receiver));
  if (!receivers.length) return false;
  return assertionExpressions(body).some((expression) => {
    if (clearlyVacuousAssertion(expression)) return false;
    if (receivers.some((receiver) => {
      const compact = expression.replace(/\s+/g, "");
      return new RegExp(`^address\\(${escapeRegex(receiver)}\\)(?:!=|==)address\\(0\\)$`).test(compact);
    })) return false;
    if (receivers.some((receiver) => new RegExp(`\\b${escapeRegex(receiver)}\\b`).test(expression))) return true;
    const identifiers = [...expression.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)].map((match) => match[0]);
    return identifiers.some((identifier) => receivers.some((receiver) => {
      const assignment = new RegExp(`\\b${escapeRegex(identifier)}\\s*=\\s*[^;]*(?:\\b${escapeRegex(receiver)}\\s*\\.|address\\s*\\(\\s*${escapeRegex(receiver)}\\s*\\))`);
      return assignment.test(body);
    }));
  });
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function analysisEnvironment(jobDir) {
  const keys = ["PATH", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR"];
  const env = Object.fromEntries(keys.filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  const toolHome = path.join(jobDir, ".tool-home");
  env.HOME = toolHome;
  env.XDG_CONFIG_HOME = path.join(toolHome, ".config");
  env.XDG_CACHE_HOME = path.join(toolHome, ".cache");
  env.USER = "attest";
  env.LOGNAME = "attest";
  env.FOUNDRY_OFFLINE = "true";
  return env;
}

function foundryEnvironment(jobDir, { allowCompilerDownload = false } = {}) {
  const env = analysisEnvironment(jobDir);
  const userHome = process.env.HOME;
  if (userHome && path.isAbsolute(userHome)) {
    env.HOME = userHome;
    env.XDG_CACHE_HOME = process.env.XDG_CACHE_HOME && path.isAbsolute(process.env.XDG_CACHE_HOME)
      ? process.env.XDG_CACHE_HOME
      : path.join(userHome, ".cache");
  }
  env.XDG_CONFIG_HOME = path.join(jobDir, ".tool-home", ".config");
  env.FOUNDRY_OFFLINE = allowCompilerDownload ? "false" : "true";
  return env;
}

export const __test = { deduplicate, corroborate, sourceHash, validateAiResult, validateGeneratedTest, classifyGeneratedTestFailure, generatedTestStageStatus, generatedToolRunStatus, deriveFinalStatus, projectCompletedArtifactJob, finalReportCompletionMessage, runtimeVerificationCompleted, compactForgeEvidence, assertSubmittedSourceUnchanged, assertDeploymentCandidateSupportedByMessage, isQuestionOnlyContext, applyCopilotDeveloperInputs, currentFollowupActions, normalizeCampaignPlans, controllerCampaignCapacity, refreshFollowupActions, ensureRecommendedTestingAction, activateRecommendedTestingCampaign, materializeControllerQuestion, splitCompoundVerificationQuestions, normalizeSourceConclusions, normalizeSourceFindings, normalizeVerificationQuestions, reconcileVerificationArtifacts, normalizeRestoredJob, cleanupGeneratedHarnesses, isExplicitFollowupRunRequest, completeFollowupState, rollbackFollowupState, failFollowup, failJob, initializeAiStateFromProfile, unresolvedControllerQuestionIds, requiredUnresolvedQuestionIds, mergeStableVerificationQuestions, buildFullCoverageQuestions, assessCoverageApplicability, compilerMatrixScopeComplete, updateCoverageObligation, reconcileFullCoverageAfterAdjudication, controllerOperationQuestionIds, retryableControllerSpecDigests, refreshDeploymentFixturePlan, foundryBuildArgs, analysisEnvironment, foundryEnvironment, declaredCompilerRequirement, isCompilerUnavailable, compilerUnavailableReason, disableCompileDependentExecution };
