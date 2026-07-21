const TERMINAL_AUDIT_STATES = new Set(["completed", "partial", "failed", "cancelled"]);

export function deriveAuditInputControls(job) {
  if (!job) return { sourceReadOnly: false, loadDisabled: false, runDisabled: false, submittedDisabled: false };
  const auditActive = !TERMINAL_AUDIT_STATES.has(job.status);
  const followupActive = ["queued", "running"].includes(job.followup?.status);
  const copilotActive = job.copilot?.status === "running";
  const publishing = job.reportState?.status === "publishing";
  const awaitingTesting = ["awaiting-testing", "awaiting-input"].includes(job.reportState?.status);
  const operationActive = auditActive || followupActive || copilotActive || publishing;
  return {
    sourceReadOnly: operationActive || awaitingTesting,
    loadDisabled: operationActive,
    runDisabled: operationActive || awaitingTesting,
    submittedDisabled: operationActive || awaitingTesting,
  };
}
