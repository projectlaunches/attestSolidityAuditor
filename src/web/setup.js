import { capabilityStatus, coreCoverage } from "/setup-model.js";
import { createApiClient, resolveLocalSessionToken } from "/session-client.js?v=20260720-session-recovery";

const api = createApiClient(resolveLocalSessionToken());
const message = document.getElementById("setup-message");
const refreshButton = document.getElementById("refresh-setup");

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", () => copyCommand(button));
}
refreshButton.addEventListener("click", refresh);

await loadCapabilities();

async function loadCapabilities(refresh = false) {
  message.textContent = "Checking this workstation…";
  try {
    const data = await api(refresh ? "/api/capabilities/refresh" : "/api/capabilities", refresh ? { method: "POST" } : {});
    for (const card of document.querySelectorAll("[data-tool]")) {
      const status = capabilityStatus(data, card.dataset.tool);
      const badge = card.querySelector("[data-status]");
      badge.textContent = status.text;
      badge.className = `setup-status ${status.available ? "available" : "missing"}`;
    }
    const coverage = coreCoverage(data);
    message.textContent = `${coverage.installed} of ${coverage.total} core workstation tools are detected. Each card explains whether the current MVP executes it. Optional engines are installed only when their property checks are useful.`;
  } catch (error) {
    message.textContent = `Could not refresh tool detection: ${error.message}`;
  }
}

async function refresh() {
  refreshButton.disabled = true;
  try {
    await loadCapabilities(true);
  } finally {
    refreshButton.disabled = false;
  }
}

async function copyCommand(button) {
  const code = document.getElementById(button.dataset.copy);
  if (!code) return;
  const text = code.textContent.trim();
  const original = button.textContent;
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else if (!fallbackCopy(text)) throw new Error("Clipboard access is unavailable");
    button.textContent = "Copied";
    message.textContent = `Copied ${button.dataset.copyLabel || "command"}. Review network installer commands before running them.`;
  } catch (error) {
    button.textContent = "Copy failed";
    message.textContent = `${error.message}. Select the command manually.`;
  }
  setTimeout(() => { button.textContent = original; }, 1800);
}

function fallbackCopy(text) {
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.className = "clipboard-fallback";
  document.body.append(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  return copied;
}
