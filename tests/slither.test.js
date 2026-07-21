import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSlitherOutput, __test } from "../src/server/adapters/slither.js";

test("normalizes Slither detector evidence and locations", () => {
  const raw = JSON.stringify({
    success: true,
    results: {
      detectors: [{
        check: "reentrancy-eth",
        impact: "High",
        confidence: "Medium",
        description: "Target.withdraw sends ETH before updating state.",
        elements: [{
          type: "function",
          name: "withdraw",
          source_mapping: { filename_relative: "src/Target.sol", lines: [12, 13, 14, 16] },
        }],
      }],
    },
  });

  const [finding] = normalizeSlitherOutput(`noise\n${raw}`, "0.11.5");
  assert.equal(finding.id, "slither:reentrancy-eth:src/Target.sol:12");
  assert.equal(finding.severity, "high");
  assert.equal(finding.verification, "static-only");
  assert.deepEqual(finding.location, {
    file: "src/Target.sol",
    lineStart: 12,
    lineEnd: 16,
    contract: null,
    function: "withdraw",
  });
  assert.equal(finding.evidence[0].toolVersion, "0.11.5");
});

test("maps informational and unknown impacts honestly", () => {
  assert.equal(__test.severity("Informational"), "info");
  assert.equal(__test.severity("Optimization"), "info");
  assert.equal(__test.severity("Unmapped"), "unknown");
});

test("rejects output that has no JSON object", () => {
  assert.throws(() => normalizeSlitherOutput("plain failure", null), /did not return JSON/);
});

test("rejects Slither JSON that explicitly reports failure", () => {
  assert.throws(() => normalizeSlitherOutput(JSON.stringify({ success: false, error: "compile failed", results: {} }), null), /compile failed/);
});

test("rejects Slither JSON without an explicit boolean success", () => {
  assert.throws(() => normalizeSlitherOutput(JSON.stringify({ results: { detectors: [] } }), null), /success:true/);
  assert.throws(() => normalizeSlitherOutput(JSON.stringify({ success: "true", results: { detectors: [] } }), null), /success:true/);
});
