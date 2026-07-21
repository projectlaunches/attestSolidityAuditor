import { buildReviewPresentation } from "./review-presentation.js";
import { buildCoverageObligations, buildSourceFindings, validateExactSourceEvidence } from "./audit-domain.js";
import { effectiveTestPlans } from "./test-plan-state.js";

function clean(value) {
  return String(value ?? "").replaceAll("\r", " ").replaceAll("\n", " ").replace(/\s+/g, " ").trim();
}

function md(value) {
  return clean(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("!", "\\!").replaceAll("[", "\\[").replaceAll("]", "\\]").replaceAll("`", "\\`");
}

function reportBody(value) {
  return String(value ?? "").replaceAll("\r", "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").trim();
}

function citationText(evidence) {
  const citations = Array.isArray(evidence) ? evidence.filter((item) => item?.sourceValidated !== false && item?.quote) : [];
  if (!citations.length) return "";
  return citations.slice(0, 3).map((item) => ` — lines ${item.lineStart}-${item.lineEnd}: “${clean(item.quote)}”`).join("");
}

function locationOf(value) {
  const file = value?.file || "src/Target.sol";
  const line = value?.lineStart || value?.line || null;
  return line ? `${file}:${line}` : `${file} (line not supplied)`;
}

function evidenceLabel(finding) {
  const tools = [...new Set((finding.evidence || []).map((item) => `${item.tool}/${item.detectorId || item.kind}`))];
  const tests = (finding.testPlans || []).map((item) => item.id).filter(Boolean);
  const sourceEvidence = (finding.aiReview?.evidence || []).find((item) => item.sourceValidated && item.quote);
  const quote = sourceEvidence ? `; source lines ${sourceEvidence.lineStart}-${sourceEvidence.lineEnd}: “${clean(sourceEvidence.quote)}”` : "";
  return `${[...tools, ...tests].join(", ") || "source-cited AI review"}${quote}`;
}

function addPoint(lines, { tag, id, title, severity = "review", location, evidence, impact, condition, conclusion, action }) {
  lines.push(
    `### ${md(tag)} · ${md(id)} — ${md(title)}`,
    "",
    `- **Severity/state:** ${md(severity)}`,
    `- **Location:** ${md(location || "No single source location; audit-wide evidence")}`,
    `- **Evidence:** ${md(evidence || "No completed evidence was recorded")}`,
    `- **Impact:** ${md(impact || "No contract impact was established; this is an evidence or coverage gap")}`,
    `- **Trigger/condition:** ${md(condition || "The recorded check did not establish a narrower triggering condition")}`,
    `- **Conclusion:** ${md(conclusion || "Not verified")}`,
    `- **Point to address:** ${md(action)}`,
    "",
  );
}

export function renderFindingsMarkdown(job) {
  {
    const validatedSourceConclusions = (Array.isArray(job.sourceConclusions) ? job.sourceConclusions : []).flatMap((conclusion) => {
      const evidence = validateExactSourceEvidence(conclusion.evidence, job.source);
      return evidence.length ? [{ ...conclusion, evidence }] : [];
    });
    const sourceFindings = buildSourceFindings(job).filter((finding) => finding.kind !== "source-conclusion");
    const toolRuns = (job.toolRuns || []).filter((run) => run.evidenceEligible !== false && !run.supersededBy);
    const lines = [
      `# Attest audit: ${md(job.fileName)}`,
      "",
      `- **Engagement:** ${md(job.auditDepth)}`,
      `- **Source SHA-256:** \`${job.sourceHash}\``,
      `- **Source integrity:** ${md(job.sourceIntegrity?.status || "unknown")}`,
      `- **Evidence revision:** ${job.evidenceRevision}`,
      "",
      "## AI auditor opinion",
      "",
      reportBody(job.auditSynthesis?.answer || job.operationLoop?.stopReason || "The AI auditor did not return a final opinion."),
      "",
      "## Source-supported audit model",
      "",
      ...(validatedSourceConclusions.length
        ? validatedSourceConclusions.map((conclusion) => `- **${md(conclusion.classification || "source conclusion")}:** ${md(conclusion.statement)}${citationText(conclusion.evidence)}`)
        : ["- No source conclusion passed exact citation validation."]),
      ...(sourceFindings.length
        ? ["", "### Source findings", "", ...sourceFindings.map((finding) => `- **${md(finding.id)} — ${md(finding.title)} (${md(finding.severity)}):** ${md(finding.statement)}${citationText(finding.citations || finding.evidence)}${finding.action ? ` **Action:** ${md(finding.action)}` : ""}`)]
        : []),
      "",
      "### Trust assumptions",
      "",
      ...((job.ai?.result?.trustAssumptions || []).map((item) => `- ${md(item)}`).length ? (job.ai.result.trustAssumptions || []).map((item) => `- ${md(item)}`) : ["- None returned."]),
      "",
      "### Invariants",
      "",
      ...((job.ai?.result?.invariants || []).map((item) => `- ${md(item)}`).length ? (job.ai.result.invariants || []).map((item) => `- ${md(item)}`) : ["- None returned."]),
      "",
      "## Tool evidence",
      "",
      ...(toolRuns.length ? toolRuns.map((run) => `- **${md(run.tool)}:** ${md(run.status)}${run.version ? ` — ${md(run.version)}` : ""}${run.error ? ` — ${md(run.error)}` : ""}`) : ["- No executable tool was used for this engagement."]),
      "",
      "## Scope",
      "",
      "Attest audited an immutable copy of the submitted Solidity source. The AI auditor selected and interpreted any recorded tools; Attest did not rewrite or repair the contract.",
      "",
    ];
    return lines.join("\n");
  }
  const presentation = buildReviewPresentation(job);
  const sourceFindings = buildSourceFindings(job);
  const validatedSourceConclusions = (Array.isArray(job.sourceConclusions) ? job.sourceConclusions : []).flatMap((conclusion) => {
    const evidence = validateExactSourceEvidence(conclusion.evidence, job.source);
    return evidence.length ? [{ ...conclusion, evidence }] : [];
  });
  const renderedSourceFindings = sourceFindings.filter((finding) => finding.kind !== "source-conclusion");
  const coverageObligations = buildCoverageObligations(job);
  const practicalVerdict = presentation.practicalVerdict || presentation.releaseDecision.usability?.practicalVerdict || { code: "usability-not-established", title: "Contract usability was not established", reason: "The completed evidence did not establish a practical use decision." };
  const lines = [
    `# Attest findings: ${md(job.fileName)}`,
    "",
    `- **Source SHA-256:** \`${job.sourceHash}\``,
    `- **Source integrity:** ${md(job.sourceIntegrity?.status || "unknown")}`,
    `- **Evidence revision:** ${job.evidenceRevision}`,
    `- **Audit result:** ${md(job.status)}`,
    `- **Report basis:** ${md(job.reportState?.reason || "selected testing reached a terminal state")}`,
    "",
    "## What the source establishes",
    "",
    "AI interpretations below have exact validated source citations; they are not independent semantic confirmation.",
    "",
    ...(validatedSourceConclusions.length
      ? validatedSourceConclusions.map((conclusion) => `- **AI source-supported:** ${md(conclusion.statement)} — ${md(conclusion.rationale)}${citationText(conclusion.evidence)}`)
      : ["- No source conclusion passed exact citation validation."]),
    ...(renderedSourceFindings.length
      ? ["", "### First-class source findings", "", ...renderedSourceFindings.map((finding) => `- **${md(finding.id)} — ${md(finding.title)}:** ${md(finding.statement)} — ${md(finding.rationale)}${citationText(finding.citations || finding.evidence)}`)]
      : []),
    "",
    "## Audit model",
    "",
    ...[
      ["Money flow", job.ai?.result?.moneyFlow],
      ["Permission flow", job.ai?.result?.permissionFlow],
      ["Trust assumptions", job.ai?.result?.trustAssumptions],
      ["Safety invariants", job.ai?.result?.invariants],
    ].flatMap(([label, values]) => [`- **${label}:** ${values?.length ? values.map(md).join("; ") : "No source-specific item was returned."}`]),
    "",
    "## Practical usability verdict",
    "",
    `- **Verdict:** ${md(practicalVerdict.code)}`,
    `- **Title:** ${md(practicalVerdict.title)}`,
    `- **Reason:** ${md(practicalVerdict.reason)}`,
    "",
    "## Points to address",
    "",
  ];
  let points = 0;

  if (coverageObligations.length) {
    lines.push("## Full-audit coverage", "", "Each obligation has a server-recorded terminal disposition and reason; unavailable or unauthorized classes remain coverage limitations.", "");
    for (const obligation of coverageObligations) {
      lines.push(`- **${md(obligation.kind)}:** ${md(obligation.terminalDisposition)}${obligation.terminal ? " (terminal)" : " (open)"} — ${md(obligation.reason)}`);
    }
    lines.push("");
  }

  for (const finding of presentation.findings) {
    points += 1;
    const questionIds = [...new Set((finding.testPlans || []).flatMap((plan) => plan.questionIds || []))];
    const rerun = questionIds.length ? `Rerun verification question(s) ${questionIds.join(", ")} in a new audit after the behavior is addressed outside Attest.` : `Rerun ${evidenceLabel(finding)} in a new audit after the behavior is addressed outside Attest.`;
    addPoint(lines, {
      tag: finding.decisionCategory === "release-blocker" ? "BLOCKING" : "REVIEW",
      id: finding.id,
      title: finding.title,
      severity: finding.severity,
      location: locationOf(finding.location),
      evidence: evidenceLabel(finding),
      impact: finding.aiReview?.impact || finding.summary,
      condition: finding.aiReview?.trigger || (finding.location?.function ? `The ${finding.location.function} function is invoked under the behavior described by the cited evidence.` : `Execution reaches ${locationOf(finding.location)} under the behavior described by the cited evidence.`),
      conclusion: finding.aiReview?.rationale || finding.summary,
      action: `${finding.aiReview?.action || "Decide whether this source-supported behavior is acceptable under the declared trust and deployment assumptions. If it is not acceptable, resolve it outside the read-only Attest workspace."} ${rerun} Attest will not modify the submitted contract.`,
    });
  }

  const plans = effectiveTestPlans(job);
  const questionScopedPlanIds = new Set(presentation.verificationResults.filter((item) => item.status === "not-verified").flatMap((item) => item.relatedTestIds || []));
  for (const plan of plans.filter((item) => !questionScopedPlanIds.has(item.id) && item.executionStatus === "failed" && item.failureKind === "property-failure")) {
    points += 1;
    addPoint(lines, {
      tag: "PROPERTY CONCERN",
      id: plan.id,
      title: plan.title || "Generated security property",
      severity: "AI-supported property concern",
      evidence: `Foundry execution; ${plan.executionEvidence?.summary || plan.executionMessage || "assertion failure recorded"}`,
      impact: plan.expectedBehavior,
      condition: `The generated property check ${plan.id} reached its recorded assertion under Foundry execution.`,
      conclusion: plan.oracleReview?.rationale || plan.executionMessage,
      action: `Independently approve or replace the oracle for question(s) ${(plan.questionIds || []).join(", ") || "not recorded"}; then rerun this exact property. Do not treat AI adjudication alone as an independent confirmation.`,
    });
  }

  for (const result of presentation.verificationResults.filter((item) => item.status === "ai-supported-concern" || (item.status === "not-verified" && item.requiredForOpinion))) {
    points += 1;
    const next = result.nextCheck || {};
    addPoint(lines, {
      tag: result.status === "not-verified" ? "COVERAGE GAP" : "AI-SUPPORTED CONCERN",
      id: result.id,
      title: result.question,
      severity: result.status,
      evidence: (result.relatedTestIds || []).length ? `Test plan(s) ${(result.relatedTestIds || []).join(", ")}` : `Required evidence: ${(result.requiredEvidenceKinds || []).join(", ") || "source/context"}`,
      impact: result.rationale,
      condition: result.expectedEvidence,
      conclusion: result.answer,
      action: result.status === "not-verified"
        ? `Run ${next.tool || "the named check"}: ${next.objective || result.question}. Required opinion evidence: ${next.reason || "evidence that directly answers the question"}.`
        : `Review the cited behavior, trigger, and impact. If this risk is unacceptable, address it outside Attest and rerun the affected verification.`,
    });
  }

  const surfacedIds = new Set(presentation.findings.map((finding) => finding.id));
  const manualIds = new Set(presentation.touchpoints.filter((item) => ["manual-review-required", "not-adjudicated"].includes(item.state)).map((item) => item.id));
  const manual = (job.findings || []).filter((finding) => !surfacedIds.has(finding.id) && manualIds.has(finding.id));
  for (const finding of manual) {
    points += 1;
    addPoint(lines, {
      tag: "MANUAL REVIEW",
      id: finding.id,
      title: finding.title,
      severity: job.ai?.status === "completed" ? "manual review required" : "analyzer candidate — not adjudicated",
      location: locationOf(finding.location),
      evidence: evidenceLabel(finding),
      conclusion: finding.aiReview?.rationale || (job.ai?.status === "completed" ? "Automated source validation did not reach a supported disposition." : "AI source adjudication did not complete; this detector candidate remains unresolved and is not a confirmed vulnerability."),
      action: `Inspect ${locationOf(finding.location)} against the whole-contract control flow and record whether detector ${evidenceLabel(finding)} applies before release.`,
    });
  }

  for (const plan of plans.filter((item) => job.auditDepth === "full" && !questionScopedPlanIds.has(item.id) && (["rejected", "invalid-test", "timed-out"].includes(item.executionStatus) || (item.executionStatus === "failed" && item.failureKind !== "property-failure")))) {
    points += 1;
    const action = plan.executionStatus === "timed-out" ? "Rerun this exact property with a larger bounded time budget." : "Regenerate only this property check against the same verification question, then compile and execute it before drawing a contract conclusion.";
    addPoint(lines, {
      tag: "TEST GAP",
      id: plan.id,
      title: plan.title || "Generated property test",
      severity: "coverage gap",
      evidence: plan.executionMessage || plan.executionStatus,
      conclusion: "This generated check produced no supported contract conclusion.",
      action,
    });
  }

  const deploymentNeedsInput = job.runAnvil && job.anvil?.status === "needs-input";
  for (const run of (job.toolRuns || []).filter((item) => job.auditDepth === "full" && item.evidenceEligible !== false && item.status !== "completed" && !(deploymentNeedsInput && item.tool === "anvil-deployment") && !String(item.tool || "").startsWith("forge-generated:"))) {
    points += 1;
    addPoint(lines, {
      tag: "TOOL GAP",
      id: run.tool,
      title: `${run.tool} did not complete`,
      severity: "tool coverage gap",
      evidence: `${run.tool}${run.version ? ` ${run.version}` : ""}: ${run.error || run.status}`,
      conclusion: `No completed ${run.tool} evidence is included in this assessment.`,
      action: `${run.status === "skipped" || /not installed/i.test(run.error || "") ? `Install or enable ${run.tool} from Attest's Setup page.` : `Resolve the exact ${run.tool} error recorded in Evidence above.`} Then rerun ${run.tool} against source hash ${job.sourceHash}.`,
    });
  }

  if (deploymentNeedsInput && job.auditDepth === "full") {
    points += 1;
    const inputs = (job.deploymentArtifacts || []).find((item) => item.contract === job.aiDeploymentPlan?.targetContract)?.constructorInputs || [];
    addPoint(lines, {
      tag: "DEPLOYMENT INPUT",
      id: job.aiDeploymentPlan?.targetContract || "anvil",
      title: inputs.length ? "Fresh Anvil deployment needs declared constructor values" : "Fresh Anvil deployment was blocked before launch",
      severity: "deployment coverage gap",
      evidence: job.anvil?.reason,
      conclusion: "No fresh-chain deployment or runtime evidence was produced.",
      action: inputs.length ? `Declare ${inputs.map((item) => `${item.name || "argument"} (${item.type})`).join(", ")}, then rerun Fresh Anvil deployment.` : `No constructor values are required. Resolve the exact target-selection or deployment-policy reason above, then rerun Fresh Anvil deployment.`,
    });
  }

  if (!points) lines.push("No source-validated security concern or unresolved action item was established by the completed checks.", "");

  const optionalQuestions = presentation.verificationResults.filter((item) => item.status === "not-verified" && !item.requiredForOpinion);
  const optionalPlans = plans.filter((item) => !questionScopedPlanIds.has(item.id) && (["rejected", "invalid-test", "timed-out"].includes(item.executionStatus) || (item.executionStatus === "failed" && item.failureKind !== "property-failure")));
  const optionalTools = (job.toolRuns || []).filter((item) => item.evidenceEligible !== false && item.status !== "completed" && !String(item.tool || "").startsWith("forge-generated:"));
  if (job.auditDepth !== "full" && (optionalQuestions.length || optionalPlans.length || optionalTools.length || deploymentNeedsInput)) {
    lines.push("## Optional assurance not run", "", "These items are not contract findings and were not required for the selected-scope opinion.", "");
    for (const item of optionalQuestions) lines.push(`- **${md(item.id)}:** ${md(item.question)} — next available check: ${md(item.nextCheck?.tool || "targeted verification")}.`);
    for (const plan of optionalPlans) lines.push(`- **${md(plan.id)}:** ${md(plan.title || "Generated property check")} — ${md(plan.executionMessage || plan.executionStatus)}.`);
    for (const run of optionalTools) lines.push(`- **${md(run.tool)}:** ${md(run.error || run.status)}.`);
    if (deploymentNeedsInput) lines.push(`- **Fresh Anvil:** ${md(job.anvil?.reason || "Disposable deployment needs additional fixture values")} — provide them in Audit Copilot only if you want this optional deployment evidence.`);
    lines.push("");
  }

  if (job.auditDepth === "full" && job.qualityFindings?.length) {
    lines.push("## Code quality points", "");
    for (const item of job.qualityFindings) lines.push(`- **${md(item.ruleId)} at ${md(locationOf(item.location))}:** ${md(item.message)}`);
    lines.push("");
  }

  lines.push(
    "## Scope statement",
    "",
    "Attest audited an immutable copy of the submitted Solidity source. It generated disposable property checks only; it did not rewrite, repair, or replace the contract. This findings summary records completed evidence and exact unresolved checks, not a guarantee of security.",
    "",
  );
  return lines.join("\n");
}
