import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSolhintOutput } from "../src/server/adapters/solhint.js";

test("normalizes Solhint output into a non-security quality lane", () => {
  const raw = JSON.stringify([
    { line: 2, column: 1, severity: "Error", message: "Pin compiler", ruleId: "compiler-version", filePath: "src/Target.sol" },
    { conclusion: "1 problem" },
  ]);
  const [diagnostic] = normalizeSolhintOutput(raw, "4.0.1");
  assert.equal(diagnostic.severity, "error");
  assert.equal(diagnostic.evidence.kind, "lint");
  assert.equal(diagnostic.evidence.tool, "solhint");
  assert.equal(diagnostic.location.lineStart, 2);
  assert.equal(diagnostic.verification, undefined);
});

test("rejects malformed Solhint output", () => {
  assert.throws(() => normalizeSolhintOutput("not json"), /valid JSON/);
  assert.throws(() => normalizeSolhintOutput("{}"), /must be an array/);
});
