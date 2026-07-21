import {
  evaluateEvidenceRoutes,
  notVerifiedAnswer,
  sourceRouteCanAnswer,
} from "./audit-domain.js";
import { effectiveTestPlans, supersedeCorrectedTestPlans } from "./test-plan-state.js";

const TERMINAL_QUESTION_STATES = new Set(["verified", "confirmed-concern", "accepted-behavior", "developer-decision"]);

export function applyEvidenceReview(job, rawReview = {}) {
  const sourceLines = String(job.source || "").split("\n");
  const questions = Array.isArray(job.verificationQuestions) ? job.verificationQuestions : [];
  const plans = Array.isArray(job.ai?.result?.testPlans) ? job.ai.result.testPlans : [];
  const knownQuestionIds = new Set(questions.map((item) => item.id));
  const knownTestIds = new Set(plans.map((item) => item.id));
  const testReviews = firstById(rawReview.testResults, "testId", knownTestIds);

  for (const plan of plans) {
    plan.rawExecutionOutcome ??= {
      executionStatus: plan.executionStatus,
      failureKind: plan.failureKind ?? null,
      executionMessage: plan.executionMessage ?? "",
      executionEvidence: plan.executionEvidence ?? null,
    };
    const review = testReviews.get(plan.id);
    const accepted = normalizeTestReview(plan, review, sourceLines, knownQuestionIds);
    plan.oracleReview = accepted;
    if (accepted.verdict === "ai-supported-pass") {
      plan.executionStatus = "executed-ai-supported";
      plan.failureKind = null;
      plan.executionMessage = `AI-supported within the recorded test scope: ${accepted.rationale}`;
    } else if (accepted.verdict === "ai-supported-failure") {
      plan.executionStatus = "failed";
      plan.failureKind = "property-failure";
      plan.executionMessage = `AI-supported property concern; independent confirmation required: ${accepted.rationale}`;
    } else if (accepted.verdict === "invalid-test") {
      plan.executionStatus = "invalid-test";
      plan.failureKind = "invalid-oracle";
      plan.executionMessage = `Invalid generated test; no contract conclusion: ${accepted.rationale}`;
    } else {
      restoreRawExecutionOutcome(plan);
    }
  }

  const currentPlans = supersedeCorrectedTestPlans(job);

  const questionReviews = firstById(rawReview.questionResults, "questionId", knownQuestionIds);
  const questionResults = questions.map((question) => normalizeQuestionReview(
    question,
    questionReviews.get(question.id),
    sourceLines,
    knownTestIds,
    currentPlans.filter((plan) => plan.questionIds?.includes(question.id)).map((plan) => plan.id),
    currentPlans,
    job,
  ));
  job.evidenceReview = {
    status: "completed",
    testResults: plans.map((plan) => ({ testId: plan.id, ...plan.oracleReview })),
    questionResults,
    additionalPasses: questionResults.filter((item) => item.nextCheck.needed).map((item) => ({ questionId: item.questionId, ...item.nextCheck })),
  };
  recalculateCampaign(job);
  updateSuiteStatuses(job);
  return job.evidenceReview;
}

export function markEvidenceReviewUnavailable(job, reason) {
  const questions = Array.isArray(job.verificationQuestions) ? job.verificationQuestions : [];
  const plans = Array.isArray(job.ai?.result?.testPlans) ? job.ai.result.testPlans : [];
  for (const plan of plans) {
    restoreRawExecutionOutcome(plan);
    plan.oracleReview = { verdict: "not-verified", rationale: reason, questionIds: plan.questionIds || [], sourceEvidence: [] };
  }
  job.evidenceReview = {
    status: "failed",
    error: reason,
    testResults: plans.map((plan) => ({ testId: plan.id, ...(plan.oracleReview || { verdict: "not-verified", rationale: reason, questionIds: plan.questionIds || [], sourceEvidence: [] }) })),
    questionResults: questions.map((question) => ({
      questionId: question.id,
      status: "not-verified",
      answer: notVerifiedAnswer(question, "", reason),
      confidence: "low",
      relatedTestIds: plans.filter((plan) => plan.questionIds?.includes(question.id)).map((plan) => plan.id),
      sourceEvidence: [],
      nextCheck: defaultNextCheckForQuestion(question, { objective: `Review evidence for: ${question.question}` }, reason),
    })),
    additionalPasses: [],
  };
  recalculateCampaign(job);
  updateSuiteStatuses(job);
  return job.evidenceReview;
}

function normalizeTestReview(plan, review, sourceLines, knownQuestionIds) {
  const questionIds = (plan.questionIds || []).filter((id) => knownQuestionIds.has(id));
  const evidence = validateSourceEvidence(review?.sourceEvidence, sourceLines);
  const testEvidence = validateTestEvidence(review?.testEvidence, plan.code);
  const rationale = String(review?.rationale || "").trim();
  let verdict = review?.verdict;
  const initial = plan.executionStatus;
  const transitionAllowed = verdict === "verified-pass"
    ? ["executed-needs-oracle", "executed-ai-supported"].includes(initial)
    : verdict === "confirmed-failure"
      ? initial === "failed" && ["unverified-assertion", "property-failure"].includes(plan.failureKind)
      : verdict === "invalid-test"
        ? ["executed-needs-oracle", "failed", "rejected", "invalid-test"].includes(initial)
        : verdict === "not-verified";
  if (!transitionAllowed || !rationale || (verdict !== "not-verified" && (evidence.length === 0 || testEvidence.length === 0))) verdict = "not-verified";
  if (verdict === "verified-pass") verdict = "ai-supported-pass";
  if (verdict === "confirmed-failure") verdict = "ai-supported-failure";
  return {
    verdict,
    assurance: verdict === "not-verified" ? "none" : "ai-adjudicated",
    rationale: rationale || "No source-supported oracle decision was returned",
    questionIds,
    sourceEvidence: evidence,
    testEvidence,
  };
}

function normalizeQuestionReview(question, review, sourceLines, knownTestIds, inferredTestIds, plans, job) {
  let evidence = validateSourceEvidence(review?.sourceEvidence, sourceLines);
  let status = review?.status;
  let answer = String(review?.answer || "").trim();
  const reviewReason = String(review?.nextCheck?.reason || "").trim();
  if (!TERMINAL_QUESTION_STATES.has(status) && status !== "not-verified") status = "not-verified";
  if (!answer || (status !== "not-verified" && evidence.length === 0)) status = "not-verified";
  const relatedTestIds = [...new Set(inferredTestIds.filter((id) => knownTestIds.has(id)))];
  const relatedPlans = plans.filter((plan) => relatedTestIds.includes(plan.id));
  if (["verified", "confirmed-concern"].includes(status) && !requiredEvidenceSatisfied(question, relatedPlans, job, evidence).satisfied) status = "not-verified";
  if (status === "accepted-behavior" && !hasExplicitDeclaredIntent(job.declaredContext)) status = "developer-decision";
  if (status === "verified") status = "ai-supported";
  if (status === "confirmed-concern") status = "ai-supported-concern";
  const sourceSupport = status === "not-verified" ? sourceSupportedAnswer(question, job, sourceLines) : null;
  if (sourceSupport) {
    status = "ai-supported";
    answer = sourceSupport.answer;
    evidence = sourceSupport.evidence;
  }
  const nextCheck = normalizeNextCheck(review?.nextCheck, status, question);
  const evidenceClasses = status === "not-verified" ? [] : achievedEvidenceClasses(question, relatedPlans, job, evidence);
  if (status === "not-verified") answer = notVerifiedAnswer(question, answer, reviewReason || "The available evidence did not satisfy the question's evidence route");
  return {
    questionId: question.id,
    status,
    answer: answer || notVerifiedAnswer(question, "", "The available evidence did not answer this verification question"),
    confidence: sourceSupport?.confidence || (["low", "medium", "high"].includes(review?.confidence) ? review.confidence : "low"),
    relatedTestIds,
    sourceEvidence: evidence,
    evidenceClasses,
    assurance: evidenceClasses.at(-1) || "not-verified",
    nextCheck,
  };
}

function sourceSupportedAnswer(question, job, sourceLines) {
  if (!sourceReasoningCanAnswer(question)) return null;
  const conclusion = [...(job.sourceConclusions || []), ...(job.sourceFindings || [])].find((item) =>
    item?.sourceValidated && item.relatedQuestionIds?.includes(question.id)
  );
  if (!conclusion) return null;
  const evidence = validateSourceEvidence(conclusion.evidence || conclusion.sourceEvidence, sourceLines);
  if (!evidence.length) return null;
  return {
    answer: conclusion.statement || conclusion.summary || conclusion.title,
    evidence,
    confidence: ["low", "medium", "high"].includes(conclusion.confidence) ? conclusion.confidence : "medium",
  };
}

function sourceReasoningCanAnswer(question) {
  return sourceRouteCanAnswer(question);
}

function achievedEvidenceClasses(question, relatedPlans, job, sourceEvidence) {
  const classes = [];
  if (sourceEvidence.length) classes.push("ai-source-supported");
  const supportedPlans = relatedPlans.filter((plan) => ["ai-supported-pass", "ai-supported-failure"].includes(plan.oracleReview?.verdict));
  const route = requiredEvidenceSatisfied(question, relatedPlans, job, sourceEvidence).matchedRoute || [];
  const runtime = route.some((kind) => ["anvil-deployment", "anvil-observation", "anvil-scenario"].includes(kind));
  if (runtime) classes.push("runtime-observed");
  if (route.includes("fork") && supportedPlans.some((plan) => plan.networkEvidence?.blockHash)) classes.push("fork-tested");
  if (route.includes("foundry") && supportedPlans.some((plan) => ["fuzz", "invariant"].includes(plan.testType))) classes.push("adversarially-tested");
  else if (route.includes("foundry") && supportedPlans.length) classes.push("unit-tested");
  if (route.includes("compiler-matrix")) classes.push("compiler-validated");
  return classes;
}

function hasExplicitDeclaredIntent(context) {
  if (!context || typeof context !== "object") return false;
  return [context.intendedBehaviors, context.acceptedRisks]
    .some((value) => typeof value === "string" && value.trim().length > 0);
}

function requiredEvidenceSatisfied(question, relatedPlans, job, sourceEvidence) {
  const completedTools = (job.toolRuns || []).filter((run) => run.status === "completed").map((run) => String(run.tool || "").toLowerCase());
  const operationRuns = (kind) => (job.toolRuns || []).filter((run) => run.status === "completed"
    && run.operationKind === kind
    && run.questionId === question.id
    && run.sourceHash === job.sourceHash
    && typeof run.operationSpecDigest === "string"
    && run.operationSpecDigest.length === 64);
  const matchingAnvilRuns = () => ["anvil-deployment", "anvil-scenario"]
    .flatMap((kind) => operationRuns(kind))
    .filter((run) => run.normalizedEvidence?.status === "completed");
  const satisfiesKind = (kind) => {
    if (kind === "source") return sourceEvidence.length > 0;
    if (kind === "foundry") return relatedPlans.some((plan) => ["ai-supported-pass", "ai-supported-failure"].includes(plan.oracleReview?.verdict));
    if (kind === "anvil-deployment") return matchingAnvilRuns().some((run) => /^0x[0-9a-f]{40}$/i.test(run.normalizedEvidence.contractAddress || "") && run.normalizedEvidence.deploymentReceipt);
    if (kind === "anvil-observation") return matchingAnvilRuns().some((run) => anvilObservationEvidenceSatisfied(question, run.normalizedEvidence));
    if (kind === "anvil-scenario") return matchingAnvilRuns().some((run) => ["completed", "property-failure"].includes(run.normalizedEvidence.scenario?.status));
    if (kind === "fork") return relatedPlans.some((plan) => ["ai-supported-pass", "ai-supported-failure"].includes(plan.oracleReview?.verdict) && plan.networkEvidence?.blockHash);
    if (kind === "compiler-matrix") return operationRuns("compiler-matrix").length > 0;
    if (kind === "analyzer") {
      const runs = ["slither", "aderyn"].flatMap((tool) => operationRuns(tool));
      if (!runs.length) return false;
      // A completed, source-bound zero-finding run is real negative analyzer
      // evidence. It does not prove the property by itself; the question's
      // sufficient route and the AI adjudication still decide that.
      if (runs.some((run) => Number(run.findingCount) === 0)) return true;
      return analyzerEvidenceOverlapsQuestion(job, question, sourceEvidence, completedTools);
    }
    if (kind === "developer-context") return (job.developerEvidence || []).some((item) =>
      item.validation === "accepted" && item.kind === "audit-context" && item.relatedQuestionIds?.includes(question.id)
    );
    return false;
  };
  return evaluateEvidenceRoutes(question, satisfiesKind);
}

function hasAnvilScenarioConcernEvidence(question, job) {
  if (!(question.requiredEvidenceKinds || []).includes("anvil-scenario")) return false;
  return (job.toolRuns || []).some((run) => run.status === "completed"
    && run.operationKind === "anvil-scenario"
    && run.questionId === question.id
    && run.sourceHash === job.sourceHash
    && typeof run.operationSpecDigest === "string"
    && run.operationSpecDigest.length === 64
    && run.normalizedEvidence?.status === "completed"
    && run.normalizedEvidence.scenario?.status === "property-failure"
    && run.normalizedEvidence.scenario.steps?.some((step) => step.status === "completed" && step.matchedExpectation === false));
}

function anvilObservationEvidenceSatisfied(question, evidence) {
  if (evidence?.status !== "completed") return false;
  const text = `${question.question || ""} ${question.expectedEvidence || ""}`.toLowerCase();
  if (/(?:construct|deploy).*(?:transfer|event)|(?:transfer|event).*(?:construct|deploy)/.test(text)) return deploymentTransferEvidenceSatisfied(evidence);
  if (/transfer|withdraw|deposit|swap|approve|reentran|unauthorized|transaction|event/.test(text)) return false;
  const required = [];
  const allocationClaim = /total\s*supply|totalsupply|balance|tokens?|units?|allocat|assign/.test(text);
  if (/total\s*supply|totalsupply/.test(text)) required.push("total-supply");
  if (allocationClaim && /deployer|actor[- ]?0|all\s+(?:tokens|units)|every\s+unit|initial\s+allocation/.test(text)) required.push("total-supply", "balance-actor-0");
  if (allocationClaim && /only\s+(?:the\s+)?deployer|all\s+(?:tokens|units)|every\s+unit|another|second|other\s+account|non-deployer|actor[- ]?1/.test(text)) required.push("balance-actor-1");
  if (/balance/.test(text)) {
    required.push("balance-actor-0");
    if (/another|second|other\s+account|non-deployer|actor[- ]?1/.test(text)) required.push("balance-actor-1");
  }
  if (/\bowner\b/.test(text)) required.push("owner");
  if (!required.length) return false;
  const observations = new Map((evidence.observations || [])
    .filter((item) => item.status === "completed" && item.value !== undefined)
    .map((item) => [item.id, String(item.value)]));
  if (![...new Set(required)].every((id) => observations.has(id))) return false;
  const supply = decimalBigInt(observations.get("total-supply"));
  const deployerBalance = decimalBigInt(observations.get("balance-actor-0"));
  const otherBalance = decimalBigInt(observations.get("balance-actor-1"));
  const owner = String(observations.get("owner") || "").toLowerCase();
  if (allocationClaim && /deployer|actor[- ]?0|all\s+(?:tokens|units)|every\s+unit|initial\s+allocation/.test(text)) {
    if (supply === null || deployerBalance === null || supply !== deployerBalance) return false;
  }
  if (allocationClaim && /only\s+(?:the\s+)?deployer|another|second|other\s+account|non-deployer|actor[- ]?1/.test(text)) {
    if (otherBalance === null || otherBalance !== 0n) return false;
  }
  if (/\bowner\b/.test(text)) {
    if (!/^0x[0-9a-f]{40}$/.test(owner)) return false;
    if (/owner.{0,40}(?:deployer|actor[- ]?0)|(?:deployer|actor[- ]?0).{0,40}owner/.test(text) && owner !== String(evidence.deployer || "").toLowerCase()) return false;
    const expectedAddress = text.match(/0x[0-9a-f]{40}/)?.[0];
    if (expectedAddress && owner !== expectedAddress) return false;
  }
  return true;
}

function deploymentTransferEvidenceSatisfied(evidence) {
  const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const contract = String(evidence?.contractAddress || "").toLowerCase();
  const deployer = String(evidence?.deployer || "").toLowerCase().replace(/^0x/, "");
  const supplyText = (evidence?.observations || []).find((item) => item.id === "total-supply" && item.status === "completed")?.value;
  const supply = decimalBigInt(String(supplyText ?? ""));
  if (!/^0x[0-9a-f]{40}$/.test(contract) || !/^[0-9a-f]{40}$/.test(deployer) || supply === null) return false;
  const logs = (evidence?.deploymentReceipt?.logs || []).filter((log) =>
    String(log.address || "").toLowerCase() === contract && String(log.topics?.[0] || "").toLowerCase() === transferTopic
  );
  if (logs.length !== 1) return false;
  const log = logs[0];
  const from = String(log.topics?.[1] || "").toLowerCase();
  const to = String(log.topics?.[2] || "").toLowerCase();
  const data = String(log.data || "");
  if (!/^0x0{64}$/.test(from) || to !== `0x${"0".repeat(24)}${deployer}` || !/^0x[0-9a-f]{64}$/i.test(data)) return false;
  try { return BigInt(data) === supply; } catch { return false; }
}

function decimalBigInt(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  try { return BigInt(value); } catch { return null; }
}

function analyzerEvidenceOverlapsQuestion(job, question, sourceEvidence, completedTools) {
  const completedAnalyzers = ["slither", "aderyn", "mythril", "halmos", "echidna"].filter((name) => completedTools.some((tool) => tool.includes(name)));
  if (!completedAnalyzers.length) return false;
  return (job.findings || []).some((finding) => {
    const lineStart = finding.location?.lineStart;
    const lineEnd = finding.location?.lineEnd || lineStart;
    if (!Number.isInteger(lineStart)) return false;
    const toolMatches = (finding.evidence || []).some((item) => completedAnalyzers.includes(String(item.tool || "").toLowerCase())
      && item.questionId === question.id
      && item.sourceHash === job.sourceHash
      && typeof item.operationSpecDigest === "string");
    const citationOverlaps = sourceEvidence.some((item) => item.lineStart <= lineEnd && item.lineEnd >= lineStart);
    return toolMatches && citationOverlaps;
  });
}

function normalizeNextCheck(value, status, question) {
  if (status !== "not-verified") return { needed: false, tool: "none", objective: "No additional check required", reason: "The verification question reached a supported terminal state" };
  return defaultNextCheckForQuestion(question, value);
}

export function defaultNextCheckForQuestion(question, value = {}, fallbackReason = "The current evidence was insufficient or invalid") {
  const allowed = new Set(["forge", "anvil", "fork", "slither", "aderyn", "compiler-matrix", "developer-context"]);
  const requestedTool = allowed.has(value?.tool) ? value.tool : null;
  let tool = requestedTool || inferNextCheckTool(question);
  const required = new Set(Array.isArray(question.requiredEvidenceKinds) ? question.requiredEvidenceKinds : []);
  let invalidDeveloperContextRoute = false;
  if (tool === "developer-context" && !required.has("developer-context")) {
    tool = inferNextCheckTool(question);
    invalidDeveloperContextRoute = true;
  }
  return {
    needed: true,
    tool,
    objective: String(value?.objective || question.expectedEvidence || `Obtain evidence answering: ${question.question}`).trim(),
    reason: invalidDeveloperContextRoute
      ? "This is an objective property. Developer opinion cannot prove it; the missing evidence must come from an executable or tool-backed check."
      : String(value?.reason || fallbackReason).trim(),
  };
}

function inferNextCheckTool(question) {
  const required = new Set(Array.isArray(question?.requiredEvidenceKinds) ? question.requiredEvidenceKinds : []);
  if (required.has("developer-context")) return "developer-context";
  if (required.has("compiler-matrix")) return "compiler-matrix";
  if (required.has("fork")) return "fork";
  if (required.has("foundry") || required.has("anvil-scenario")) return "forge";
  if (required.has("anvil-deployment") || required.has("anvil-observation")) return "anvil";
  if (required.has("analyzer")) return "slither";
  return "forge";
}

function validateSourceEvidence(items, sourceLines) {
  if (!Array.isArray(items)) return [];
  return items.filter((item) => {
    const validRange = Number.isInteger(item.lineStart) && Number.isInteger(item.lineEnd) && item.lineStart >= 1 && item.lineEnd >= item.lineStart && item.lineEnd <= sourceLines.length;
    const quote = typeof item.quote === "string" ? item.quote.trim() : "";
    return validRange && quote && sourceLines.slice(item.lineStart - 1, item.lineEnd).join("\n").includes(quote);
  }).map((item) => ({ ...item, sourceValidated: true }));
}

function validateTestEvidence(items, code) {
  if (!Array.isArray(items) || typeof code !== "string") return [];
  return items.filter((item) => {
    const quote = typeof item.quote === "string" ? item.quote.trim() : "";
    return quote && /\b(?:require|assert)\s*\(/.test(quote) && code.includes(quote);
  }).map((item) => ({ ...item, testValidated: true }));
}

function firstById(items, key, knownIds) {
  const map = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || !knownIds.has(item[key]) || map.has(item[key])) continue;
    map.set(item[key], item);
  }
  return map;
}

function recalculateCampaign(job) {
  const plans = effectiveTestPlans(job);
  job.testCampaign.passed = plans.filter((plan) => plan.executionStatus === "executed-ai-supported").length;
  job.testCampaign.awaitingOracle = plans.filter((plan) => plan.executionStatus === "executed-needs-oracle" || (plan.executionStatus === "failed" && plan.failureKind === "unverified-assertion")).length;
  job.testCampaign.failed = plans.filter((plan) => plan.executionStatus === "failed" && plan.failureKind === "property-failure").length;
  job.testCampaign.invalid = plans.filter((plan) => plan.executionStatus === "invalid-test").length;
  job.testCampaign.rejected = plans.filter((plan) => plan.executionStatus === "rejected").length;
  job.testCampaign.timedOut = plans.filter((plan) => plan.executionStatus === "timed-out").length;
}

function restoreRawExecutionOutcome(plan) {
  const raw = plan.rawExecutionOutcome;
  if (raw) {
    plan.executionStatus = raw.executionStatus;
    plan.failureKind = raw.failureKind;
    plan.executionMessage = raw.executionMessage;
    plan.executionEvidence = raw.executionEvidence;
    return;
  }
  if (plan.executionStatus === "executed-ai-supported") {
    plan.executionStatus = "executed-needs-oracle";
    plan.failureKind = null;
  } else if (plan.executionStatus === "failed" && plan.failureKind === "property-failure") {
    plan.failureKind = "unverified-assertion";
  }
}

function updateSuiteStatuses(job) {
  for (const suite of job.suitePlan || []) {
    const plans = effectiveTestPlans(job).filter((plan) => plan.suitePlanIds?.includes(suite.id));
    if (!plans.length) continue;
    if (plans.some((plan) => plan.executionStatus === "failed" && plan.failureKind === "property-failure")) suite.status = "confirmed-concern";
    else if (plans.every((plan) => plan.executionStatus === "executed-ai-supported")) suite.status = "ai-supported";
    else suite.status = "not-verified";
  }
}
