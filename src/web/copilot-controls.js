const TERMINAL_AUDIT_STATES = new Set(["completed", "partial", "failed", "cancelled"]);

export function deriveCopilotControls({ job, authConnected, jobUnavailable = false }) {
  const auditFinished = Boolean(job && TERMINAL_AUDIT_STATES.has(job.status));
  const followupBusy = ["queued", "running"].includes(job?.followup?.status);
  const busy = job?.copilot?.status === "running" || followupBusy;
  const inputAvailable = auditFinished && authConnected && !jobUnavailable;
  const ready = inputAvailable && !busy;
  const title = jobUnavailable
    ? "This audit is no longer available after the service restart"
    : !auditFinished
      ? "Available when the audit finishes"
      : !authConnected
        ? "Sign in with ChatGPT to ask a question"
        : busy
          ? followupBusy ? "Wait for the active targeted check to finish" : "Audit Copilot is answering the previous question"
          : "Send this question as a new AI turn";
  return { ready, inputDisabled: !inputAvailable, title };
}
