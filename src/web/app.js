import { highlightSolidity } from "/solidity-highlight.js";
import { createApiClient, resolveLocalSessionToken } from "/session-client.js?v=20260720-session-recovery";
import { normalizeLoginLaunch, showLoginPopupMessage } from "/auth-flow.js";
import { ACTIVE_JOB_STORAGE_KEY, createRequestGeneration, deriveAuditProgress, pollAuditJob } from "/audit-progress.js";
import { deriveCopilotControls } from "/copilot-controls.js";
import { deriveCopilotOptions } from "/copilot-options.js";
import { deriveAuditInputControls } from "/audit-input-controls.js";

const api = createApiClient(resolveLocalSessionToken());
const terminalStates = new Set(["completed", "partial", "failed", "cancelled"]);

const elements = Object.fromEntries([
  "auth-status", "auth-button", "refresh-tools", "tool-summary", "tool-grid", "new-audit", "load-file", "file-input",
  "source-editor-shell", "source-highlight", "source-editor", "source-help", "source-size", "depth-review", "depth-targeted", "depth-full", "allow-local-execution", "allow-anvil", "allow-forks", "test-campaign-mode", "custom-campaign-fields",
  "generated-test-budget", "fuzz-runs", "invariant-runs", "invariant-depth", "campaign-timeout", "run-audit", "cancel-audit", "form-error",
  "results", "results-title",
  "export-actions", "contract-type", "trusted-roles", "intended-behaviors", "accepted-risks",
  "copilot-status", "copilot-feed", "copilot-live-status", "copilot-live-spinner", "copilot-live-title", "copilot-live-detail", "copilot-live-count", "copilot-input", "copilot-send", "copilot-help", "copilot-error", "fork-network",
].map((id) => [id, document.getElementById(id)]));

let fileName = "Target.sol";
let auth = { connected: false };
let activeJob = null;
let activeJobUnavailable = false;
let sourceEditGeneration = 0;
let expandedCopilotEntries = new Set();
const requests = createRequestGeneration();
const submittedControlIds = ["contract-type", "trusted-roles", "intended-behaviors", "accepted-risks", "depth-review", "depth-targeted", "depth-full", "allow-local-execution", "allow-anvil", "allow-forks", "test-campaign-mode", "generated-test-budget", "fuzz-runs", "invariant-runs", "invariant-depth", "campaign-timeout"];

// Browsers may restore a previously selected radio value across hard refreshes.
// A newly loaded Attest session always begins at the intended MVP default.
elements["depth-targeted"].checked = true;
syncSourceEditor();

elements["source-editor"].addEventListener("input", sourceChanged);
elements["source-editor"].addEventListener("scroll", syncEditorScroll);
for (const id of ["depth-review", "depth-targeted", "depth-full"]) elements[id].addEventListener("change", syncTestOption);
elements["test-campaign-mode"].addEventListener("change", syncTestOption);
elements["new-audit"].addEventListener("click", startNewAudit);
elements["load-file"].addEventListener("click", openFilePicker);
elements["file-input"].addEventListener("change", loadFile);
elements["auth-button"].addEventListener("click", toggleAuth);
elements["refresh-tools"].addEventListener("click", refreshCapabilities);
elements["run-audit"].addEventListener("click", startAudit);
elements["cancel-audit"].addEventListener("click", cancelAudit);
elements["copilot-send"].addEventListener("click", askCopilot);
elements["copilot-input"].addEventListener("input", syncCopilotControls);
elements["copilot-input"].addEventListener("keydown", submitCopilotOnEnter);
elements["copilot-feed"].addEventListener("click", handleCopilotOptionAction);

const [capabilityLoad, authLoad] = await Promise.allSettled([loadCapabilities(), loadAuth()]);
if (capabilityLoad.status === "rejected") {
  elements["tool-summary"].textContent = "Audit engine detection failed. Use Refresh detection to try again.";
  const unavailable = node("article", "tool-card");
  unavailable.append(node("strong", "", "Engine detection unavailable"), node("p", "", capabilityLoad.reason.message));
  elements["tool-grid"].replaceChildren(unavailable);
}
if (authLoad.status === "rejected") {
  elements["auth-status"].textContent = "AI connection check failed";
  elements["form-error"].textContent = authLoad.reason.message;
}
await restoreActiveJob();

async function restoreActiveJob() {
  const id = localStorage.getItem(ACTIVE_JOB_STORAGE_KEY);
  if (!id) return;
  const generation = requests.begin();
  try {
    const restored = await api(`/api/audits/${id}`);
    if (!requests.current(generation)) return;
    activeJob = restored;
    if (sourceEditGeneration === 0 && typeof restored.source === "string") {
      fileName = restored.fileName || fileName;
      elements["source-editor"].value = restored.source;
      syncSourceEditor();
    }
    activeJobUnavailable = false;
    elements.results.classList.remove("hidden");
    renderJob(activeJob);
    if (!terminalStates.has(activeJob.status) || activeJob.reportState?.status === "publishing" || ["queued", "running"].includes(activeJob.followup?.status) || activeJob.copilot?.status === "running") await pollCurrentJob(generation);
  } catch (error) {
    if (!requests.current(generation)) return;
    activeJobUnavailable = error.message === "Audit job not found";
    if (activeJobUnavailable) localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
    elements["form-error"].textContent = activeJobUnavailable ? "The saved audit is no longer available after the local service restarted." : error.message;
  }
}

async function loadCapabilities() {
  const data = await api("/api/capabilities");
  renderCapabilities(data.analyzers);
}

async function refreshCapabilities() {
  elements["refresh-tools"].disabled = true;
  elements["form-error"].textContent = "";
  try {
    const data = await api("/api/capabilities/refresh", { method: "POST" });
    renderCapabilities(data.analyzers);
  } catch (error) {
    elements["form-error"].textContent = `Could not refresh audit engines: ${error.message}`;
  } finally {
    elements["refresh-tools"].disabled = false;
  }
}

function renderCapabilities(tools) {
  const ready = tools.filter((tool) => tool.available).length;
  elements["tool-summary"].textContent = `${ready} of ${tools.length} audit engines are available on this workstation.`;
  elements["tool-grid"].replaceChildren(...tools.map((tool) => {
    const card = node("article", "tool-card");
    const top = node("div", "tool-top");
    top.append(node("strong", "", tool.label), node("span", `availability ${tool.available ? "yes" : ""}`, tool.available ? "Ready" : "Missing"));
    card.append(top, node("span", "tool-version", tool.version || "not installed"), node("p", "", `${tool.tier} · ${tool.role}`));
    return card;
  }));
}

async function loadAuth() {
  auth = await api("/api/auth");
  if (auth.connected) {
    elements["auth-status"].textContent = `${auth.email || "ChatGPT"} · ${auth.planType || "connected"}`;
    elements["auth-button"].textContent = "Sign out";
  } else {
    elements["auth-status"].textContent = auth.error || (auth.available ? "AI review not connected" : "Codex CLI unavailable");
    elements["auth-button"].textContent = "Sign in with ChatGPT";
    elements["auth-button"].disabled = !auth.available;
  }
  syncTestOption();
  syncCopilotControls();
}

async function toggleAuth() {
  elements["form-error"].textContent = "";
  elements["auth-button"].disabled = true;
  let popup = null;
  try {
    if (auth.connected) {
      await api("/api/auth/logout", { method: "POST" });
      await loadAuth();
      return;
    }
    popup = window.open("about:blank", "soltesting-chatgpt-login", "width=680,height=760");
    showLoginPopupMessage(popup, "Preparing secure ChatGPT sign-in…");
    elements["auth-status"].textContent = "Preparing secure ChatGPT sign-in…";
    const result = await api("/api/auth/login", { method: "POST" });
    const launch = normalizeLoginLaunch(result);
    elements["auth-status"].textContent = launch.message;
    if (popup) popup.location.replace(launch.url);
    else window.location.href = launch.url;
    let connected = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      await delay(2_000);
      await loadAuth();
      if (auth.connected) {
        connected = true;
        break;
      }
      elements["auth-status"].textContent = launch.message;
    }
    if (!connected) throw new Error("ChatGPT sign-in did not finish within three minutes. You can retry without restarting the audit service.");
  } catch (error) {
    showLoginPopupMessage(popup, `ChatGPT sign-in could not start. ${error.message} Return to Attest after correcting this issue.`);
    elements["form-error"].textContent = error.message;
    elements["auth-status"].textContent = "ChatGPT sign-in did not start";
  } finally {
    elements["auth-button"].disabled = false;
  }
}

async function loadFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    if (!file.name.toLowerCase().endsWith(".sol")) throw new Error("Choose a .sol file.");
    const source = await readFileText(file);
    const replacedAudit = Boolean(activeJob);
    detachActiveJob();
    activeJobUnavailable = false;
    expandedCopilotEntries = new Set();
    elements.results.classList.add("hidden");
    syncAuditInputLock(null);
    fileName = file.name;
    sourceEditGeneration += 1;
    elements["source-editor"].value = source;
    elements["form-error"].textContent = "";
    elements["source-help"].textContent = replacedAudit
      ? `Loaded ${file.name} for a new audit. The previous audit remains saved locally.`
      : `Loaded ${file.name} as a read-only audit copy.`;
    syncSourceEditor();
  } catch (error) {
    elements["form-error"].textContent = `Could not load ${file.name}: ${error.message}`;
  } finally {
    event.target.value = "";
  }
}

function sourceChanged() {
  sourceEditGeneration += 1;
  if (activeJob && terminalStates.has(activeJob.status) && !["queued", "running"].includes(activeJob.followup?.status) && activeJob.copilot?.status !== "running") detachActiveJob();
  syncSourceEditor();
}

function detachActiveJob() {
  requests.begin();
  activeJob = null;
  activeJobUnavailable = false;
  expandedCopilotEntries = new Set();
  localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
  elements.results.classList.add("hidden");
  syncAuditInputLock(null);
}

function startNewAudit() {
  if (!activeJob) return;
  const controls = deriveAuditInputControls(activeJob);
  if (controls.loadDisabled) {
    elements["form-error"].textContent = "Cancel the active audit before starting another one.";
    return;
  }
  detachActiveJob();
  fileName = "Target.sol";
  sourceEditGeneration += 1;
  elements["file-input"].value = "";
  elements["source-editor"].value = "";
  elements["form-error"].textContent = "";
  elements["source-help"].textContent = "New audit ready. Load a .sol file or paste Solidity source. The previous audit and report remain saved locally.";
  syncSourceEditor();
  elements["source-editor"].focus();
}

function openFilePicker() {
  elements["file-input"].value = "";
  elements["file-input"].click();
}

function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")), { once: true });
    reader.addEventListener("error", () => reject(reader.error || new Error("The browser could not read this file.")), { once: true });
    reader.readAsText(file);
  });
}

async function startAudit() {
  elements["form-error"].textContent = "";
  if (!elements["source-editor"].value.trim()) {
    elements["form-error"].textContent = "Load a .sol file or paste Solidity source before starting an audit.";
    elements["source-editor"].focus();
    return;
  }
  if (!auth.connected) {
    elements["form-error"].textContent = "Sign in with ChatGPT before starting the AI auditor.";
    elements["auth-button"].focus();
    return;
  }
  const previousJob = activeJob;
  const generation = requests.begin();
  elements["run-audit"].disabled = true;
  elements["run-audit"].textContent = "Audit running…";
  elements["source-editor"].readOnly = true;
  elements["load-file"].disabled = true;
  elements["file-input"].disabled = true;
  for (const id of submittedControlIds) elements[id].disabled = true;
  elements["cancel-audit"].classList.remove("hidden");
  try {
    const createdJob = await api("/api/audits", {
      method: "POST",
      body: JSON.stringify({
        source: elements["source-editor"].value,
        fileName,
        useAi: true,
        auditDepth: selectedAuditDepth(),
        allowLocalExecution: elements["allow-local-execution"].checked,
        allowAnvil: elements["allow-anvil"].checked,
        allowForks: elements["allow-forks"].checked,
        testCampaign: {
          mode: elements["test-campaign-mode"].value,
          generatedTestBudget: Number(elements["generated-test-budget"].value),
          fuzzRuns: Number(elements["fuzz-runs"].value),
          invariantRuns: Number(elements["invariant-runs"].value),
          invariantDepth: Number(elements["invariant-depth"].value),
          timeoutMinutes: Number(elements["campaign-timeout"].value),
        },
        declaredContext: {
          contractType: elements["contract-type"].value,
          trustedRoles: elements["trusted-roles"].value,
          intendedBehaviors: elements["intended-behaviors"].value,
          acceptedRisks: elements["accepted-risks"].value,
        },
      }),
    });
    if (!requests.current(generation)) return;
    activeJob = createdJob;
    localStorage.setItem(ACTIVE_JOB_STORAGE_KEY, activeJob.id);
    activeJobUnavailable = false;
    expandedCopilotEntries = new Set();
    elements.results.classList.remove("hidden");
    renderJob(activeJob);
    await pollCurrentJob(generation);
    if (!requests.current(generation)) return;
    elements["results-title"].focus();
  } catch (error) {
    if (!requests.current(generation)) return;
    elements["form-error"].textContent = error.message;
    if (!activeJob || activeJob === previousJob) {
      activeJob = previousJob;
      syncAuditInputLock(previousJob && terminalStates.has(previousJob.status) ? previousJob : null);
    }
  } finally {
    if (!requests.current(generation)) return;
    elements["run-audit"].disabled = ["awaiting-testing", "awaiting-input", "publishing"].includes(activeJob?.reportState?.status);
    if (!activeJob) syncAuditInputLock(null);
    elements["run-audit"].textContent = "Run evidence-backed audit";
    elements["cancel-audit"].classList.toggle("hidden", !activeJob || terminalStates.has(activeJob.status));
  }
}

async function pollCurrentJob(generation) {
  const id = activeJob?.id;
  if (!id) return;
  await pollAuditJob({
    fetchJob: () => api(`/api/audits/${id}`),
    shouldContinue: () => Boolean(activeJob && activeJob.id === id && (!terminalStates.has(activeJob.status) || activeJob.reportState?.status === "publishing" || ["queued", "running"].includes(activeJob.followup?.status) || activeJob.copilot?.status === "running")),
    isCurrent: () => requests.current(generation) && activeJob?.id === id,
    onJob: (job) => { activeJob = job; localStorage.setItem(ACTIVE_JOB_STORAGE_KEY, job.id); renderJob(job); },
  });
}

async function cancelAudit() {
  if (!activeJob || terminalStates.has(activeJob.status)) return;
  elements["cancel-audit"].disabled = true;
  elements["cancel-audit"].textContent = "Cancelling…";
  try {
    activeJob = await api(`/api/audits/${activeJob.id}/cancel`, { method: "POST" });
    renderJob(activeJob);
  } catch (error) {
    elements["form-error"].textContent = error.message;
  } finally {
    elements["cancel-audit"].disabled = false;
    elements["cancel-audit"].textContent = "Cancel audit";
  }
}

function renderJob(job) {
  syncAuditInputLock(job);
  elements["cancel-audit"].classList.toggle("hidden", terminalStates.has(job.status));
  renderCopilot(job);
  renderExports(job);
}

function renderCopilot(job) {
  const feed = elements["copilot-feed"];
  const previousScroll = feed.scrollTop;
  const wasNearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 36;
  for (const item of feed.querySelectorAll("details.copilot-message[data-entry-id]")) {
    if (item.open) expandedCopilotEntries.add(item.dataset.entryId);
    else expandedCopilotEntries.delete(item.dataset.entryId);
  }
  const activity = (job.worklog || []).filter(copilotEventRelevant).map((event) => ({
    id: `event-${event.id}`,
    at: event.at,
    role: "system",
    kind: event.status === "running" ? "activity" : event.status,
    author: copilotEventAuthor(event),
    text: copilotEventText(event),
    details: auditEventDetails(job, event),
  }));
  const evidence = buildEvidenceEntries(job);
  const auditModel = buildAuditModelEntries(job);
  const sourceReasoning = buildSourceConclusionEntries(job);
  const verification = buildVerificationEntries(job);
  const conclusion = buildPracticalConclusionEntries(job);
  const discussion = job.copilot?.messages || [];
  const entries = [...activity, ...auditModel, ...sourceReasoning, ...evidence, ...verification, ...conclusion, ...discussion].sort((left, right) => left.at.localeCompare(right.at));
  const actionMessage = renderCopilotOptions(job);
  if (!entries.length && !actionMessage) {
    const empty = node("div", "copilot-empty");
    empty.append(node("strong", "", "No audit activity yet"), node("span", "", "Start an audit to populate the live dialogue."));
    feed.replaceChildren(empty);
  } else {
    const children = entries.map(renderCopilotEntry);
    if (actionMessage) children.push(actionMessage);
    feed.replaceChildren(...children);
  }
  if (wasNearBottom) feed.scrollTop = feed.scrollHeight;
  else feed.scrollTop = previousScroll;
  renderLiveAuditStatus(job);

  const followupRunning = ["queued", "running"].includes(job.followup?.status);
  const status = followupRunning ? "running" : job.copilot?.status || "idle";
  const auditFinished = terminalStates.has(job.status);
  const awaitingTesting = ["awaiting-testing", "awaiting-input"].includes(job.reportState?.status);
  elements["copilot-status"].className = `status-pill ${status === "running" ? "running" : status === "failed" ? "failed" : awaitingTesting ? "partial" : auditFinished ? "completed" : "running"}`;
  elements["copilot-status"].textContent = followupRunning ? "AI testing active" : awaitingTesting ? "Testing decision needed" : status === "running" ? "Answering" : status === "failed" ? "Needs attention" : auditFinished ? "Ready" : "Live";
  const followupDisclosure = "Questions start a separate AI turn. You can provide genuinely missing constructor values, configuration, or intended behavior here. Continue testing lets AI choose, run, repair, and review Foundry, Anvil, or read-only fork checks for the selected campaign time window. It stops when questions are answered, a specific blocker repeats, you cancel, or that window ends—not after an arbitrary number of AI turns. Finish report closes testing with any remaining limits recorded. Press Enter to send or Shift+Enter for a new line. Never paste private keys, seed phrases, passwords, RPC credentials, or API tokens.";
  elements["copilot-help"].textContent = !auditFinished
    ? `Live milestones appear above. Questions unlock after the audit finishes. ${followupDisclosure}`
    : !auth.connected
      ? `Sign in with ChatGPT to ask a source-cited follow-up question. ${followupDisclosure}`
      : followupDisclosure;
  if (job.copilot?.error && !elements["copilot-error"].textContent) elements["copilot-error"].textContent = job.copilot.error;
  else if (status !== "failed") elements["copilot-error"].textContent = "";
  syncCopilotControls();
}

function renderLiveAuditStatus(job) {
  const progress = deriveAuditProgress(job);
  elements["copilot-live-status"].className = `copilot-live-status ${progress.active ? "running" : progress.state}`;
  elements["copilot-live-spinner"].classList.toggle("hidden", !progress.active);
  elements["copilot-live-title"].textContent = progress.title;
  elements["copilot-live-detail"].textContent = progress.detail;
  elements["copilot-live-count"].textContent = `${progress.count} · ${progress.percent}%`;
}

function buildPracticalConclusionEntries(job) {
  // The AI-authored conclusion is already a first-class Copilot message.
  // Do not add a second server-generated verdict card beside it.
  return [];
}

function renderCopilotEntry(entry) {
  const expandable = Array.isArray(entry.details) && entry.details.length > 0;
  const item = node(expandable ? "details" : "article", `copilot-message ${entry.role || "system"} ${entry.kind || ""}`);
  const head = node("div", "copilot-message-head");
  const author = entry.role === "user" ? "Developer" : entry.role === "assistant" ? (entry.kind === "conclusion" ? "Audit conclusion" : "Audit Copilot") : entry.author || "Audit engine";
  head.append(node("strong", "", author), node("time", "", formatTime(entry.at)));
  const text = node("p", "", entry.text);
  if (expandable) {
    item.dataset.entryId = entry.id;
    item.open = expandedCopilotEntries.has(entry.id);
    const summary = node("summary", "copilot-message-summary");
    summary.append(head, text);
    const detail = node("div", "copilot-message-details");
    for (const fact of entry.details) {
      const row = node("div", "copilot-fact");
      row.append(node("strong", "", fact.label), node("span", "", fact.value));
      detail.append(row);
    }
    item.append(summary, detail);
  } else item.append(head, text);
  if (entry.citations?.length) {
    const citations = node("div", "copilot-citations");
    citations.append(node("span", "copilot-detail-label", "Source citations"));
    for (const citation of entry.citations) {
      const citationBox = node("div", "copilot-citation");
      citationBox.append(node("strong", "", `Lines ${citation.lineStart}–${citation.lineEnd}`), node("span", "", citation.why));
      const quote = node("pre");
      const code = node("code");
      code.innerHTML = highlightSolidity(citation.quote);
      quote.append(code);
      citationBox.append(quote);
      citations.append(citationBox);
    }
    item.append(citations);
  }
  if (entry.suggestedNextSteps?.length) {
    const suggestions = node("div", "copilot-suggestions");
    suggestions.append(node("span", "copilot-detail-label", "Suggested next steps"));
    for (const step of entry.suggestedNextSteps) {
      suggestions.append(node("span", "copilot-suggestion copilot-suggestion-note", step.label));
    }
    item.append(suggestions);
  }
  if (entry.developerInput) {
    const inputBox = node("div", "copilot-suggestions");
    inputBox.append(node("span", "copilot-detail-label", entry.developerInput.status === "accepted" ? "Developer input accepted" : "Developer input not applied"));
    inputBox.append(node("span", "copilot-suggestion", entry.developerInput.summary));
    if (entry.developerInput.normalizedPlan) {
      const plan = entry.developerInput.normalizedPlan;
      const argumentsText = (plan.constructorArguments || []).map((arg) => `${arg.name || `arg ${arg.position}`} (${arg.solidityType}) = ${arg.valueKind === "anvil-account" ? `actor-${arg.value}` : arg.value}`).join("; ") || "no constructor arguments";
      inputBox.append(node("span", "copilot-suggestion", `${plan.targetContract}: ${argumentsText}; deployment value ${plan.transactionValueWei || "0"} wei`));
    }
    for (const context of entry.developerInput.contextStatements || []) {
      inputBox.append(node("span", "copilot-suggestion", `${context.category}: “${context.statement}”`));
    }
    item.append(inputBox);
  }
  return item;
}

function copilotEventRelevant(event) {
  if (event.stage === "job" && event.status === "queued") return true;
  if (event.stage === "operation-loop") return ["running", "checkpoint", "decision", "completed", "reviewed", "evidence", "failed", "timed-out", "unavailable", "not-authorized", "skipped", "budget-exhausted", "cancelled"].includes(event.status);
  if (["intake", "quality"].includes(event.stage)) return ["running", "checkpoint", "completed", "failed", "unavailable", "warning", "skipped"].includes(event.status);
  if (["ai-review", "evidence-review", "synthesis"].includes(event.stage) && ["running", "checkpoint", "completed", "failed"].includes(event.status)) return true;
  if (event.stage === "followup") return true;
  if (event.stage === "copilot") return false;
  return ["completed", "failed", "timed-out", "skipped", "warning", "rejected", "summary", "cancelled"].includes(event.status);
}

function copilotEventAuthor(event) {
  const text = String(event.message || "").toLowerCase();
  if (event.stage === "ai-profile") return "AI contract review";
  if (event.stage === "ai-review") return "AI analyzer review";
  if (event.stage === "evidence-review") return "AI evidence review";
  if (event.stage === "synthesis") return "AI audit conclusion";
  if (event.stage === "quality") return "Solhint quality check";
  if (event.stage === "intake") return /compiler|foundry/.test(text) ? "Foundry compiler" : "Audit intake";
  if (event.stage === "operation-loop") {
    if (/slither/.test(text)) return "Slither";
    if (/aderyn/.test(text)) return "Aderyn";
    if (/anvil|disposable loopback|deployment/.test(text)) return "Anvil local chain";
    if (/foundry|forge|fuzz|invariant|property/.test(text)) return "Foundry testing";
    if (/compiler-matrix|solidity [0-9]|compiler/.test(text)) return "Compiler matrix";
    return "AI audit controller";
  }
  if (event.stage === "followup") return "Additional testing";
  return "Audit engine";
}

function buildVerificationEntries(job) {
  if (!job.verificationResults?.length) return [];
  const fullMode = job.auditDepth === "full";
  const reviewTime = (job.worklog || []).findLast((event) => event.stage === "evidence-review")?.at || job.updatedAt;
  const answered = job.verificationResults.filter((item) => item.status !== "not-verified");
  const gaps = job.verificationResults.filter((item) => item.status === "not-verified");
  const entries = answered.map((item, index) => ({
    id: `verification-${item.id}`,
    at: new Date(new Date(reviewTime).getTime() + index + 1000).toISOString(),
    role: "system",
    kind: item.status,
    author: "Verification answer",
    text: `${verificationStateLabel(item.status)} — ${item.question}`,
    details: [
      { label: "Question", value: item.question },
      { label: "Conclusion", value: item.answer },
      { label: "Confidence", value: item.confidence },
      { label: "Assurance", value: item.evidenceClasses?.join(" + ") || "source review" },
      { label: "Evidence", value: item.relatedTestIds?.length ? item.relatedTestIds.join(", ") : "Source and recorded tool evidence" },
    ],
  }));
  if (gaps.length) {
    entries.push({
      id: "verification-coverage-gaps",
      at: new Date(new Date(reviewTime).getTime() + answered.length + 1000).toISOString(),
      role: "system",
      kind: fullMode ? "coverage-gap" : "recommended-check",
      author: fullMode ? "Coverage summary" : "Recommended checks",
      text: fullMode
        ? `${gaps.length} verification check${gaps.length === 1 ? "" : "s"} still need evidence before the report can claim full-audit coverage.`
        : `${gaps.length} stronger verification check${gaps.length === 1 ? " is" : "s are"} available if you want runtime, fork, compiler, or analyzer assurance beyond the selected AI opinion.`,
      details: gaps.slice(0, 8).map((item) => ({
        label: item.nextCheck?.tool || "Next check",
        value: `${item.question} - ${item.nextCheck?.objective || item.answer || "additional evidence needed"}`,
      })),
    });
  }
  return entries;
}

function buildSourceConclusionEntries(job) {
  if (!job.sourceConclusions?.length) return [];
  const profileTime = (job.worklog || []).findLast((event) => event.stage === "ai-profile" && event.status === "completed")?.at || job.updatedAt;
  return job.sourceConclusions.map((item, index) => ({
    id: `source-conclusion-${item.id}`,
    at: new Date(new Date(profileTime).getTime() + index + 100).toISOString(),
    role: "system",
    kind: "ai-source-supported",
    author: "AI source trace",
    text: `AI source-supported — ${item.statement}`,
    details: [
      { label: "Conclusion", value: item.statement },
      { label: "Why", value: item.rationale },
      { label: "Confidence", value: item.confidence },
      { label: "Source", value: (item.evidence || []).map((evidence) => `lines ${evidence.lineStart}-${evidence.lineEnd}: ${evidence.quote}`).join(" | ") },
      ...(item.relatedQuestionIds?.length ? [{ label: "Stronger verification", value: item.relatedQuestionIds.join(", ") }] : []),
    ],
  }));
}

function buildAuditModelEntries(job) {
  const result = job.ai?.result;
  if (!result) return [];
  const sections = [
    ["Money flow", result.moneyFlow],
    ["Permission flow", result.permissionFlow],
    ["Trust assumptions", result.trustAssumptions],
    ["Safety invariants", result.invariants],
  ].filter(([, values]) => values?.length);
  if (!sections.length) return [];
  const profileTime = (job.worklog || []).findLast((event) => event.stage === "ai-profile" && event.status === "completed")?.at || job.updatedAt;
  return [{
    id: "whole-contract-audit-model",
    at: new Date(new Date(profileTime).getTime() + 50).toISOString(),
    role: "system",
    kind: "ai-source-supported",
    author: "AI contract model",
    text: `Whole-contract model — ${sections.map(([label, values]) => `${values.length} ${label.toLowerCase()} item${values.length === 1 ? "" : "s"}`).join(", ")}`,
    details: sections.flatMap(([label, values]) => values.map((value, index) => ({ label: index === 0 ? label : `${label} ${index + 1}`, value }))),
  }];
}

function followupActionStateText(action) {
  if (action.tool === "controller") return ["queued", "running"].includes(action.status) ? "AI-controlled auditing is active" : action.status === "consumed" ? "Controller run completed" : "Continue audit is ready";
  if (action.status === "declined") return "Not run — testing was closed";
  if (action.status === "consumed") return "Completed in a targeted pass";
  if (["queued", "running"].includes(action.status)) return "This check is running";
  if (action.tool === "anvil") return action.runnable ? "Local deployment plan is ready" : "Provide the missing deployment input in Audit Copilot";
  if (action.tool === "compiler-matrix") return "Compiler-matrix automation is not available in this MVP";
  if (action.tool === "developer-context") return action.runnable ? "Developer context is ready for evidence re-review" : "Provide the requested context in Audit Copilot";
  return `${action.tool || "This check"} is a recorded recommendation, not a runnable action`;
}

async function handleCopilotFeedAction(event) {
  const button = event.target.closest("button[data-followup-action]");
  if (!button || !activeJob) return;
  button.disabled = true;
  const generation = requests.begin();
  elements["copilot-error"].textContent = "";
  try {
    const jobId = activeJob.id;
    activeJob = await api(`/api/audits/${jobId}/followups`, {
      method: "POST",
      body: JSON.stringify({ actionId: button.dataset.followupAction, evidenceRevision: Number(button.dataset.evidenceRevision), network: button.dataset.followupNetwork || elements["fork-network"].value }),
    });
    renderJob(activeJob);
    if (!requests.current(generation)) return;
    localStorage.setItem(ACTIVE_JOB_STORAGE_KEY, activeJob.id);
    renderJob(activeJob);
    await pollCurrentJob(generation);
  } catch (error) {
    if (!requests.current(generation)) return;
    elements["copilot-error"].textContent = error.message;
    renderJob(activeJob);
  }
}

function renderCopilotOptions(job) {
  const view = deriveCopilotOptions(job);
  if (!view.visible) return null;
  const message = node("article", "copilot-message assistant copilot-options");
  message.setAttribute("aria-label", "Audit Copilot next actions");
  const heading = node("div", "copilot-options-heading");
  heading.append(
    node("strong", "", "Audit Copilot"),
    node("span", "copilot-options-count", `${view.items.length} option${view.items.length === 1 ? "" : "s"}`),
  );
  const verdict = node("div", "copilot-options-verdict");
  verdict.append(node("strong", "", view.verdictTitle));
  const summary = node("p", "copilot-options-summary", view.summary);
  const list = node("div", "copilot-options-list");
  list.replaceChildren(...view.items.map((item, index) => {
    const card = node("div", `copilot-option ${item.kind} ${item.state}`);
    const detailId = `copilot-option-detail-${index}`;
    const copy = node("div", "copilot-option-copy");
    const top = node("div", "copilot-option-top");
    top.append(node("strong", "copilot-option-name", item.shortTitle || item.title), node("span", `copilot-option-state ${item.state}`, item.stateLabel));
    const detail = node("p", "copilot-option-detail", item.detail || "");
    detail.id = detailId;
    copy.append(top, detail);
    card.append(copy);
    const actions = node("div", "copilot-option-actions");
    if (item.actionId && item.state === "open") {
      const run = node("button", "button primary", followupButtonLabel(item));
      run.type = "button";
      run.dataset.followupAction = item.actionId;
      run.dataset.evidenceRevision = String(item.evidenceRevision);
      if (item.networkId) run.dataset.followupNetwork = item.networkId;
      run.setAttribute("aria-describedby", detailId);
      actions.append(run);
    }
    if (item.focusDialogue && item.state === "open") {
      const respond = node("button", "button secondary", item.feedbackLabel);
      respond.type = "button";
      respond.dataset.copilotFocus = "true";
      respond.setAttribute("aria-describedby", detailId);
      actions.append(respond);
    }
    if (item.kind === "finish" && item.state === "open") {
      const finish = node("button", "button secondary", item.title);
      finish.type = "button";
      finish.dataset.finishTesting = "true";
      finish.setAttribute("aria-describedby", detailId);
      actions.append(finish);
    }
    if (item.cancelOperationId) {
      const cancel = node("button", "button secondary", "Cancel additional testing");
      cancel.type = "button";
      cancel.dataset.cancelFollowup = item.cancelOperationId;
      actions.append(cancel);
    }
    if (actions.childElementCount) card.append(actions);
    return card;
  }));
  message.append(heading, verdict, summary, list);
  return message;
}

function followupButtonLabel(item) {
  if (item.tool === "controller") return item.title === "Run recommended tests" ? "Run recommended tests" : "Continue audit";
  if (item.tool === "anvil") return "Run the local-chain check";
  if (item.tool === "developer-context") return "Apply your information and re-review";
  if (item.tool === "fork") return item.networkId ? `Run the ${item.networkId} fork check` : "Run the selected fork check";
  return "Run check";
}

async function handleCopilotOptionAction(event) {
  const cancelFollowup = event.target.closest("button[data-cancel-followup]");
  if (cancelFollowup) {
    await cancelActiveFollowup(cancelFollowup.dataset.cancelFollowup);
    return;
  }
  if (event.target.closest("button[data-copilot-focus]")) {
    elements["copilot-input"].focus();
    return;
  }
  if (event.target.closest("button[data-finish-testing]")) {
    finishTesting();
    return;
  }
  handleCopilotFeedAction(event);
}

async function cancelActiveFollowup(operationId) {
  if (!activeJob || !operationId) return;
  const generation = requests.begin();
  elements["copilot-error"].textContent = "";
  try {
    const jobId = activeJob.id;
    const job = await api(`/api/audits/${jobId}/followups/${operationId}/cancel`, { method: "POST" });
    if (!requests.current(generation)) return;
    activeJob = job;
    renderJob(job);
    if (["queued", "running"].includes(job.followup?.status)) await pollCurrentJob(generation);
  } catch (error) {
    if (requests.current(generation)) elements["copilot-error"].textContent = error.message;
  }
}

function verificationStateLabel(state) {
  return ({ "ai-supported": "AI-supported", "ai-supported-concern": "AI-supported concern", "accepted-behavior": "accepted behavior", "developer-decision": "developer decision", "not-verified": "recommended check", "coverage-gap": "coverage gap", "recommended-check": "recommended check" })[state] || state;
}

function copilotEventText(event) {
  if (event.status !== "checkpoint" || !event.details) return event.message;
  const progress = event.details;
  return `${event.message}. ${progress.groups} evidence group(s), ${progress.duplicates} grouped duplicate(s), ${progress.batchesCompleted} completed batch(es).`;
}

function buildEvidenceEntries(job) {
  if (!terminalStates.has(job.status) && !["completed", "failed"].includes(job.ai?.status)) return [];
  const reviewTime = (job.worklog || []).findLast((event) => event.stage === "ai-review" && event.status === "completed")?.at || job.updatedAt;
  return (job.reviewTouchpoints || []).map((touchpoint, index) => ({
    id: `evidence-${touchpoint.id}`,
    at: new Date(new Date(reviewTime).getTime() + index).toISOString(),
    role: "system",
    kind: touchpoint.state,
    author: "Evidence conclusion",
    text: `${touchpointStateLabel(touchpoint.state)} — ${touchpoint.location.file}:${touchpoint.location.line || "?"}`,
    details: [
      { label: "Disposition", value: touchpointStateLabel(touchpoint.state) },
      { label: "Source location", value: `${touchpoint.location.file}:${touchpoint.location.line || "?"}` },
      { label: "Analyzer evidence", value: touchpoint.detectors.join(" + ") || "normalized analyzer evidence" },
      ...(touchpoint.reason ? [{ label: "Why", value: touchpoint.reason }] : []),
      ...(touchpoint.impact ? [{ label: "Impact", value: touchpoint.impact }] : []),
      ...(touchpoint.trigger ? [{ label: "Trigger", value: touchpoint.trigger }] : []),
      ...(touchpoint.action ? [{ label: "Point to address", value: touchpoint.action }] : []),
    ],
  }));
}

function auditEventDetails(job, event) {
  const facts = [{ label: "Stage", value: event.stage }, { label: "Outcome", value: event.status }];
  const toolByStage = { compile: "forge", anvil: "anvil-deployment", "static-slither": "slither", "static-aderyn": "aderyn", "quality-solhint": "solhint" };
  const run = job.toolRuns?.findLast((item) => item.tool === toolByStage[event.stage]);
  if (run) {
    facts.push({ label: "Tool", value: `${run.tool}${run.version ? ` ${run.version}` : ""}` });
    facts.push({ label: "Execution", value: `${run.status}${run.timedOut ? " · timed out" : ""}${run.error ? ` · ${run.error}` : ""}` });
  }
  if (event.stage === "profile" && job.contractProfile) facts.push({ label: "Contract profile", value: (job.contractProfile.archetypes || []).join(", ") || "custom contract" });
  if (event.stage === "anvil") {
    facts.push({ label: "Deployment", value: job.anvil?.status || "not requested" });
    if (job.aiDeploymentPlan) {
      facts.push({ label: "AI plan", value: `${job.aiDeploymentPlan.decision} · ${job.aiDeploymentPlan.targetContract || "target not selected"} · ${job.aiDeploymentPlan.constructorArguments?.length || 0} constructor argument(s)` });
      facts.push({ label: "Plan rationale", value: job.aiDeploymentPlan.rationale || "No rationale returned" });
    }
    facts.push({ label: "Result", value: job.anvil?.status === "completed" ? `${job.anvil.contract} deployed and bytecode verified on chain ${job.anvil.chainId}` : job.anvil?.reason || "No deployment result" });
  }
  if (event.stage === "tests" && job.testCampaign) {
    facts.push({ label: "Property campaign", value: `${job.testCampaign.passed || 0} AI-evidence-supported · ${job.testCampaign.awaitingOracle || 0} awaiting evidence review · ${job.testCampaign.invalid || 0} invalid tests · ${job.testCampaign.failed || 0} AI-supported concerns · ${job.testCampaign.rejected || 0} rejected before Forge · ${job.testCampaign.timedOut || 0} timed out` });
    for (const plan of job.ai?.result?.testPlans || []) {
      if (["executed-ai-supported", "not-run"].includes(plan.executionStatus)) continue;
      facts.push({ label: "Property outcome", value: `${plan.title || plan.id}: ${plan.executionStatus}${plan.executionMessage ? ` — ${plan.executionMessage}` : ""}` });
    }
  }
  if (event.stage === "evidence-review" && job.verificationSummary) facts.push({ label: "Question review", value: `${job.verificationSummary.aiSupported} AI-supported · ${job.verificationSummary.concerns} concerns · ${job.verificationSummary.accepted} accepted behaviors · ${job.verificationSummary.decisions} decisions · ${job.verificationSummary.notVerified} ${job.auditDepth === "full" ? "coverage gaps" : "recommended checks"}` });
  if (event.stage === "report" && event.status === "summary") {
    facts.push({ label: "Assessment", value: job.operationLoop?.status || job.status });
  }
  if (event.details) facts.push({ label: "Recorded evidence", value: JSON.stringify(event.details) });
  return facts;
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function syncCopilotControls() {
  if (!elements["copilot-send"]) return;
  const controls = deriveCopilotControls({ job: activeJob, authConnected: auth.connected, jobUnavailable: activeJobUnavailable });
  elements["copilot-input"].disabled = controls.inputDisabled;
  elements["copilot-send"].disabled = !controls.ready;
  elements["copilot-send"].title = controls.title;
}

function submitCopilotOnEnter(event) {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  if (!elements["copilot-send"].disabled) askCopilot();
}

async function askCopilot(questionOverride = "") {
  if (!activeJob || !terminalStates.has(activeJob.status)) return;
  const question = questionOverride.trim() || elements["copilot-input"].value.trim();
  if (!question) {
    elements["copilot-error"].textContent = "Enter a question for Audit Copilot.";
    return;
  }
  const originalQuestion = elements["copilot-input"].value;
  const generation = requests.begin();
  const jobId = activeJob.id;
  elements["copilot-error"].textContent = "";
  activeJob.copilot ||= { status: "idle", error: null, messages: [] };
  activeJob.copilot.status = "running";
  activeJob.copilot.messages.push({ id: `pending-${Date.now()}`, at: new Date().toISOString(), role: "user", kind: "question", text: question });
  if (!questionOverride) elements["copilot-input"].value = "";
  renderCopilot(activeJob);
  try {
    const job = await api(`/api/audits/${jobId}/copilot`, {
      method: "POST",
      body: JSON.stringify({ question }),
    });
    if (!requests.current(generation)) return;
    activeJob = job;
    renderJob(job);
  } catch (error) {
    if (!requests.current(generation)) return;
    activeJob.copilot.status = "failed";
    if (!questionOverride) elements["copilot-input"].value = originalQuestion;
    activeJobUnavailable = error.message === "Audit job not found";
    elements["copilot-error"].textContent = activeJobUnavailable
      ? "The local service restarted and this audit is no longer active. Run a new audit before asking follow-up questions."
      : error.message;
    renderCopilot(activeJob);
  }
}

function touchpointStateLabel(state) {
  return ({ "awaiting-ai": "reviewing", reviewed: "reviewed", surfaced: "surfaced", contextualized: "context", "not-substantiated": "not substantiated", "manual-review-required": "manual review", "not-adjudicated": "not adjudicated" })[state] || state;
}

function renderExports(job) {
  elements["export-actions"].replaceChildren();
  if (["awaiting-testing", "awaiting-input"].includes(job.reportState?.status)) {
    elements["export-actions"].append(node("span", "export-note", "Choose a check, provide missing information, or finish testing at the bottom of Audit Copilot."));
    return;
  }
  if (job.reportState?.status === "publishing") {
    elements["export-actions"].append(node("span", "export-note", "Generating the final findings summary…"));
    return;
  }
  if (job.reportState?.status === "failed") {
    elements["export-actions"].append(node("span", "export-note", job.reportState.reason || "Final findings could not be generated."));
    if (job.reportState.retryable === true && job.sourceIntegrity?.status === "verified") {
      const retry = node("button", "button secondary", "Retry findings publication");
      retry.type = "button";
      retry.addEventListener("click", finishTesting);
      elements["export-actions"].append(retry);
    }
    return;
  }
  if (job.reportState?.status !== "ready" || !job.reportMarkdown) return;
  for (const [format, label] of [["md", "Download findings summary"], ["json", "Download technical evidence"]]) {
    const button = node("button", "button secondary", label);
    button.type = "button";
    button.addEventListener("click", () => downloadReport(job, format, button));
    elements["export-actions"].append(button);
  }
}

async function downloadReport(job, format, button) {
  button.disabled = true;
  try {
    const blob = await api(`/api/audits/${job.id}/report?format=${format}`, { responseType: "blob" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = format === "json" ? `attest-evidence-${job.id}.json` : `attest-findings-${job.id}.md`;
    link.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    elements["form-error"].textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function finishTesting() {
  if (!activeJob || !["awaiting-testing", "awaiting-input", "failed"].includes(activeJob.reportState?.status)) return;
  for (const button of document.querySelectorAll("button[data-finish-testing], #export-actions button")) button.disabled = true;
  elements["form-error"].textContent = "";
  const generation = requests.begin();
  const jobId = activeJob.id;
  activeJob = { ...activeJob, reportState: { ...activeJob.reportState, status: "publishing" } };
  renderJob(activeJob);
  try {
    const job = await api(`/api/audits/${jobId}/finalize`, { method: "POST" });
    if (!requests.current(generation)) return;
    activeJob = job;
    renderJob(job);
  } catch (error) {
    if (!requests.current(generation)) return;
    elements["form-error"].textContent = error.message;
    try {
      const job = await api(`/api/audits/${jobId}`);
      if (requests.current(generation)) { activeJob = job; renderJob(job); }
    } catch {}
  } finally {
    if (activeJob) renderExports(activeJob);
  }
}

function syncAuditInputLock(job) {
  const controls = deriveAuditInputControls(job);
  elements["new-audit"].classList.toggle("hidden", !job || controls.loadDisabled);
  elements["new-audit"].disabled = controls.loadDisabled;
  elements["source-editor"].readOnly = controls.sourceReadOnly;
  elements["load-file"].disabled = controls.loadDisabled;
  elements["file-input"].disabled = controls.loadDisabled;
  if (controls.sourceReadOnly) elements["source-help"].textContent = `Auditing immutable source ${job.sourceHash.slice(0, 12)}… Load another .sol file to start a separate audit when no test is running.`;
  elements["run-audit"].disabled = controls.runDisabled;
  for (const id of submittedControlIds) elements[id].disabled = controls.submittedDisabled || (selectedAuditDepth() === "review" && ["allow-local-execution", "allow-anvil", "allow-forks", "test-campaign-mode", "generated-test-budget", "fuzz-runs", "invariant-runs", "invariant-depth", "campaign-timeout"].includes(id));
}

function updateSourceSize() {
  elements["source-size"].textContent = `${new Blob([elements["source-editor"].value]).size.toLocaleString()} bytes`;
}

function syncSourceEditor() {
  updateSourceSize();
  const source = elements["source-editor"].value;
  const size = new Blob([source]).size;
  if (!source) {
    elements["source-editor-shell"].classList.remove("highlight-active");
    elements["source-highlight"].firstElementChild.textContent = "";
    return;
  }
  if (size > 300_000) {
    elements["source-editor-shell"].classList.remove("highlight-active");
    elements["source-highlight"].firstElementChild.textContent = "";
    return;
  }
  elements["source-highlight"].firstElementChild.innerHTML = highlightSolidity(source) + (source.endsWith("\n") ? " " : "");
  elements["source-editor-shell"].classList.add("highlight-active");
  syncEditorScroll();
}

function syncEditorScroll() {
  elements["source-highlight"].scrollTop = elements["source-editor"].scrollTop;
  elements["source-highlight"].scrollLeft = elements["source-editor"].scrollLeft;
}

function syncTestOption() {
  const campaignEnabled = selectedAuditDepth() !== "review";
  const submittedDisabled = activeJob ? deriveAuditInputControls(activeJob).submittedDisabled : false;
  if (!submittedDisabled) {
    const depth = selectedAuditDepth();
    elements["allow-local-execution"].checked = depth !== "review";
    elements["allow-anvil"].checked = depth !== "review";
    elements["allow-forks"].checked = depth !== "review";
    elements["test-campaign-mode"].value = depth === "full" ? "deep" : "recommended";
  }
  for (const id of ["allow-local-execution", "allow-anvil", "allow-forks"]) elements[id].disabled = submittedDisabled || !campaignEnabled;
  elements["test-campaign-mode"].disabled = submittedDisabled || !campaignEnabled;
  const custom = campaignEnabled && elements["test-campaign-mode"].value === "custom";
  elements["custom-campaign-fields"].classList.toggle("hidden", !custom);
  for (const field of elements["custom-campaign-fields"].querySelectorAll("input")) field.disabled = submittedDisabled || !custom;
}

function selectedAuditDepth() {
  return document.querySelector('input[name="audit-depth"]:checked')?.value || "targeted";
}

function node(tag, className = "", text = null) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== null) element.textContent = String(text);
  return element;
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
