const ACTIVE_ACTION_STATES = new Set(["open", "queued", "running"]);
const TERMINAL_AUDIT_STATES = new Set(["completed", "partial", "failed", "cancelled"]);

export function deriveCopilotOptions(job) {
  if (!job) return { visible: false, verdictTitle: "", verdictSummary: "", summary: "", items: [] };
  if (!TERMINAL_AUDIT_STATES.has(job.status)) return { visible: false, verdictTitle: "", verdictSummary: "", summary: "", items: [] };
  const verification = Array.isArray(job.verificationResults) ? job.verificationResults : [];
  const actions = (job.followup?.actions || []).filter((action) =>
    action.evidenceRevision === job.evidenceRevision && action.status !== "stale"
  );
  const campaign = actions.findLast((action) => action.tool === "controller" && ACTIVE_ACTION_STATES.has(action.status));
  const active = ["queued", "running"].includes(job.followup?.status);
  const items = [];

  if (campaign) {
    const recommended = campaign.recommendedCampaign === true;
    items.push({
      key: "continue-testing",
      kind: "campaign",
      shortTitle: recommended ? "Run recommended tests" : "Continue testing",
      title: recommended ? "Run recommended tests" : "Continue testing",
      detail: recommended
        ? "AI will choose the pertinent properties from the recommended campaign, generate and validate the Foundry tests, execute them, and revise the conclusion from the results."
        : "AI will resume from the preserved evidence ledger, choose among all authorized registered operations, interpret the results, and continue within the selected execution window.",
      tool: "controller",
      actionId: campaign.status === "open" && campaign.runnable ? campaign.id : null,
      evidenceRevision: campaign.evidenceRevision,
      networkId: campaign.networkId || null,
      state: active ? "running" : "open",
      stateLabel: active ? "AI-led testing is active" : recommended ? "AI selects the pertinent checks" : campaign.required === false ? "Optional stronger assurance" : "AI chooses and runs the next campaign",
      cancelOperationId: active ? job.followup?.active?.id || null : null,
    });
  }

  const inputRequest = requestedInput(job);
  if (inputRequest) {
    items.push({
      key: "provide-information",
      kind: "feedback",
      shortTitle: "Information needed",
      title: "Information needed",
      detail: inputRequest.detail,
      focusDialogue: true,
      feedbackLabel: "Reply in dialogue",
      state: active ? "running" : "open",
      stateLabel: active ? "Wait for current testing" : "Only facts or intended behavior that AI cannot infer",
    });
  }

  if (["awaiting-testing", "awaiting-input"].includes(job.reportState?.status)) {
    items.push({
      key: "finish-testing",
      kind: "finish",
      shortTitle: campaign ? "Finish report" : "Generate report",
      title: campaign ? "Finish report" : "Generate report",
      detail: campaign
        ? "Stop further testing and publish the conclusion with any remaining limits clearly recorded."
        : "Publish the practical conclusion and clearly record any evidence that could not be obtained.",
      state: active ? "running" : "open",
      stateLabel: active ? "Available when testing stops" : campaign ? "Closes testing with remaining limits" : "Ready to publish",
    });
  }

  const summary = job.auditSynthesis?.status === "completed"
    ? "The AI auditor authored the current opinion from the source and recorded tool evidence."
    : "The AI auditor is still forming the current opinion.";
  return {
    visible: items.length > 0,
    verdictTitle: job.auditSynthesis?.status === "completed" ? "AI auditor opinion available" : "AI audit in progress",
    verdictSummary: summary,
    summary,
    items,
  };
}

function requestedInput(job) {
  if (job.operationLoop?.status !== "needs-input" || job.reportState?.status !== "awaiting-input") return null;
  const lastDecision = Array.isArray(job.operationLoop?.decisions) ? job.operationLoop.decisions.findLast((item) => item.status === "needs-input") : null;
  const detail = String(lastDecision?.requestedInput || job.operationLoop?.stopReason || job.reportState?.reason || "").trim();
  if (!detail) return null;
  return { detail };
}
