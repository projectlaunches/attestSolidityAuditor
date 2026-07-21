import test from "node:test";
import assert from "node:assert/strict";
import { capabilityFor, capabilityStatus, coreCoverage } from "../src/shared/setup.js";

const data = {
  runtime: { node: "v24.0.0", wsl: true },
  analyzers: [
    { id: "forge", available: true, version: "1.7.1" },
    { id: "anvil", available: true, version: "1.7.1" },
    { id: "slither", available: false, version: null },
    { id: "aderyn", available: true, version: "0.6.8" },
    { id: "solhint", available: true, version: "4.0.1" },
  ],
  codex: { available: true, version: "0.144.5" },
};

test("setup status maps runtime, analyzers, and Codex without inventing availability", () => {
  assert.equal(capabilityStatus(data, "node").available, true);
  assert.equal(capabilityStatus(data, "wsl").text, "Running inside WSL");
  assert.equal(capabilityStatus(data, "slither").available, false);
  assert.equal(capabilityFor(data, "codex").version, "0.144.5");
  assert.equal(capabilityStatus(data, "unknown").available, false);
});

test("core coverage counts only executable audit tools", () => {
  assert.deepEqual(coreCoverage(data), { installed: 4, total: 5 });
});

test("Node status enforces the documented Node 22 minimum", () => {
  assert.equal(capabilityStatus({ runtime: { node: "v21.7.3" } }, "node").available, false);
  assert.match(capabilityStatus({ runtime: { node: "v21.7.3" } }, "node").text, /Node 22\+/);
  assert.equal(capabilityStatus({ runtime: { node: "v22.0.0" } }, "node").available, true);
});
