import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServer } from "../src/server/ai/codex-app-server.js";
import { createAudit, getJob, queueAuditFollowup } from "../src/server/audit.js";
import { shutdownChildren } from "../src/server/process-registry.js";
import { probeTools } from "../src/server/tools.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const requestedDepth = args.depth || "review";
if (!["review", "targeted", "full", "all"].includes(requestedDepth)) throw new Error("--depth must be review, targeted, full, or all");
const depths = requestedDepth === "all" ? ["review", "targeted", "full"] : [requestedDepth];
const sourcePath = path.resolve(projectRoot, args.source || "samples/SmokeCounter.sol");
const authHome = path.resolve(args.authHome || process.env.ATTEST_LIVE_AUTH_HOME || "");
if (!authHome || authHome === projectRoot) throw new Error("Set ATTEST_LIVE_AUTH_HOME to a writable Codex home that is already authorized");
await access(path.join(authHome, "auth.json"));
const runtimeRoot = path.resolve(projectRoot, args.runtime || "work/live-audit-runs");
await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
const transcript = [];
const transcriptPath = path.join(runtimeRoot, `live-flow-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);

const source = await readFile(sourcePath, "utf8");
const capabilities = await probeTools(projectRoot);
if (!capabilities.codex.available) throw new Error("The project-pinned Codex app-server is unavailable");
const codex = new CodexAppServer({
  binary: capabilities.codex.command,
  codexHome: authHome,
  stateRoot: path.join(runtimeRoot, "codex-state"),
  model: process.env.SOLTESTING_MODEL || "gpt-5.6-luna",
});

let exitCode = 0;
try {
  const account = await codex.account();
  if (!account.connected) throw new Error("The supplied Codex home is not signed in with ChatGPT");
  emit({ event: "authenticated", accountType: account.type, depths, source: path.basename(sourcePath) });
  for (let index = 0; index < depths.length; index += 1) {
    const depth = depths[index];
    emit({ event: "audit-start", depth, sequence: index + 1, total: depths.length });
    const created = createAudit({
      projectRoot: runtimeRoot,
      capabilities,
      codex,
      source,
      fileName: path.basename(sourcePath),
      auditDepth: depth,
      allowLocalExecution: depth !== "review",
      allowAnvil: depth !== "review",
      allowForks: depth === "full" || args.allowForks,
      testCampaign: { mode: depth === "full" ? "deep" : "recommended" },
      declaredContext: {},
    });
    let job = await watchJob(created.id, { timeoutMs: Number(args.timeoutMinutes || (depth === "full" ? 120 : 45)) * 60_000 });
    if (args.runFollowup && job.followup?.actions?.filter((item) => item.status === "open" && item.runnable).length === 1) {
      const action = job.followup.actions.find((item) => item.status === "open" && item.runnable);
      const revisionCount = job.reportRevisions?.length || 0;
      emit({ event: "followup-authorized", depth, objective: action.objective, tool: action.tool });
      await queueAuditFollowup(job.id, { actionId: action.id, evidenceRevision: action.evidenceRevision, network: action.networkId || "ethereum" });
      job = await watchJob(job.id, {
        timeoutMs: Number(args.timeoutMinutes || 45) * 60_000,
        afterWorklogCount: job.worklog.length,
        terminal: (current) => current.followup?.history?.some((item) => item.actionId === action.id && ["completed", "failed", "cancelled"].includes(item.status))
          && current.followup?.status === "idle"
          && current.reportState?.status !== "publishing"
          && (current.reportRevisions?.length || 0) >= revisionCount,
      });
    }
    emit(summary(job));
    if (job.status === "failed" || job.reportState?.status === "failed") {
      exitCode = 1;
      const remaining = depths.slice(index + 1);
      if (remaining.length) emit({ event: "cycle-aborted", failedDepth: depth, remaining, reason: "A shared authenticated AI/runtime prerequisite failed; later depths were not started to avoid repeating the same failed model calls." });
      break;
    }
  }
} finally {
  await shutdownChildren().catch(() => {});
  emit({ event: "transcript", path: transcriptPath });
  await writeFile(transcriptPath, `${transcript.join("\n")}\n`, { mode: 0o600 }).catch(() => {});
}
process.exit(exitCode);

async function watchJob(id, { timeoutMs, afterWorklogCount = 0, terminal = defaultTerminal } = {}) {
  const deadline = Date.now() + timeoutMs;
  let worklogIndex = afterWorklogCount;
  while (Date.now() < deadline) {
    const job = getJob(id);
    if (!job) throw new Error(`Audit ${id} disappeared`);
    for (const entry of job.worklog.slice(worklogIndex)) {
      emit({ event: "worklog", depth: job.auditDepth, stage: entry.stage, status: entry.status, message: entry.message });
    }
    worklogIndex = job.worklog.length;
    if (terminal(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Audit ${id} exceeded the live-flow timeout`);
}

function emit(payload) {
  const line = JSON.stringify(payload);
  transcript.push(line);
  process.stdout.write(`${line}\n`);
}

function defaultTerminal(job) {
  return ["completed", "partial", "failed", "cancelled"].includes(job.status)
    && !["publishing"].includes(job.reportState?.status)
    && !["queued", "running"].includes(job.followup?.status)
    && job.copilot?.status !== "running";
}

function summary(job) {
  return {
    event: "summary",
    jobId: job.id,
    depth: job.auditDepth,
    status: job.status,
    reportStatus: job.reportState?.status,
    practicalVerdict: job.practicalVerdict || job.releaseDecision?.usability?.practicalVerdict || null,
    findings: (job.findings || []).map((item) => ({ id: item.id, severity: item.severity, title: item.title, verification: item.verification })),
    verification: job.verificationSummary,
    tools: (job.toolRuns || []).map((item) => ({ tool: item.tool, status: item.status, error: item.error || null })),
    operationStatus: job.operationLoop?.status,
    operationReason: job.operationLoop?.stopReason,
    reportRevisions: job.reportRevisions?.length || 0,
    reportPath: path.join(runtimeRoot, "work", "jobs", job.id, "findings.md"),
  };
}

function parseArgs(values) {
  const result = { runFollowup: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--run-followup") result.runFollowup = true;
    else if (value === "--allow-forks") result.allowForks = true;
    else if (["--depth", "--source", "--auth-home", "--runtime", "--timeout-minutes"].includes(value)) {
      const key = value.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
      result[key] = values[++index];
    } else throw new Error(`Unknown argument: ${value}`);
  }
  return result;
}
