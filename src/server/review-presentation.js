import { defaultNextCheckForQuestion } from "./evidence-review.js";
import {
  buildCoverageObligations,
  buildSourceFindings,
  derivePracticalVerdict,
  notVerifiedAnswer,
  questionMateriality,
} from "./audit-domain.js";
import { effectiveTestPlans } from "./test-plan-state.js";

const SECURITY_CLASSIFICATIONS = new Set(["vulnerability", "assumption-dependent"]);
const OBSERVATION_CLASSIFICATIONS = new Set(["intentional-design", "trust-disclosure"]);
const QUALITY_CLASSIFICATIONS = new Set(["code-quality"]);
const FUND_SAFETY_CATEGORIES = new Set(["asset-flow", "authorization", "accounting", "state-transition", "external-interaction", "configuration"]);
const FUND_SAFETY_TEXT = /\b(fund|asset|balance|supply|mint|burn|owner|admin|role|auth|permission|privilege|pause|blacklist|whitelist|fee|tax|swap|slippage|liquidit|treasury|withdraw|deposit|transfer|approve|allowance|reentran|external call|oracle|price|accounting|overflow|underflow|freeze|lock|rug|drain|steal|loss|payout|claim|reward)/i;

export function buildReviewPresentation(job) {
  const fullMode = job.auditDepth === "full";
  const terminalFailure = auditFailureReason(job);
  const sourceFindings = buildSourceFindings(job);
  const classifiedSourceConclusions = sourceFindings.filter((item) => item.kind === "source-conclusion" && sourceClassification(item));
  const validatedSourceConclusionCount = classifiedSourceConclusions.length;
  const validatedSourceFindingCount = sourceFindings.filter((item) => item.kind === "source-finding" && sourceClassification(item)).length;
  const rawSourceFindingIds = new Set((Array.isArray(job.sourceFindings) ? job.sourceFindings : []).map((item) => String(item?.id || "").trim()).filter(Boolean));
  const validatedSourceFindingIds = new Set(sourceFindings.filter((item) => item.kind === "source-finding").map((item) => item.id));
  // Source findings are promoted into job.findings by the audit orchestrator.
  // Do not let an un-cited source finding bypass the exact-citation gate just
  // because that promotion happened before presentation.
  const existingCandidates = (Array.isArray(job.findings) ? job.findings : []).filter((finding) =>
    !rawSourceFindingIds.has(String(finding?.id || "")) || validatedSourceFindingIds.has(String(finding?.id || ""))
  );
  const sourceFindingCandidates = sourceFindings
    .filter((finding) => (finding.kind === "source-finding" || (finding.kind === "source-conclusion" && SECURITY_CLASSIFICATIONS.has(sourceClassification(finding))))
      && !existingCandidates.some((candidate) => candidate.id === finding.id))
    .map(sourceFindingCandidate);
  const candidates = [...existingCandidates, ...sourceFindingCandidates];
  const coverageObligations = buildCoverageObligations(job);
  const reviewComplete = job.ai?.status === "completed";
  const validated = candidates.filter((finding) => finding.aiReview?.sourceValidated);
  const rejected = validated.filter((finding) => finding.aiReview.verdict === "reject" || finding.aiReview.classification === "false-positive");
  const observations = validated.filter((finding) => finding.aiReview.verdict !== "reject" && OBSERVATION_CLASSIFICATIONS.has(finding.aiReview.classification));
  const qualityObservations = validated.filter((finding) => finding.aiReview.verdict !== "reject" && QUALITY_CLASSIFICATIONS.has(finding.aiReview.classification));
  const surfaced = validated.filter((finding) => finding.aiReview.verdict !== "reject" && SECURITY_CLASSIFICATIONS.has(finding.aiReview.classification));
  const visibleSecurityFindings = surfaced.filter((finding) => fullMode || isBlockerOrFundsSafetyFinding(finding));
  const findings = (reviewComplete ? visibleSecurityFindings : [])
    .map((finding) => ({ ...finding, decisionCategory: decisionCategory(finding) }))
    .sort((left, right) => categoryRank(left.decisionCategory) - categoryRank(right.decisionCategory));
  const blockers = findings.filter((finding) => finding.decisionCategory === "release-blocker");
  const findingDecisions = findings.filter((finding) => finding.decisionCategory === "needs-decision");
  const questionResults = buildVerificationResults(job).filter((item) => fullMode || item.requiredForOpinion || isBlockerOrFundsSafetyQuestion(item));
  const questionBlockers = questionResults.filter((item) => item.status === "ai-supported-concern"
    && item.requiredForOpinion && ["critical", "high"].includes(String(item.priority || "").toLowerCase()));
  const questionConcerns = questionResults.filter((item) => item.status === "ai-supported-concern" && !questionBlockers.includes(item));
  const questionDecisions = questionResults.filter((item) => item.status === "developer-decision");
  const questionGaps = questionResults.filter((item) => item.status === "not-verified");
  const requiredQuestionGaps = fullMode ? questionGaps : questionGaps.filter((item) => item.requiredForOpinion);
  const recommendedQuestionGaps = fullMode ? [] : questionGaps.filter((item) => !item.requiredForOpinion);
  const needsDecision = [...findingDecisions, ...questionConcerns];
  const testPlans = effectiveTestPlans(job);
  const regressionFailures = testPlans.filter((plan) => plan.executionStatus === "failed" && plan.failureKind === "property-failure");
  const reviewItems = needsDecision.length + regressionFailures.length;
  const regressionPasses = testPlans.filter((plan) => plan.executionStatus === "executed-ai-supported");
  const awaitingOracle = testPlans.filter((plan) => plan.executionStatus === "executed-needs-oracle");
  const testGaps = testPlans.filter((plan) => ["executed-needs-oracle", "not-verified", "invalid-test", "rejected", "timed-out"].includes(plan.executionStatus) || (plan.executionStatus === "failed" && plan.failureKind !== "property-failure"));
  const requiredTestGaps = fullMode ? testGaps : [];
  const recommendedTestGaps = fullMode ? [] : testGaps;
  const generatedEvidenceNeeded = questionResults.some((item) => item.status === "not-verified" && (item.requiredEvidenceKinds || []).some((kind) => ["foundry", "fork"].includes(kind)));
  const noGeneratedPlans = Boolean(job.runGeneratedTests && generatedEvidenceNeeded && testPlans.length === 0);
  const requiredNoGeneratedPlans = fullMode && noGeneratedPlans;
  const recommendedNoGeneratedPlans = !fullMode && noGeneratedPlans;
  const unvalidatedCandidates = candidates.filter((finding) => !finding.aiReview?.sourceValidated);
  const compatibilityNotes = unvalidatedCandidates.filter((finding) => isModernCompilerCompatibilityNote(finding, job.source));
  const securityUnvalidatedCandidates = unvalidatedCandidates.filter((finding) => !compatibilityNotes.includes(finding) && (fullMode || isBlockerOrFundsSafetyFinding(finding)));
  const manualReviewCandidates = reviewComplete ? securityUnvalidatedCandidates : [];
  const unreviewedCandidates = reviewComplete ? [] : securityUnvalidatedCandidates;
  const manualReview = manualReviewCandidates.length;
  const unreviewed = unreviewedCandidates.length;
  const deploymentNeedsInput = Boolean(job.runAnvil && job.anvil?.status === "needs-input");
  const requiredDeploymentNeedsInput = fullMode && deploymentNeedsInput;
  const recommendedDeploymentNeedsInput = !fullMode && deploymentNeedsInput;
  const incompleteToolRuns = (job.toolRuns || []).filter((run) =>
    run.evidenceEligible !== false && run.status !== "completed" && !run.supersededBy && !String(run.tool || "").startsWith("forge-generated:") && !(deploymentNeedsInput && run.tool === "anvil-deployment")
  );
  const requiredIncompleteToolRuns = fullMode ? incompleteToolRuns : [];
  const recommendedIncompleteToolRuns = fullMode ? [] : incompleteToolRuns;
  const requiredCoverageIncomplete = fullMode && coverageObligations.some((item) => item.required && !["completed", "server-inapplicable"].includes(item.disposition));
  const recommendedChecks = recommendedQuestionGaps.length + recommendedTestGaps.length + Number(recommendedNoGeneratedPlans) + Number(recommendedDeploymentNeedsInput) + recommendedIncompleteToolRuns.length;
  const substantiveReviewBasis = validatedSourceConclusionCount + validatedSourceFindingCount + regressionPasses.length + regressionFailures.length + findings.length > 0;
  const decisionStatus = terminalFailure
    ? "failed"
    : blockers.length || questionBlockers.length
      ? "block"
      : !reviewComplete || manualReview || unreviewed || requiredDeploymentNeedsInput || requiredIncompleteToolRuns.length || requiredTestGaps.length || requiredQuestionGaps.length || requiredNoGeneratedPlans || requiredCoverageIncomplete
        ? "incomplete"
        : reviewItems
          ? "review"
          : !substantiveReviewBasis
            ? "incomplete"
            : "ready-with-caveats";
  const practicalVerdict = terminalFailure
    ? {
        code: "audit-not-completed",
        title: "Audit did not complete",
        reason: terminalFailure,
      }
    : derivePracticalVerdict({
        blockers: blockers.length + questionBlockers.length,
        regressionFailures: regressionFailures.length,
        surfacedConcerns: findings.length,
        unresolved: requiredQuestionGaps.length + Number(requiredCoverageIncomplete) + manualReview + unreviewed + requiredIncompleteToolRuns.length,
        sourceConclusionCount: validatedSourceConclusionCount,
        sourceFindingCount: validatedSourceFindingCount,
        completedEvidenceCount: regressionPasses.length,
        reviewComplete,
        fullCoverageIncomplete: requiredCoverageIncomplete,
      });
  const usability = buildUsabilityAssessment({
    job,
    blockers: blockers.length + questionBlockers.length,
    regressionFailures: regressionFailures.length,
    regressionPasses: regressionPasses.length,
    surfacedConcerns: findings.length,
    sourceConclusionCount: validatedSourceConclusionCount,
    sourceFindingCount: validatedSourceFindingCount,
    questionGaps: requiredQuestionGaps.length,
    decisions: needsDecision.length,
    manualReview,
    unreviewed,
    incompleteTools: requiredIncompleteToolRuns.length,
    recommendedChecks,
    fullMode,
    practicalVerdict,
    coverageIncomplete: requiredCoverageIncomplete,
  });

  return {
    findings,
    releaseDecision: {
      status: decisionStatus,
      blockers: blockers.length + questionBlockers.length,
      regressionFailures: regressionFailures.length,
      regressionPasses: regressionPasses.length,
      needsDecision: reviewItems,
      context: observations.length,
      quality: fullMode ? (job.qualityFindings?.length || 0) + qualityObservations.length : 0,
      rejected: rejected.length,
      manualReview,
      unreviewed,
      testGaps: Math.max(requiredTestGaps.length + Number(requiredNoGeneratedPlans), requiredQuestionGaps.length),
      recommendedChecks,
      propertyTesting: propertyTestingSummary({ job, regressionFailures, regressionPasses, awaitingOracle, testGaps, noGeneratedPlans, fullMode }),
      usability,
      ...(coverageObligations.length ? { coverageObligations } : {}),
      nextActions: buildNextActions({
        job,
        blockers: [...blockers, ...questionBlockers],
        regressionFailures,
        needsDecision,
        manualReviewCandidates,
        unreviewedCandidates,
        deploymentNeedsInput: requiredDeploymentNeedsInput,
        incompleteToolRuns: requiredIncompleteToolRuns,
        testGaps: requiredTestGaps,
        noGeneratedPlans: requiredNoGeneratedPlans,
        questionGaps: requiredQuestionGaps,
        recommendedQuestionGaps,
        recommendedTestGaps,
        recommendedNoGeneratedPlans,
        recommendedDeploymentNeedsInput,
        recommendedIncompleteToolRuns,
      }),
    },
    verificationResults: questionResults,
    sourceFindings,
    coverageObligations,
    practicalVerdict,
    verificationSummary: {
      total: questionResults.length,
      aiSupported: questionResults.filter((item) => item.status === "ai-supported").length,
      concerns: questionResults.filter((item) => item.status === "ai-supported-concern").length,
      accepted: questionResults.filter((item) => item.status === "accepted-behavior").length,
      decisions: questionResults.filter((item) => item.status === "developer-decision").length,
      notVerified: questionGaps.length,
    },
    touchpoints: candidates.map((finding) => ({
      id: finding.id,
      location: {
        file: finding.location?.file || "src/Target.sol",
        line: finding.location?.lineStart || null,
      },
      detectors: [...new Set((finding.evidence || []).map((item) => `${item.tool}/${item.detectorId || item.kind}`))],
      state: isModernCompilerCompatibilityNote(finding, job.source) ? "contextualized" : touchpointState(finding, job.ai?.status),
      ...(isModernCompilerCompatibilityNote(finding, job.source)
        ? { reason: "Compiler-range compatibility is tracked as a dedicated verification check, not an unreviewed security defect." }
        : finding.aiReview?.rationale ? { reason: finding.aiReview.rationale } : {}),
      ...(finding.aiReview?.impact ? { impact: finding.aiReview.impact } : {}),
      ...(finding.aiReview?.trigger ? { trigger: finding.aiReview.trigger } : {}),
      ...(finding.aiReview?.action ? { action: finding.aiReview.action } : {}),
    })),
    reviewSummary: {
      status: job.ai?.status || "disabled",
      touchpoints: candidates.length,
      reviewed: validated.length,
      surfaced: reviewComplete ? findings.length : 0,
      observations: reviewComplete ? observations.length + compatibilityNotes.length + (fullMode ? qualityObservations.length : 0) : 0,
      rejected: reviewComplete ? rejected.length : 0,
      manualReview,
      unreviewed,
    },
  };
}

function isModernCompilerCompatibilityNote(finding, source) {
  const detectorText = `${finding?.id || ""} ${finding?.title || ""} ${finding?.category || ""} ${(finding?.evidence || []).map((item) => item.detectorId || "").join(" ")}`.toLowerCase();
  if (!/solc-version|compiler-version/.test(detectorText)) return false;
  const pragma = String(source || "").match(/pragma\s+solidity\s+[^;]*?(\d+)\.(\d+)/i);
  return Boolean(pragma && Number(pragma[1]) === 0 && Number(pragma[2]) >= 8);
}

function sourceFindingCandidate(finding) {
  const first = finding.evidence?.[0] || {};
  const classification = sourceClassification(finding);
  const securityClassification = SECURITY_CLASSIFICATIONS.has(classification) ? classification : null;
  return {
    id: finding.id,
    title: finding.title,
    summary: finding.summary,
    severity: finding.severity,
    confidence: finding.confidence,
    verification: "ai-reviewed",
    category: finding.category,
    location: {
      file: "src/Target.sol",
      lineStart: first.lineStart || null,
      lineEnd: first.lineEnd || first.lineStart || null,
    },
    evidence: finding.evidence,
    aiReview: {
      sourceValidated: true,
      verdict: classification ? "likely" : "needs-review",
      confidence: finding.confidence,
      classification: securityClassification || (OBSERVATION_CLASSIFICATIONS.has(classification) ? classification : QUALITY_CLASSIFICATIONS.has(classification) ? classification : "assumption-dependent"),
      rationale: finding.rationale,
      impact: finding.impact || finding.summary,
      trigger: finding.trigger || "Execution reaches the cited source path.",
      action: finding.action || "Review this source-supported behavior against the declared trust and deployment assumptions.",
      evidence: finding.evidence,
    },
    testPlans: [],
  };
}

function sourceClassification(finding) {
  const value = String(finding?.classification || "");
  return new Set(["neutral-fact", ...SECURITY_CLASSIFICATIONS, ...OBSERVATION_CLASSIFICATIONS, ...QUALITY_CLASSIFICATIONS]).has(value) ? value : "";
}

function isBlockerOrFundsSafetyFinding(finding) {
  if (["critical", "high"].includes(String(finding.severity || "").toLowerCase())) return true;
  if (FUND_SAFETY_CATEGORIES.has(finding.category)) return true;
  const text = [
    finding.id,
    finding.title,
    finding.summary,
    finding.category,
    finding.aiReview?.rationale,
    finding.aiReview?.assumptionEffect,
    ...(finding.evidence || []).map((item) => `${item.detectorId || ""} ${item.description || ""}`),
  ].join(" ");
  return FUND_SAFETY_TEXT.test(text);
}

function isBlockerOrFundsSafetyQuestion(question) {
  if (["critical", "high"].includes(String(question.priority || "").toLowerCase())) return true;
  const evidenceKinds = new Set(question.requiredEvidenceKinds || []);
  if (evidenceKinds.has("developer-context") && !FUND_SAFETY_TEXT.test(`${question.question} ${question.rationale} ${question.expectedEvidence}`)) return false;
  if (evidenceKinds.has("compiler-matrix") && !FUND_SAFETY_TEXT.test(`${question.question} ${question.rationale} ${question.expectedEvidence}`)) return false;
  return FUND_SAFETY_TEXT.test([
    question.id,
    question.question,
    question.rationale,
    question.expectedEvidence,
    question.answer,
    question.nextCheck?.objective,
    question.nextCheck?.reason,
  ].join(" "));
}

function buildUsabilityAssessment({ job, blockers, regressionFailures, regressionPasses, surfacedConcerns, sourceConclusionCount, sourceFindingCount = 0, questionGaps, decisions, manualReview, unreviewed, incompleteTools, recommendedChecks, fullMode, practicalVerdict = null, coverageIncomplete = false }) {
  const archetype = (job.contractProfile?.archetypes || [])[0];
  const purpose = ({
    "erc20-token": "ERC-20 token behavior",
    "memecoin": "token behavior",
    "erc4626-vault": "ERC-4626 vault behavior",
    "erc721-nft": "ERC-721 behavior",
    "proxy-upgradeable": "upgradeable-contract behavior",
    "governance": "governance behavior",
    "staking-rewards": "staking and reward behavior",
    "amm-dex": "exchange behavior",
    "oracle-consumer": "oracle-consumer behavior",
    "bridge-messaging": "bridge or messaging behavior",
  })[archetype] || "stated-purpose behavior";
  const unresolved = questionGaps + decisions + manualReview + unreviewed + incompleteTools + Number(coverageIncomplete);

  const terminalFailure = auditFailureReason(job);
  if (terminalFailure) {
    return {
      state: "audit-failed",
      title: "Audit did not complete",
      summary: `${terminalFailure} Retry the audit after correcting this problem; no contract-use opinion was produced.`,
      scope: purpose,
      practicalVerdict,
    };
  }

  if (blockers || regressionFailures) {
    return {
      state: "not-usable",
      title: "Do not use this contract as submitted",
      summary: `${blockers} blocking issue(s) and ${regressionFailures} failed contract propert${regressionFailures === 1 ? "y" : "ies"} must be resolved and retested.`,
      scope: purpose,
      practicalVerdict,
    };
  }
  if (regressionPasses > 0 && surfacedConcerns === 0) {
    const unresolvedSummary = unresolved
      ? fullMode
        ? ` It has not cleared full-audit coverage: ${questionGaps} required verification check${questionGaps === 1 ? "" : "s"}, ${decisions} developer decision${decisions === 1 ? "" : "s"}, ${manualReview + unreviewed} review item${manualReview + unreviewed === 1 ? "" : "s"}, and ${incompleteTools} required tool check${incompleteTools === 1 ? "" : "s"} remain.`
        : ` It still has ${decisions} developer decision${decisions === 1 ? "" : "s"} and ${manualReview + unreviewed} review item${manualReview + unreviewed === 1 ? "" : "s"} to resolve for the selected scope.${recommendedChecks ? ` ${recommendedChecks} additional check${recommendedChecks === 1 ? " is" : "s are"} available for stronger assurance.` : ""}`
      : recommendedChecks
        ? ` ${recommendedChecks} additional check${recommendedChecks === 1 ? " is" : "s are"} available for stronger assurance, but ${fullMode ? "full-audit coverage" : "the selected scope"} did not depend on them.`
        : " The selected automated checks are complete; independent human review is still required before production use.";
    return {
      state: unresolved ? "usable-tested-scope" : "usable-tested-scope-complete",
      title: `Usable in the completed ${purpose} test scope`,
      summary: `Attest found no contract-breaking behavior in ${regressionPasses} supported property check${regressionPasses === 1 ? "" : "s"} and no source-validated security concern.${unresolvedSummary}`,
      scope: purpose,
      practicalVerdict,
    };
  }
  if ((sourceConclusionCount > 0 || sourceFindingCount > 0) && surfacedConcerns === 0 && unresolved === 0) {
    return {
      state: "no-source-blocker-found",
      title: `No blocker found in AI review scope`,
      summary: `Attest traced the source and found no source-validated blocker or funds-safety concern in the selected scope for ${purpose}.${recommendedChecks ? ` ${recommendedChecks} stronger verification check${recommendedChecks === 1 ? " is" : "s are"} available if you want runtime or broader assurance.` : " Optional deeper testing remains available through a broader audit depth."}`,
      scope: purpose,
      practicalVerdict,
    };
  }
  if (reviewCompleteEnough({ sourceConclusionCount, sourceFindingCount, surfacedConcerns, unresolved, manualReview, unreviewed })) {
    return {
      state: "no-source-blocker-found",
      title: "No blocker found in AI review scope",
      summary: `Attest did not surface a source-validated blocker or funds-safety concern in the selected scope for ${purpose}.${recommendedChecks ? ` ${recommendedChecks} recommended verification check${recommendedChecks === 1 ? " remains" : "s remain"} for stronger assurance.` : " Use a higher audit depth if you want executable proof rather than source-review confidence."}`,
      scope: purpose,
      practicalVerdict,
    };
  }
  return {
    state: surfacedConcerns ? "needs-review" : "not-established",
    title: surfacedConcerns ? "Review required before this contract is used" : "Contract usability was not established",
    summary: surfacedConcerns
      ? `${surfacedConcerns} source-validated security concern${surfacedConcerns === 1 ? "" : "s"} require a decision, and the completed testing did not establish safe use for ${purpose}.`
      : `No failed contract property was confirmed, but the completed evidence did not establish usable behavior for ${purpose}. Run or resolve the specific checks listed below.`,
    scope: purpose,
    practicalVerdict,
  };
}

function auditFailureReason(job) {
  if (job?.status !== "failed") return null;
  const event = (Array.isArray(job.worklog) ? job.worklog : []).findLast((item) => item?.stage === "job" && item?.status === "failed")
    || (Array.isArray(job.worklog) ? job.worklog : []).findLast((item) => item?.status === "failed");
  return String(event?.message || job?.reportState?.reason || "Attest stopped before final findings could be generated.").trim().slice(0, 1200);
}

function reviewCompleteEnough({ sourceConclusionCount, sourceFindingCount = 0, surfacedConcerns, unresolved, manualReview, unreviewed }) {
  return surfacedConcerns === 0 && unresolved === 0 && manualReview === 0 && unreviewed === 0 && sourceConclusionCount + sourceFindingCount > 0;
}

function propertyTestingSummary({ job, regressionFailures, regressionPasses, awaitingOracle, testGaps, noGeneratedPlans, fullMode }) {
  if (!job.runGeneratedTests) return { status: "not-run", label: "Not run" };
  if (noGeneratedPlans) return { status: "attention", label: "0 AI-supported; no runnable property check generated" };
  if (!regressionFailures.length && !testGaps.length && !effectiveTestPlans(job).length) return { status: "not-needed", label: "No generated property was needed for the source-only conclusions" };
  if (!regressionFailures.length && !testGaps.length) return { status: "completed", label: `${regressionPasses.length} AI-supported` };
  const rejected = testGaps.filter((plan) => plan.executionStatus === "rejected").length;
  const timedOut = testGaps.filter((plan) => plan.executionStatus === "timed-out").length;
  const broken = testGaps.filter((plan) => ["failed", "invalid-test"].includes(plan.executionStatus)).length;
  return {
    status: fullMode ? "attention" : "recommended",
    label: fullMode
      ? `${regressionPasses.length} AI-supported; ${regressionFailures.length} AI-supported failed properties; ${awaitingOracle.length} executed awaiting oracle review; ${rejected} rejected before Forge; ${broken} property-check execution errors; ${timedOut} timed out`
      : `${regressionPasses.length} AI-supported; ${testGaps.length} optional stronger check${testGaps.length === 1 ? "" : "s"} need retry or review`,
  };
}

function buildNextActions({ job, blockers, regressionFailures, needsDecision, manualReviewCandidates, unreviewedCandidates, deploymentNeedsInput, incompleteToolRuns, testGaps, noGeneratedPlans, questionGaps, recommendedQuestionGaps = [], recommendedTestGaps = [], recommendedNoGeneratedPlans = false, recommendedDeploymentNeedsInput = false, recommendedIncompleteToolRuns = [] }) {
  const actions = [];
  if (blockers.length) actions.push({ required: true, title: `Address ${blockers.length} blocking issue(s)`, detail: "Review the cited source, correct or explicitly accept the behavior, then rerun the affected checks." });
  if (regressionFailures.length) actions.push({ required: true, title: `Review ${regressionFailures.length} AI-supported property concern(s)`, detail: `${humanList(regressionFailures.map((plan) => `${plan.title || plan.id}: ${plan.oracleReview?.rationale || plan.executionMessage}`))}. These are not independent confirmations; approve the oracle or run a trusted property template before treating them as release blockers.` });
  if (manualReviewCandidates.length) {
    const locations = manualReviewCandidates.slice(0, 4).map((finding) => `${finding.location?.file || "src/Target.sol"}:${finding.location?.lineStart || "?"}`).join(", ");
    const reasons = [...new Set(manualReviewCandidates.map((finding) => finding.aiReview?.rationale).filter(Boolean))].slice(0, 2).join("; ");
    actions.push({ required: true, title: `Complete manual review for ${manualReviewCandidates.length} touchpoint(s)`, detail: `Inspect ${locations}${manualReviewCandidates.length > 4 ? ", and remaining locations" : ""}. Automated review reached its final source-focused retry without validated evidence${reasons ? `: ${reasons}` : "."}` });
  }
  if (unreviewedCandidates.length) {
    const locations = unreviewedCandidates.slice(0, 4).map((finding) => `${finding.location?.file || "src/Target.sol"}:${finding.location?.lineStart || "?"}`).join(", ");
    actions.push({ required: true, title: `Adjudicate ${unreviewedCandidates.length} pending touchpoint(s)`, detail: `AI evidence review was not completed for ${locations}${unreviewedCandidates.length > 4 ? ", and remaining locations" : ""}. Enable or rerun AI evidence review, or inspect these analyzer leads manually before relying on the assessment.` });
  }
  if (needsDecision.length) actions.push({ required: true, title: `Review ${needsDecision.length} source-supported risk item(s)`, detail: "Use the cited behavior, impact, trigger, and trust assumptions to decide whether each risk is acceptable for the intended deployment. A source fact does not require reconfirmation merely because it is intentional." });
  if (deploymentNeedsInput) actions.push(deploymentInputAction(job));
  if (incompleteToolRuns.length) actions.push(incompleteToolAction(incompleteToolRuns));
  if (noGeneratedPlans) {
    const obligations = job.testCampaign?.selectedObligationIds?.length || job.testCampaign?.recommendedProperties || 0;
    actions.push({ required: true, type: "regenerate-tests", title: "Generate the missing Foundry property campaign", detail: `AI returned no runnable property-check proposal, so no property was executed or failed${obligations ? ` for the ${obligations} selected obligation(s)` : ""}. Regenerate the campaign only if that proof target remains material.` });
  }
  const questionScopedTestIds = new Set((questionGaps || []).flatMap((item) => item.relatedTestIds || []));
  actions.push(...testGapActions(testGaps.filter((plan) => !questionScopedTestIds.has(plan.id))));
  for (const item of questionGaps || []) {
    actions.push({
      required: item.requiredForOpinion !== false,
      type: "targeted-verification",
      title: `Verify: ${item.question}`,
      detail: `${item.answer} (${item.materiality || "optional-assurance"}). Next check: ${item.nextCheck.tool} — ${item.nextCheck.objective}. ${item.nextCheck.reason}`,
    });
  }
  const recommendedAction = recommendedChecksAction({ job, questionGaps: recommendedQuestionGaps, testGaps: recommendedTestGaps, noGeneratedPlans: recommendedNoGeneratedPlans, deploymentNeedsInput: recommendedDeploymentNeedsInput, incompleteToolRuns: recommendedIncompleteToolRuns });
  if (recommendedAction) actions.push(recommendedAction);
  if (!job.runGeneratedTests && !recommendedAction) actions.push({ required: false, title: "Optional: run AI-designed Foundry tests", detail: "Property testing was not selected for this audit. Enable it for behavioral, fuzz, and invariant evidence after resolving required review items." });
  return actions;
}

function recommendedChecksAction({ job, questionGaps, testGaps, noGeneratedPlans, deploymentNeedsInput, incompleteToolRuns }) {
  const total = questionGaps.length + testGaps.length + Number(noGeneratedPlans) + Number(deploymentNeedsInput) + incompleteToolRuns.length;
  if (!total) return null;
  const toolCounts = new Map();
  for (const item of questionGaps) {
    const tool = item.nextCheck?.tool || "tool";
    toolCounts.set(tool, (toolCounts.get(tool) || 0) + 1);
  }
  for (const plan of testGaps) {
    const tool = plan.networkEvidence ? "fork" : "forge";
    toolCounts.set(tool, (toolCounts.get(tool) || 0) + 1);
  }
  if (deploymentNeedsInput) toolCounts.set("anvil", (toolCounts.get("anvil") || 0) + 1);
  for (const run of incompleteToolRuns) toolCounts.set(run.tool || "tool", (toolCounts.get(run.tool || "tool") || 0) + 1);
  const grouped = [...toolCounts.entries()].map(([tool, count]) => `${count} ${tool}`).join(", ");
  const examples = questionGaps.slice(0, 3).map((item) => item.question);
  const retryReasons = unique(testGaps.map((plan) => plan.oracleReview?.rationale || plan.executionMessage).filter(Boolean)).slice(0, 3);
  const depth = job.auditDepth === "review" ? "AI review" : "targeted audit";
  const deploymentAction = deploymentNeedsInput ? deploymentInputAction(job) : null;
  const deploymentDetail = deploymentAction ? `${deploymentAction.title}. ${deploymentAction.detail}` : "";
  return {
    required: false,
    type: "targeted-verification",
    title: `Optional: run ${total} recommended verification check${total === 1 ? "" : "s"}`,
    detail: `The ${depth} conclusion does not treat these as contract defects. Run them only if you want stronger runtime, fork, compiler, or analyzer assurance${grouped ? ` (${grouped})` : ""}.${examples.length ? ` Examples: ${humanList(examples)}.` : ""}${retryReasons.length ? ` Retry reason${retryReasons.length === 1 ? "" : "s"}: ${retryReasons.join("; ")}.` : ""}${deploymentDetail ? ` ${deploymentDetail}` : ""}`,
  };
}

function deploymentInputAction(job) {
  const target = job.aiDeploymentPlan?.targetContract || "the selected contract";
  const artifact = (job.deploymentArtifacts || []).find((item) => item.contract === job.aiDeploymentPlan?.targetContract);
  const constructorInputs = artifact?.constructorInputs || [];
  const requirements = constructorInputs.map((input, index) => `${input.name || `argument ${index + 1}`} (${input.type})`);
  const exactInputs = requirements.length ? ` Required constructor values: ${humanList(requirements)}.` : "";
  const inputTemplate = constructorInputs.length ? ` In Audit Copilot, enter them explicitly in this format: ${constructorInputs.map((input, index) => `${input.name || `argument${index + 1}`}=${placeholderFor(input.type)}`).join("; ")}. Replace each placeholder with the disposable test value.` : " No constructor values are required; resolve the exact target-selection or deployment-policy reason recorded below.";
  const fallbackReason = ` ${job.anvil?.reason || ""}`;
  return {
    required: true,
    type: "provide-input",
    title: constructorInputs.length ? `Provide constructor values for ${target}` : `Resolve the blocked Anvil plan for ${target}`,
    detail: `Anvil is available, but deployment was not attempted.${exactInputs}${inputTemplate} Then rerun Fresh Anvil deployment.${fallbackReason}`.trim(),
  };
}

function placeholderFor(type) {
  if (type === "string") return '"<text>"';
  if (type === "address") return "<trusted address role>";
  if (type === "bool") return "<true or false>";
  if (/^u?int\d*$/.test(type)) return "<decimal amount>";
  if (/^bytes\d*$/.test(type)) return "<0x hex value>";
  return `<${type} value>`;
}

function incompleteToolAction(runs) {
  const outcomes = runs.slice(0, 4).map((run) => `${run.tool}: ${run.error || run.status}`);
  return {
    required: true,
    type: "repair-tooling",
    title: `Resolve ${runs.length} incomplete tool check(s)`,
    detail: `${outcomes.join("; ")}${runs.length > 4 ? "; see the remaining tool entries in the feed" : ""}. Correct these specific checks and rerun them.`,
  };
}

function testGapActions(testGaps) {
  const actions = [];
  const rejected = testGaps.filter((plan) => plan.executionStatus === "rejected");
  const awaitingOracle = testGaps.filter((plan) => plan.executionStatus === "executed-needs-oracle");
  const timedOut = testGaps.filter((plan) => plan.executionStatus === "timed-out");
  const assertionFailures = testGaps.filter((plan) => plan.executionStatus === "failed" && plan.failureKind === "unverified-assertion");
  const harnessFailures = testGaps.filter((plan) => plan.executionStatus === "failed" && plan.failureKind !== "unverified-assertion");
  const invalid = testGaps.filter((plan) => plan.executionStatus === "invalid-test");
  if (rejected.length) {
    const reasons = unique(rejected.map((plan) => plan.executionMessage).filter(Boolean));
    actions.push({
      required: true,
      type: "regenerate-tests",
      title: `Regenerate ${rejected.length} property check(s) rejected before Forge`,
      detail: `No contract property was executed or failed. Validator reason${reasons.length === 1 ? "" : "s"}: ${reasons.join("; ") || "generated code did not pass safety validation"}. Affected properties: ${humanList(rejected.map((plan) => plan.title || plan.id || "unnamed property"))}.`,
    });
  }
  if (assertionFailures.length) actions.push({ required: true, type: "verify-tests", title: `Verify ${assertionFailures.length} generated assertion failure(s)`, detail: `These executions did not establish a contract defect. Affected questions: ${humanList(assertionFailures.map((plan) => plan.title || plan.id || "unnamed property"))}. Evidence: ${unique(assertionFailures.map((plan) => plan.executionMessage).filter(Boolean)).join("; ") || "see the recorded Forge output"}.` });
  if (harnessFailures.length) actions.push({ required: true, type: "repair-harnesses", title: `Repair and retry ${harnessFailures.length} generated property check(s)`, detail: `These compiler or execution failures are Attest test failures, not contract findings. AI must replace the disposable check and retry the same atomic question if it remains material. Affected tests: ${humanList(harnessFailures.map((plan) => plan.title || plan.id || "unnamed property"))}. Evidence: ${unique(harnessFailures.map((plan) => plan.executionMessage).filter(Boolean)).join("; ") || "see the recorded Forge output"}.` });
  if (invalid.length) actions.push({ required: true, type: "replace-invalid-tests", title: `Replace ${invalid.length} invalid verification test(s)`, detail: `No contract conclusion was drawn. Invalid tests: ${humanList(invalid.map((plan) => `${plan.title || plan.id}: ${plan.oracleReview?.rationale || plan.executionMessage}`))}.` });
  if (timedOut.length) actions.push({ required: true, type: "rerun-tests", title: `Rerun ${timedOut.length} timed-out property check(s)`, detail: `No conclusion was reached for: ${humanList(timedOut.map((plan) => plan.title || plan.id || "unnamed property"))}. Increase or redistribute the execution budget, then rerun only these properties if they remain material.` });
  if (awaitingOracle.length) actions.push({ required: true, type: "review-oracles", title: `Validate ${awaitingOracle.length} executed assertion oracle(s)`, detail: `Forge executed these harnesses, but their assertions still require independent semantic review: ${humanList(awaitingOracle.map((plan) => plan.title || plan.id || "unnamed property"))}.` });
  return actions;
}

function buildVerificationResults(job) {
  const results = new Map((job.evidenceReview?.questionResults || []).map((item) => [item.questionId, item]));
  return (job.verificationQuestions || []).map((question) => {
    const result = results.get(question.id);
    const materiality = questionMateriality(question, job.auditDepth);
    const status = result?.status || "not-verified";
    const answer = status === "not-verified"
      ? notVerifiedAnswer(question, result?.answer, result?.nextCheck?.reason || "Evidence review has not answered this question")
      : result?.answer || "Evidence review has not answered this question";
    const nextCheck = status === "not-verified" && result?.nextCheck?.needed === false
      ? defaultNextCheckForQuestion(question, result?.nextCheck || {}, "A terminal evidence check was not recorded")
      : result?.nextCheck || defaultNextCheckForQuestion(question, { objective: `Obtain evidence answering: ${question.question}` }, "No evidence-review result is available");
    return {
      ...question,
      ...materiality,
      status,
      answer,
      confidence: result?.confidence || "low",
      relatedTestIds: result?.relatedTestIds || [],
      sourceEvidence: result?.sourceEvidence || [],
      evidenceClasses: result?.evidenceClasses || [],
      assurance: result?.assurance || "not-verified",
      nextCheck,
    };
  });
}

function unique(values) {
  return [...new Set(values)];
}

function humanList(values) {
  if (values.length < 2) return values[0] || "none";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function decisionCategory(finding) {
  const review = finding.aiReview;
  if (review?.classification === "vulnerability" && review.verdict === "likely" &&
      (["critical", "high"].includes(finding.severity) || finding.verification === "confirmed-by-test")) {
    return "release-blocker";
  }
  return "needs-decision";
}

function categoryRank(value) {
  return value === "release-blocker" ? 0 : 1;
}

function touchpointState(finding, reviewStatus) {
  if (!finding.aiReview && ["queued", "running"].includes(reviewStatus)) return "awaiting-ai";
  if (!finding.aiReview?.sourceValidated) return reviewStatus === "completed" ? "manual-review-required" : ["queued", "running"].includes(reviewStatus) ? "awaiting-ai" : "not-adjudicated";
  if (reviewStatus !== "completed") return "reviewed";
  if (finding.aiReview.verdict === "reject" || finding.aiReview.classification === "false-positive") return "not-substantiated";
  if (OBSERVATION_CLASSIFICATIONS.has(finding.aiReview.classification)) return "contextualized";
  if (SECURITY_CLASSIFICATIONS.has(finding.aiReview.classification)) return "surfaced";
  return "manual-review-required";
}
