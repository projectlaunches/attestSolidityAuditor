import { buildReviewPresentation } from "./review-presentation.js";
import { effectiveTestPlans } from "./test-plan-state.js";

function escapeCell(value) {
  return sanitizeMarkdown(value ?? "—").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function sanitizeMarkdown(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("!", "\\!")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("`", "\\`");
}

export function renderMarkdown(job) {
  const presentation = buildReviewPresentation(job);
  const fullMode = job.auditDepth === "full";
  const findings = presentation.findings;
  const review = presentation.reviewSummary;
  const decision = presentation.releaseDecision;
  const counts = Object.groupBy(findings, (finding) => finding.severity);
  const completedTools = job.toolRuns.filter((run) => run.status === "completed" && run.evidenceEligible !== false).length;
  const deploymentNeedsInput = job.runAnvil && job.anvil?.status === "needs-input";
  const incompleteTools = job.toolRuns.filter((run) => run.evidenceEligible !== false && run.status !== "completed" && !String(run.tool || "").startsWith("forge-generated:") && !(deploymentNeedsInput && run.tool === "anvil-deployment")).length;
  const manualReviewCandidates = (job.findings || []).filter((finding) => !finding.aiReview?.sourceValidated && job.ai?.status === "completed");
  const lines = [
    `# Solidity audit report: ${sanitizeMarkdown(job.fileName)}`,
    "",
    "> Automated evidence is scoped, not a security guarantee or independent human proof. Conclusions below distinguish AI-supported behavior, AI-supported concerns, developer decisions, and unanswered questions.",
    "",
    "## Executive summary",
    "",
    `- Job: \`${job.id}\``,
    `- Source SHA-256: \`${job.sourceHash}\``,
    `- Evidence revision: ${job.evidenceRevision || 1}`,
    `- Result: **${job.status}**`,
    `- Readiness assessment: **${assessmentLabel(decision.status)}**`,
    `- Practical use assessment: **${sanitizeMarkdown(decision.usability?.title || "Contract usability was not established")}** — ${sanitizeMarkdown(decision.usability?.summary || "Review the recorded evidence and gaps")}`,
    `- Blocking issues: ${decision.blockers}; failed security properties: ${decision.regressionFailures}; review items: ${decision.needsDecision}`,
    `- Supporting categories: ${decision.context} context/accepted behavior, ${fullMode ? `${decision.quality} code quality, ` : ""}${decision.rejected} not substantiated, ${decision.manualReview} manual review required, ${decision.unreviewed} not adjudicated, ${fullMode ? `${decision.testGaps} coverage gaps` : `${decision.recommendedChecks || 0} recommended stronger checks`}`,
    `- Detector touchpoints: ${review.touchpoints} (tool output awaiting or processed by AI; not an issue count)`,
    `- AI-reviewed touchpoints: ${review.reviewed}`,
    `- Surfaced security concerns: ${findings.length} (${counts.critical?.length ?? 0} critical, ${counts.high?.length ?? 0} high, ${counts.medium?.length ?? 0} medium, ${counts.low?.length ?? 0} low, ${counts.info?.length ?? 0} info)`,
    `- Reviewed observations: ${review.observations}; not-substantiated candidates: ${review.rejected}; manual-review touchpoints: ${review.manualReview}`,
    ...(fullMode ? [`- Quality diagnostics: ${job.qualityFindings?.length ?? 0} (reported separately; they do not corroborate security findings)`] : []),
    `- Tool coverage: ${completedTools} completed, ${incompleteTools} skipped/failed/timed out`,
    ...(deploymentNeedsInput ? [`- Deployment input: ${fullMode ? "required" : "needed only for the optional Fresh Anvil check"} for ${sanitizeMarkdown(job.aiDeploymentPlan?.targetContract || "the selected contract")}; Anvil itself was available and did not fail`] : []),
    `- AI review: ${job.ai?.status ?? "not requested"}`,
    `- Verification questions: ${presentation.verificationSummary.aiSupported} AI-supported, ${presentation.verificationSummary.concerns} AI-supported concern(s), ${presentation.verificationSummary.accepted} accepted behavior(s), ${presentation.verificationSummary.decisions} developer decision(s), ${presentation.verificationSummary.notVerified} ${fullMode ? "coverage gap(s)" : "recommended stronger check(s)"}`,
    `- Test campaign: ${job.testCampaign?.mode ?? "not configured"}; ${job.testCampaign?.recommendedProperties ?? 0} named properties recommended; up to ${job.testCampaign?.generatedTestBudget ?? 0} effective property checks across the campaign, plus at most two bounded correction attempts for a broken check; ${job.testCampaign?.fuzzRuns ?? 0} fuzz cases per fuzz property; ${job.testCampaign?.timeoutMinutes ?? 0}-minute selected campaign window`,
    `- Campaign results: ${job.testCampaign?.plansReturned ?? 0} property checks proposed, ${job.testCampaign?.plansAccepted ?? 0} accepted, ${job.testCampaign?.passed ?? 0} AI-evidence-supported, ${job.testCampaign?.awaitingOracle ?? 0} awaiting evidence review, ${job.testCampaign?.invalid ?? 0} invalid tests, ${job.testCampaign?.rejected ?? 0} rejected, ${job.testCampaign?.failed ?? 0} AI-supported property concerns, ${job.testCampaign?.timedOut ?? 0} timed out`,
    `- Compiler settings: auto-detect=${job.compileSettings?.autoDetectSolc ?? "unknown"}, offline=${job.compileSettings?.offline ?? "unknown"}, optimizer=${job.compileSettings?.optimizer ?? "unknown"}, runs=${job.compileSettings?.optimizerRuns ?? "unknown"}`,
    "",
  ];

  if (job.auditSynthesis?.answer) {
    lines.push("## Plain-language audit conclusion", "", sanitizeMarkdown(job.auditSynthesis.answer), "");
  }

  if (job.sourceConclusions?.length) {
    lines.push("## Whole-contract source conclusions", "", "These are AI interpretations backed by exact source citations; citation validation is not independent semantic proof.", "");
    for (const conclusion of job.sourceConclusions) {
      const locations = (conclusion.evidence || []).map((item) => `lines ${item.lineStart}-${item.lineEnd}`).join(", ");
      lines.push(`- **${sanitizeMarkdown(conclusion.statement)}** — AI source-supported with exact citation${locations ? ` (${sanitizeMarkdown(locations)})` : ""}. ${sanitizeMarkdown(conclusion.rationale)}`);
    }
    lines.push("");
  }

  if (presentation.verificationResults.length) {
    lines.push(
      "## Verification questions and answers",
      "",
      "| Priority | Verification question | Assurance achieved | Evidence conclusion | Answer |",
      "|---|---|---|---|---|",
      ...presentation.verificationResults.map((item) => `| ${escapeCell(item.priority)} | ${escapeCell(item.question)} | ${escapeCell(item.evidenceClasses?.join(" + ") || (fullMode ? "coverage gap" : "recommended stronger check"))} | ${escapeCell(displayVerificationStatus(item.status, fullMode))} | ${escapeCell(item.answer)} |`),
      "",
    );
    const targeted = presentation.verificationResults.filter((item) => item.status === "not-verified");
    if (targeted.length) {
      lines.push(fullMode ? "### Targeted checks still needed" : "### Optional stronger checks", "");
      for (const item of targeted) lines.push(`- **${sanitizeMarkdown(item.question)}:** ${sanitizeMarkdown(item.nextCheck.tool)} — ${sanitizeMarkdown(item.nextCheck.objective)}. ${sanitizeMarkdown(item.nextCheck.reason)}`);
      lines.push("");
    }
  }

  if (decision.nextActions?.length) {
    lines.push("## What needs to happen next", "");
    for (const action of decision.nextActions) {
      lines.push(`- **${action.required ? "Required" : "Optional"} — ${sanitizeMarkdown(action.title)}:** ${sanitizeMarkdown(action.detail)}`);
    }
    lines.push("");
  }

  if (job.followup?.history?.length) {
    lines.push("## Authorized targeted verification passes", "");
    for (const pass of job.followup.history) {
      const network = pass.networkEvidence ? `; ${sanitizeMarkdown(pass.networkEvidence.label)} chain ${pass.networkEvidence.chainId}, block ${pass.networkEvidence.blockNumber}, hash ${sanitizeMarkdown(pass.networkEvidence.blockHash)}` : "";
      const stopped = pass.stopReason ? `; stop reason: ${sanitizeMarkdown(pass.stopReason)}` : "";
      lines.push(`- **${sanitizeMarkdown(pass.status)} — ${sanitizeMarkdown(pass.objective)}:** tool ${sanitizeMarkdown(pass.tool)}; question ${sanitizeMarkdown(pass.questionId)}${network}${stopped}`);
    }
    lines.push("", "Public RPC providers are rate-limited and can observe requested addresses, block numbers, storage slots, and request timing. Fork transactions execute only in the local Foundry EVM and are never broadcast.", "");
  }

  lines.push(
    "## Declared context and threat assumptions",
    "",
    `- Declared type: ${job.declaredContext?.contractType || "auto-detect"}`,
    `- Trusted roles: ${sanitizeMarkdown(job.declaredContext?.trustedRoles || "not declared")}`,
    `- Intended behaviors: ${sanitizeMarkdown(job.declaredContext?.intendedBehaviors || "not declared")}`,
    `- Accepted risks: ${sanitizeMarkdown(job.declaredContext?.acceptedRisks || "not declared")}`,
    `- Detected archetypes: ${(job.contractProfile?.archetypes || []).join(", ") || "unknown"}`,
    "",
    "Declared trust does not erase privileged-key, operator-error, or governance risk; it changes how evidence is classified.",
    "",
    "## Pertinent security test suite",
    "",
    `Selected executable suite IDs: ${(job.testCampaign?.selectedSuiteIds || []).map(sanitizeMarkdown).join(", ") || "none"}`,
    "",
    "| Priority | Vector | Environment | Preferred tools | Status |",
    "|---|---|---|---|---|",
    ...(job.suitePlan || []).map((plan) => `| ${escapeCell(plan.priority)} | ${escapeCell(plan.vector)} | ${escapeCell(plan.environment)} | ${escapeCell(plan.preferredTools?.join(", "))} | ${escapeCell(plan.status)} |`),
    "",
  );

  if (job.ai?.result?.contractSummary) {
    lines.push("### Contract summary", "", sanitizeMarkdown(job.ai.result.contractSummary), "", "### Threat model", "", sanitizeMarkdown(job.ai.result.threatModel), "");
    for (const [title, values] of [
      ["Money flow", job.ai.result.moneyFlow],
      ["Permission flow", job.ai.result.permissionFlow],
      ["Trust assumptions", job.ai.result.trustAssumptions],
      ["Contract-specific invariants", job.ai.result.invariants],
    ]) {
      lines.push(`### ${title}`, "", ...(values?.length ? values.map((item) => `- ${sanitizeMarkdown(item)}`) : ["- No source-specific item was returned."]), "");
    }
  }

  lines.push(
    "## Fresh Anvil environment",
    "",
    `- Requested: ${job.anvil?.requested ? "yes" : "no"}`,
    `- Status: ${sanitizeMarkdown(job.anvil?.status || "disabled")}`,
    `- AI plan: ${sanitizeMarkdown(job.aiDeploymentPlan?.decision || "not available")}; target ${sanitizeMarkdown(job.aiDeploymentPlan?.targetContract || "not selected")}; ${job.aiDeploymentPlan?.constructorArguments?.length || 0} constructor argument(s)`,
    `- Plan rationale: ${sanitizeMarkdown(job.aiDeploymentPlan?.rationale || "Deterministic fallback or deployment not requested")}`,
    `- Chain: ${job.anvil?.chainId ?? "not started"} (${sanitizeMarkdown(job.anvil?.endpoint || "no endpoint")})`,
    `- Contract: ${sanitizeMarkdown(job.anvil?.contract || "not deployed")}`,
    `- Deployment receipt: ${sanitizeMarkdown(job.anvil?.transactionHash || "none")}`,
    `- Deployed bytecode SHA-256: ${sanitizeMarkdown(job.anvil?.codeSha256 || "none")}`,
    `- Limitation: ${sanitizeMarkdown(job.anvil?.reason || "Deployment proves local deployability only; no vulnerability is confirmed without a reviewed scenario oracle.")}`,
    "",
  );

  lines.push(
    "## Security property verification",
    "",
    `- Property testing: ${sanitizeMarkdown(decision.propertyTesting?.label || `${decision.regressionPasses} passed`)}`,
    `- Property failures: ${decision.regressionFailures}`,
    `- Property-check timeout or execution gaps: ${fullMode ? decision.testGaps : 0}`,
    ...(fullMode ? [] : [`- Recommended stronger checks not required by selected scope: ${decision.recommendedChecks || 0}`]),
    "",
    "Only an assertion failure whose oracle was source-validated by the final AI evidence review is counted as a contract-property failure.",
    "",
  );

  const generatedPlans = effectiveTestPlans(job);
  if (generatedPlans.length) {
    lines.push(
      "### Generated property plan outcomes",
      "",
      "Rejected or broken generated checks are coverage gaps, not failed contract properties.",
      "",
      "| Property | Type | Outcome | Evidence or reason |",
      "|---|---|---|---|",
      ...generatedPlans.map((plan) => `| ${escapeCell(plan.title || plan.id)} | ${escapeCell(plan.testType)} | ${escapeCell(plan.executionStatus)} | ${escapeCell(plan.executionMessage || plan.expectedBehavior)} |`),
      "",
    );
  }

  lines.push(
    "## Checks",
    "",
    "| Tool | Version | Compiler | Status | Exit | Timeout |",
    "|---|---|---|---:|---:|---:|",
    ...job.toolRuns.map((run) => `| ${escapeCell(run.tool)} | ${escapeCell(run.version)} | ${escapeCell(run.resolvedCompiler)} | ${escapeCell(run.status)} | ${escapeCell(run.exitCode)} | ${run.timedOut ? "yes" : "no"} |`),
    "",
  );

  if (manualReviewCandidates.length) {
    lines.push("## Manual review required", "", "Automation reached its final source-focused retry without enough validated evidence to safely accept or reject these analyzer leads.", "");
    for (const finding of manualReviewCandidates) {
      const detectors = [...new Set((finding.evidence || []).map((item) => `${item.tool}/${item.detectorId || item.kind}`))].join(", ") || "normalized analyzer evidence";
      lines.push(
        `### ${sanitizeMarkdown(finding.location?.file || "src/Target.sol")}:${finding.location?.lineStart || "?"}`,
        "",
        `- Touchpoint: \`${sanitizeMarkdown(finding.id)}\``,
        `- Analyzer evidence: ${sanitizeMarkdown(detectors)}`,
        `- Reason: ${sanitizeMarkdown(finding.aiReview?.rationale || "Automated source validation did not produce a supported disposition.")}`,
        "- Required action: Inspect the cited location and surrounding cross-function behavior, decide whether the detector is applicable, then record a source-supported disposition before release.",
        "",
      );
    }
  }

  lines.push("## Blocking issues and review items", "");

  if (job.ai?.status !== "completed") {
    lines.push(`AI review did not complete (${sanitizeMarkdown(job.ai?.status || "not requested")}). ${review.touchpoints} detector touchpoint(s) remain hidden and must not be interpreted as vulnerabilities.`, "");
  } else if (findings.length === 0) {
    lines.push("AI review did not surface a source-validated security concern from the detector touchpoints. This does not mean the contract is secure.", "");
  }

  for (const finding of findings) {
    lines.push(
      `### ${finding.decisionCategory === "release-blocker" ? "BLOCKING ISSUE" : "REVIEW ITEM"} · ${finding.severity.toUpperCase()}: ${sanitizeMarkdown(finding.title)}`,
      "",
      `- ID: \`${finding.id}\``,
      `- Evidence state: **${finding.verification}**`,
      `- Classification: ${finding.aiReview?.sourceValidated ? finding.aiReview.classification : finding.aiReview ? "unvalidated AI hypothesis" : "unreviewed candidate"}`,
      `- Confidence: ${finding.confidence}`,
      `- Location: \`${finding.location.file}:${finding.location.lineStart ?? "?"}\``,
      "",
      sanitizeMarkdown(finding.summary),
      "",
      "Evidence:",
      "",
      ...finding.evidence.map((evidence) => `- ${sanitizeMarkdown(evidence.tool)} ${sanitizeMarkdown(evidence.toolVersion ?? "")} / ${sanitizeMarkdown(evidence.detectorId ?? evidence.kind)}: ${sanitizeMarkdown(evidence.description)}`),
      "",
    );
    if (finding.aiReview) {
      lines.push(
        `AI review: **${finding.aiReview.verdict}** (${finding.aiReview.confidence}, citations ${finding.aiReview.sourceValidated ? "validated" : "not validated"}) — ${sanitizeMarkdown(finding.aiReview.rationale)}`,
        `Assumption effect: ${sanitizeMarkdown(finding.aiReview.assumptionEffect)}`,
        "",
      );
    }
    if (finding.testPlans?.length) {
      lines.push("Proposed security property tests:", "");
      for (const plan of finding.testPlans) {
        lines.push(`- **${sanitizeMarkdown(plan.title)}** (${plan.testType}): ${sanitizeMarkdown(plan.expectedBehavior)}`);
      }
      lines.push("");
    }
  }

  if (fullMode) {
    lines.push("## Quality diagnostics", "", "Solhint diagnostics are lint and maintainability evidence. They are not counted as security findings and cannot corroborate an analyzer finding.", "");
    if (!job.qualityFindings?.length) lines.push("No quality diagnostics were produced by completed checks.", "");
    for (const diagnostic of job.qualityFindings || []) {
      lines.push(`- **${diagnostic.severity.toUpperCase()} / ${sanitizeMarkdown(diagnostic.ruleId)}** at \`${diagnostic.location.file}:${diagnostic.location.lineStart ?? "?"}\`: ${sanitizeMarkdown(diagnostic.message)}`);
    }
    lines.push("");
  }

  lines.push("## Audit worklog", "");
  for (const event of job.worklog) {
    lines.push(`- ${event.at} — **${event.stage} / ${event.status}**: ${sanitizeMarkdown(event.message)}`);
  }

  lines.push("", "## Limitations", "", ...job.limitations.map((item) => `- ${item}`), "");
  return lines.join("\n");
}

function displayVerificationStatus(status, fullMode = true) {
  return status === "not-verified" ? (fullMode ? "coverage gap" : "recommended stronger check") : status;
}

function assessmentLabel(status) {
  return ({ failed: "audit did not complete", block: "action required", review: "review required", incomplete: "assessment incomplete", "ready-with-caveats": "no blockers identified" })[status] || "pending";
}
