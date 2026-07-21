import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CodexAppServer, auditThreadConfig, isLocalLoginServerFailure, normalizeCodexFailure, protocolEventName } from "../src/server/ai/codex-app-server.js";

test("Codex performs review before optional local test design in a read-only sandbox", async () => {
  const source = await readFile(new URL("../src/server/ai/codex-app-server.js", import.meta.url), "utf8");
  assert.match(source, /config: auditThreadConfig\(jobDir\)/);
  assert.doesNotMatch(source, /sandbox: "readOnly"/);
  assert.match(source, /whole-contract model before detector triage/);
  assert.match(source, /for \(const batch of chunk\(groups, 12\)\)/);
  assert.match(source, /for \(const batch of chunk\(deepGroups, 8\)\)/);
  assert.match(source, /completed checkpoints were preserved/);
  assert.match(source, /FINAL SOURCE-FOCUSED ADJUDICATION/);
  assert.match(source, /NUMBERED SOLIDITY SOURCE/);
  assert.match(source, /without the displayed N: line-number prefix/);
  assert.match(source, /terminal manual-review-required state/);
  assert.match(source, /if \(retry >= 1\) await markManualReview/);
  assert.match(source, /effort: "high"/);
  assert.match(source, /300_000, "medium"/);
  assert.match(source, /if \(!generateTests\) return review/);
  assert.match(source, /await onReviewComplete\(review\)/);
  assert.ok(source.indexOf("whole-contract model before detector triage") < source.indexOf("Using the completed Secure-SDLC review"));
  assert.match(source, /turn\/interrupt/);
  assert.match(source, /serviceName: "soltesting-copilot"/);
  assert.match(source, /typed target calls from helper actor contracts and Solidity try\/catch/);
  assert.match(source, /Do not use address\(target\)\.call/);
  assert.match(source, /private chain-of-thought/);
  assert.match(source, /do not execute anything in this turn/);
  assert.match(source, /COPILOT_SCHEMA, 300_000, "medium"/);
  assert.doesNotMatch(source, /serviceName: "soltesting-synthesis"/);
  assert.match(source, /deploymentPlan: structuredClone\(DEPLOYMENT_PLAN_SCHEMA\)/);
  assert.match(source, /Compiled deployment artifact inventory/);
  assert.match(source, /anvil-account values 0 through 3/);
  assert.match(source, /disposable local setup, not production approval/);
  assert.match(source, /never return needs-input merely because msg.sender receives ownership/);
  assert.match(source, /decisionReason=implicit-deployer-identity/);
  assert.match(source, /serviceName: "soltesting-profile"/);
  assert.match(source, /before seeing analyzer findings/);
  assert.match(source, /serviceName: "soltesting-evidence-review"/);
  assert.match(source, /A Forge pass is not automatically a verified property/);
  assert.match(source, /a Forge assertion failure is not automatically a contract defect/);
  assert.match(source, /Do not repair, rewrite, or propose patches/);
  assert.match(source, /"verified-pass", "confirmed-failure", "invalid-test", "not-verified"/);
  assert.match(source, /Each question must state why it matters, what evidence would answer it, and the requiredEvidenceKinds/);
  assert.match(source, /this\.activeTurns = new Map\(\)/);
  assert.match(source, /this\.cancelledOperations = new Set\(\)/);
  assert.match(source, /"CODEX_SQLITE_HOME"/);
  assert.match(source, /stateRoot = null/);
  assert.match(source, /log_dir=\$\{JSON\.stringify/);
  assert.match(source, /import path from "node:path"/);
  assert.match(source, /async cancelActiveReview\(operationKey\)/);
  assert.doesNotMatch(source, /this\.activeTurn\s*=/);
});

test("untrusted audit threads have no model tools and cannot read outside the audit job", () => {
  const jobDir = "/tmp/attest-job-1";
  const config = auditThreadConfig(jobDir);
  assert.equal(config.web_search, "disabled");
  assert.equal(config.tools_view_image, false);
  assert.equal(config.features.shell_tool, false);
  assert.equal(config.features.unified_exec, false);
  assert.equal(config.features.apps, false);
  assert.equal(config.features.hooks, false);
  assert.equal(config.features.multi_agent, false);
  assert.equal(config.permissions["attest-audit"].filesystem[":root"], "deny");
  assert.equal(config.permissions["attest-audit"].filesystem[":minimal"], "read");
  assert.equal(config.permissions["attest-audit"].filesystem[jobDir], "read");
  assert.equal(config.permissions["attest-audit"].network.enabled, false);
});

test("Audit Copilot route validates questions and keeps discussion out of immutable JSON exports", async () => {
  const index = await readFile(new URL("../src/server/index.js", import.meta.url), "utf8");
  const audit = await readFile(new URL("../src/server/audit.js", import.meta.url), "utf8");
  assert.match(index, /const copilotMatch/);
  assert.match(index, /askAuditCopilot\(copilotMatch\[1\], body\)/);
  assert.match(index, /const \{ copilot: _discussion, \.\.\.immutableAudit \} = revision\?\.snapshot \|\| job/);
  assert.match(index, /queueAuditFollowup/);
  assert.match(index, /getReportRevision/);
  assert.match(audit, /normalizeCopilotQuestion\(question\)/);
  assert.match(audit, /Audit Copilot questions become available after the audit run finishes/);
  assert.match(audit, /job\.codex\.discuss/);
  assert.match(audit, /planAuditOperations/);
  assert.match(audit, /runAiControlledAudit/);
  assert.doesNotMatch(audit, /designTargetedPass/);
});

test("protocol error notifications cannot trigger Node's fatal EventEmitter error event", () => {
  assert.equal(protocolEventName("error"), "protocol/error");
  assert.equal(protocolEventName("turn/completed"), "turn/completed");
});

test("Codex connectivity failures cannot masquerade as an audit result", () => {
  const expected = "AI review could not start because the local Attest backend could not reach OpenAI. No audit conclusion was produced. Check this computer's internet, proxy, or firewall access to chatgpt.com, then retry the audit.";
  assert.equal(normalizeCodexFailure("Reconnecting... 2/5"), expected);
  assert.equal(normalizeCodexFailure("stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/models)"), expected);
  assert.equal(normalizeCodexFailure("Output did not match the required schema"), "Output did not match the required schema");
});

test("ChatGPT login falls back to device code when the local callback server cannot bind", async () => {
  const client = new CodexAppServer({ binary: "codex", codexHome: "/tmp/unused-test-codex-home" });
  client.start = async () => {};
  const requests = [];
  client.request = async (method, params) => {
    requests.push({ method, params });
    if (requests.length === 1) throw new Error("failed to start login server: Operation not permitted (os error 1)");
    return { type: "chatgptDeviceCode", loginId: "login-1", verificationUrl: "https://auth.openai.com/device", userCode: "ABCD-EFGH" };
  };
  const result = await client.login();
  assert.equal(result.type, "chatgptDeviceCode");
  assert.deepEqual(requests.map((item) => item.params.type), ["chatgpt", "chatgptDeviceCode"]);
  assert.equal(isLocalLoginServerFailure(new Error("unrelated network error")), false);
});
