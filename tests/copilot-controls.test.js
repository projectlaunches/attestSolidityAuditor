import test from "node:test";
import assert from "node:assert/strict";
import { deriveCopilotControls } from "../src/web/copilot-controls.js";

test("Copilot submission needs no confirmation gate once the audit is finished and signed in", () => {
  const ready = deriveCopilotControls({ job: { status: "partial", copilot: { status: "idle" } }, authConnected: true });
  assert.deepEqual(ready, { ready: true, inputDisabled: false, title: "Send this question as a new AI turn" });
});

test("Copilot controls explain each real unavailable state", () => {
  const runningAudit = deriveCopilotControls({ job: { status: "running", copilot: { status: "idle" } }, authConnected: true });
  assert.equal(runningAudit.ready, false);
  assert.match(runningAudit.title, /audit finishes/);

  const signedOut = deriveCopilotControls({ job: { status: "completed", copilot: { status: "idle" } }, authConnected: false });
  assert.match(signedOut.title, /Sign in with ChatGPT/);

  const answering = deriveCopilotControls({ job: { status: "completed", copilot: { status: "running" } }, authConnected: true });
  assert.match(answering.title, /answering the previous question/);
  assert.equal(answering.inputDisabled, false, "the next message can be typed while the current answer is running");

  const targetedCheck = deriveCopilotControls({ job: { status: "partial", copilot: { status: "idle" }, followup: { status: "running" } }, authConnected: true });
  assert.equal(targetedCheck.ready, false);
  assert.equal(targetedCheck.inputDisabled, false, "the dialogue remains writable during additional testing");
  assert.match(targetedCheck.title, /targeted check/);

  const restarted = deriveCopilotControls({ job: { status: "completed", copilot: { status: "idle" } }, authConnected: true, jobUnavailable: true });
  assert.match(restarted.title, /service restart/);
});
