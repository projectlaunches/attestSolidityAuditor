import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAderynReport } from "../src/server/adapters/aderyn.js";

function report(overrides = {}) {
  return JSON.stringify({
    issue_count: { high: 1, low: 0 },
    detectors_used: ["reentrancy-state-change"],
    high_issues: {
      issues: [{
        title: "Reentrancy: State change after external call",
        description: "State changes after an external call.",
        detector_name: "reentrancy-state-change",
        instances: [{ contract_path: "src/Target.sol", line_no: 17, hint: "balance is cleared late" }],
      }],
    },
    low_issues: { issues: [] },
    ...overrides,
  });
}

test("normalizes Aderyn findings with independent provenance", () => {
  const [finding] = normalizeAderynReport(report(), "aderyn 0.6.8");
  assert.equal(finding.severity, "high");
  assert.equal(finding.category, "reentrancy-after-external-call");
  assert.equal(finding.location.lineStart, 17);
  assert.equal(finding.evidence[0].tool, "aderyn");
  assert.equal(finding.evidence[0].detectorId, "reentrancy-state-change");
});

test("accepts a well-formed Aderyn report with no findings", () => {
  assert.deepEqual(normalizeAderynReport(JSON.stringify({ issue_count: {}, detectors_used: [] })), []);
});

test("rejects malformed or incomplete Aderyn output", () => {
  assert.throws(() => normalizeAderynReport("not json"), /valid JSON/);
  assert.throws(() => normalizeAderynReport("{}"), /required report fields/);
  assert.throws(() => normalizeAderynReport(report({ high_issues: { issues: [{ detector_name: "x" }] } })), /instances array/);
  assert.throws(() => normalizeAderynReport(JSON.stringify({ issue_count: { high: 1 }, detectors_used: ["x"] })), /high_issues is missing/);
  assert.throws(() => normalizeAderynReport(report({ issue_count: { high: 2 }, high_issues: { issues: [] } })), /count does not match/);
  assert.throws(() => normalizeAderynReport(report({ high_issues: { issues: [{ detector_name: "x", instances: [] }] } })), /nonempty instances array/);
});
