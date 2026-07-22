import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { normalizeSolhintOutput } from "../src/server/adapters/solhint.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

test("normalizes Solhint output into a non-security quality lane", () => {
  const raw = JSON.stringify([
    { line: 2, column: 1, severity: "Error", message: "Pin compiler", ruleId: "compiler-version", filePath: "src/Target.sol" },
    { conclusion: "1 problem" },
  ]);
  const [diagnostic] = normalizeSolhintOutput(raw, "6.2.3");
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

test("official pinned Solhint emits adapter-compatible JSON without update checks", async () => {
  const testRoot = path.join(projectRoot, "work", "test-tmp");
  mkdirSync(testRoot, { recursive: true });
  const jobDir = mkdtempSync(path.join(testRoot, "attest-solhint-"));
  try {
    writeFileSync(path.join(jobDir, ".solhint.json"), `${JSON.stringify({ extends: "solhint:recommended" }, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(path.join(jobDir, "Target.sol"), "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\ncontract Target { uint256 public value; }\n", { mode: 0o400 });
    const entry = path.join(projectRoot, "node_modules", "solhint", "solhint.js");
    let result;
    try {
      const output = await execFileAsync(process.execPath, [entry, "--disc", "--save", "--config", ".solhint.json", "--formatter", "json", "Target.sol"], {
        cwd: jobDir,
        encoding: "utf8",
        timeout: 30_000,
        shell: false,
      });
      result = { status: 0, ...output };
    } catch (error) {
      result = { status: error.code, stdout: error.stdout || "", stderr: error.stderr || "", error };
    }
    assert.ok(result.status === 0 || result.status === 1, result.error?.message || result.stderr || `unexpected Solhint exit status ${result.status}`);
    if (!result.stdout.trim()) {
      const reportNames = readdirSync(jobDir).filter((name) => /^\d{14}_solhintReport\.txt$/.test(name));
      assert.equal(reportNames.length, 1);
      result.stdout = readFileSync(path.join(jobDir, reportNames[0]), "utf8");
    }
    assert.ok(result.stdout.trim(), result.error?.message || result.stderr || "Solhint produced no JSON output");
    const parsed = JSON.parse(result.stdout);
    assert.ok(Array.isArray(parsed));
    assert.doesNotThrow(() => normalizeSolhintOutput(result.stdout, "6.2.3"));
  } finally {
    rmSync(jobDir, { recursive: true, force: true });
  }
});
