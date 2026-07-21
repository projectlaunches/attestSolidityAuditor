import test from "node:test";
import assert from "node:assert/strict";
import { renderFindingsMarkdown } from "../src/server/findings-report.js";

const source = "contract Token {\n  uint256 public totalSupply;\n}";

function job(overrides = {}) {
  return {
    fileName: "Token.sol",
    auditDepth: "targeted",
    source,
    sourceHash: "abc",
    sourceIntegrity: { status: "verified" },
    evidenceRevision: 2,
    operationLoop: { stopReason: null },
    auditSynthesis: { status: "completed", answer: "No blocker found in the targeted scope. The submitted token has no privileged mint path." },
    sourceConclusions: [{
      id: "SC-1",
      statement: "The contract exposes a totalSupply getter.",
      classification: "neutral-fact",
      evidence: [{ lineStart: 2, lineEnd: 2, quote: "uint256 public totalSupply;", why: "Declared public state." }],
    }],
    sourceFindings: [],
    findings: [],
    toolRuns: [{ tool: "slither", status: "completed", version: "test" }],
    ai: { result: { trustAssumptions: ["No persistent administrator is present."], invariants: ["totalSupply changes only through source-defined paths."] } },
    ...overrides,
  };
}

test("final Markdown leads with the AI auditor's own opinion", () => {
  const markdown = renderFindingsMarkdown(job());
  assert.match(markdown, /## AI auditor opinion/);
  assert.match(markdown, /No blocker found in the targeted scope/);
  assert.match(markdown, /## Source-supported audit model/);
  assert.match(markdown, /lines 2-2/);
  assert.match(markdown, /## Tool evidence/);
  assert.match(markdown, /slither.*completed/);
  assert.doesNotMatch(markdown, /Practical usability verdict|Assessment incomplete|supported properties|Points to address/);
});

test("final Markdown does not manufacture a verdict when the AI returned none", () => {
  const markdown = renderFindingsMarkdown(job({ auditSynthesis: { status: "failed", answer: null }, operationLoop: { stopReason: null } }));
  assert.match(markdown, /AI auditor did not return a final opinion/);
  assert.doesNotMatch(markdown, /No blocker found|Review required|Do not use/);
});

test("final Markdown excludes non-evidentiary compiler bootstrap misses", () => {
  const markdown = renderFindingsMarkdown(job({
    toolRuns: [{ tool: "forge-bootstrap", status: "skipped", evidenceEligible: false, error: "Local Solidity compiler unavailable" }],
  }));
  assert.doesNotMatch(markdown, /forge-bootstrap|compiler unavailable/i);
  assert.match(markdown, /No executable tool was used/);
});
