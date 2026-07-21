const SETTLED_STAGE_STATES = new Set(["completed", "failed", "skipped", "timed-out"]);
const TERMINAL_JOB_STATES = new Set(["completed", "partial", "failed", "cancelled"]);
export const ACTIVE_JOB_STORAGE_KEY = "attest.active-audit-id";

export function createRequestGeneration() {
  let value = 0;
  return { begin() { value += 1; return value; }, current(candidate) { return candidate === value; } };
}

export async function pollAuditJob({ fetchJob, shouldContinue, onJob, isCurrent = () => true, sleep = defaultSleep, maxRetries = 5, baseDelayMs = 1_000 }) {
  let failures = 0;
  while (isCurrent()) {
    if (!shouldContinue()) return { status: "settled" };
    await sleep(failures ? Math.min(baseDelayMs * (2 ** failures), 15_000) : baseDelayMs);
    if (!isCurrent()) return { status: "stale" };
    try {
      const job = await fetchJob();
      if (!isCurrent()) return { status: "stale" };
      failures = 0;
      onJob(job);
    } catch (error) {
      failures += 1;
      if (failures > maxRetries) throw error;
    }
  }
  return { status: "stale" };
}

function defaultSleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

const FRIENDLY_STAGE_LABELS = {
  intake: "Preparing the contract",
  "ai-profile": "Understanding the whole contract",
  "operation-loop": "AI selecting and running evidence checks",
  "evidence-review": "AI adjudicating the evidence",
  report: "Preparing the results",
};

const FRIENDLY_OPERATION_LABELS = {
  slither: "Slither",
  aderyn: "Aderyn",
  foundry: "Foundry testing",
  "anvil-deployment": "Anvil deployment",
  "anvil-scenario": "Anvil scenario",
  "compiler-matrix": "Compiler matrix",
  fork: "Read-only fork testing",
};

export function deriveAuditProgress(job) {
  const stages = Array.isArray(job?.stages) ? job.stages : [];
  const settled = stages.filter((stage) => SETTLED_STAGE_STATES.has(stage.status));
  const currentIndex = stages.findIndex((stage) => stage.status === "running");
  const current = currentIndex >= 0 ? stages[currentIndex] : null;
  const latest = stages.findLast((stage) => SETTLED_STAGE_STATES.has(stage.status));
  const terminal = TERMINAL_JOB_STATES.has(job?.status);
  const reportReady = terminal && job?.reportState?.status === "ready";
  const total = stages.length;
  const settledCount = reportReady ? total : settled.length;
  const allSettled = total > 0 && settledCount === total;
  const rawPercent = total ? Math.round((settledCount / total) * 100) : 0;
  const percent = allSettled ? 100 : Math.max(current ? 4 : 0, Math.min(100, rawPercent));
  const state = terminal ? job.status : "active";
  const titles = {
    active: "Audit active",
    completed: "Audit complete",
    partial: "Audit finished with coverage gaps",
    failed: "Audit stopped before completion",
    cancelled: "Audit cancelled",
  };
  const stage = current || latest;
  const friendlyLabel = stage ? FRIENDLY_STAGE_LABELS[stage.id] || stage.label || "Audit work" : "Waiting to begin";
  const activeOperation = job?.operationLoop?.activeOperation;
  const operationLabel = activeOperation ? FRIENDLY_OPERATION_LABELS[activeOperation.kind] || activeOperation.kind : null;
  const operationDetail = activeOperation ? `${operationLabel}: ${activeOperation.objective}` : null;
  const controllerRound = Number(job?.operationLoop?.iteration) || 0;
  const evidenceChecks = Array.isArray(job?.operationLoop?.history) ? job.operationLoop.history.length : 0;
  const followupActive = ["queued", "running"].includes(job?.followup?.status);
  if (followupActive) return {
    state: "active", title: "Additional testing active", percent: Math.min(98, Math.max(rawPercent, 90)),
    count: `${settled.length} of ${total} stages reached an evidence result`,
    detail: job.followup?.active?.objective || "The AI auditor is gathering additional evidence.", active: true,
  };
  if (job?.reportState?.status === "awaiting-testing") return {
    state: "partial",
    title: "Testing decision needed",
    percent: Math.min(95, Math.max(rawPercent, 90)),
    count: `${settled.length} of ${total} stages reached an evidence result`,
    detail: job.reportState.reason || "Run the recommended check or finish testing to generate findings.",
    active: false,
  };
  if (job?.reportState?.status === "awaiting-input") return {
    state: "partial",
    title: "Information needed",
    percent: Math.min(95, Math.max(rawPercent, 90)),
    count: `${settled.length} of ${total} stages reached an evidence result`,
    detail: job.reportState.reason || "Provide the requested contract intent or deployment input, or finish with this limitation recorded.",
    active: false,
  };
  if (job?.reportState?.status === "publishing") return {
    state: "active",
    title: "Generating final findings",
    percent: 98,
    count: `${settled.length} of ${total} stages reached an evidence result`,
    detail: "Testing is closed; source integrity is being checked and final artifacts are being written.",
    active: true,
  };
  return {
    state,
    title: !terminal && operationLabel ? `${operationLabel} active` : titles[state] || titles.active,
    percent,
    count: terminal
      ? `${settledCount} of ${total} stages reached a result`
      : current?.id === "operation-loop" && controllerRound > 0
        ? `Stage ${currentIndex + 1} of ${total} · AI round ${controllerRound} · ${evidenceChecks} evidence check${evidenceChecks === 1 ? "" : "s"}`
      : current
        ? `Stage ${currentIndex + 1} of ${total} · ${settledCount} complete`
        : `${settledCount} of ${total} stages complete`,
    detail: operationDetail || (stage ? `${friendlyLabel}: ${stage.message || stage.status}` : "Waiting for the audit worker to start…"),
    active: !terminal,
  };
}
