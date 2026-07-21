import test from "node:test";
import assert from "node:assert/strict";
import { deriveAuditInputControls } from "../src/web/audit-input-controls.js";

test("a terminal audit awaiting more testing keeps its source sealed but permits loading a new contract", () => {
  assert.deepEqual(deriveAuditInputControls({ status: "partial", reportState: { status: "awaiting-testing" }, followup: { status: "idle" } }), {
    sourceReadOnly: true,
    loadDisabled: false,
    runDisabled: true,
    submittedDisabled: true,
  });
});

test("active audit operations prevent replacing the visible source", () => {
  assert.equal(deriveAuditInputControls({ status: "running" }).loadDisabled, true);
  assert.equal(deriveAuditInputControls({ status: "partial", followup: { status: "running" } }).loadDisabled, true);
  assert.equal(deriveAuditInputControls({ status: "partial", reportState: { status: "publishing" } }).loadDisabled, true);
});

test("a finished audit or empty workspace allows a new source", () => {
  assert.deepEqual(deriveAuditInputControls(null), { sourceReadOnly: false, loadDisabled: false, runDisabled: false, submittedDisabled: false });
  assert.deepEqual(deriveAuditInputControls({ status: "completed", reportState: { status: "ready" } }), { sourceReadOnly: false, loadDisabled: false, runDisabled: false, submittedDisabled: false });
});

test("Copilot and submitted audit operations seal source and submitted configuration", () => {
  const controls = deriveAuditInputControls({ status: "completed", reportState: { status: "ready" }, copilot: { status: "running" } });
  assert.equal(controls.sourceReadOnly, true);
  assert.equal(controls.loadDisabled, true);
  assert.equal(controls.submittedDisabled, true);
});
