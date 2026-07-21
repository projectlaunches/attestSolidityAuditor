import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { __test } from "../src/server/audit.js";

test("isolated Forge jobs emit build-info before Anvil target selection", async () => {
  const source = await readFile(new URL("../src/server/audit.js", import.meta.url), "utf8");
  assert.match(source, /"build_info = true"/);
  assert.match(source, /"offline = false"/);
  assert.match(source, /foundry-download-fallback/);
});

test("Foundry commands share the user compiler cache while keeping project config isolated", () => {
  const jobDir = "/tmp/attest-job";
  const env = __test.foundryEnvironment(jobDir);
  assert.equal(env.FOUNDRY_OFFLINE, "true");
  assert.equal(env.XDG_CONFIG_HOME, path.join(jobDir, ".tool-home", ".config"));
  if (process.env.HOME && path.isAbsolute(process.env.HOME)) {
    assert.equal(env.HOME, process.env.HOME);
    assert.equal(env.XDG_CACHE_HOME, process.env.XDG_CACHE_HOME && path.isAbsolute(process.env.XDG_CACHE_HOME) ? process.env.XDG_CACHE_HOME : path.join(process.env.HOME, ".cache"));
  }
  const online = __test.foundryEnvironment(jobDir, { allowCompilerDownload: true });
  assert.equal(online.FOUNDRY_OFFLINE, "false");
  assert.deepEqual(__test.foundryBuildArgs(jobDir, { offline: true }), ["build", "--root", jobDir, "--offline"]);
  assert.deepEqual(__test.foundryBuildArgs(jobDir, { offline: false, extra: ["--force"] }), ["build", "--root", jobDir, "--force"]);
});

test("metadata-only compiler misses disable compile-dependent tools without becoming contract failures", () => {
  const job = {
    source: "// pragma solidity 0.4.24;\npragma solidity ^0.8.20;\ncontract T {}",
    compileSettings: { autoDetectSolc: true, offline: true },
    compilerAvailability: { status: "unknown" },
    executionPermissions: { localExecution: true, anvil: true, forks: true },
    runGeneratedTests: true,
    runAnvil: true,
    anvil: { requested: true, status: "queued" },
    limitations: [],
  };
  assert.equal(__test.declaredCompilerRequirement(job.source), "^0.8.20");
  assert.equal(__test.isCompilerUnavailable({ stderr: "Error: Found Solidity sources, but no compiler versions are available for it", stdout: "", error: "", exitCode: 1 }), true);
  assert.equal(__test.isCompilerUnavailable({ stderr: "Error: can't install missing solc 0.8.20 in offline mode", stdout: "", error: "", exitCode: 1 }), true);
  const reason = __test.compilerUnavailableReason(job);
  __test.disableCompileDependentExecution(job, reason);
  assert.match(reason, /Local Solidity compiler unavailable for pragma \^0\.8\.20/);
  assert.match(reason, /AI source review will continue/);
  assert.deepEqual(job.executionPermissions, { localExecution: false, anvil: false, forks: false });
  assert.equal(job.runGeneratedTests, false);
  assert.equal(job.anvil.status, "unavailable");
  assert.equal(job.compilerAvailability.status, "unavailable");
  assert.equal(job.compileSettings.compilerStatus, "unavailable");
  assert.equal(job.limitations[0], reason);
});

test("all audit depths require AI and review depth disables execution permissions", async () => {
  const source = await readFile(new URL("../src/server/audit.js", import.meta.url), "utf8");
  assert.match(source, /if \(!useAi\) throw new Error\("The AI auditor is required/);
  assert.match(source, /normalizeAuditDepth\(auditDepth\)/);
  assert.match(source, /if \(depth === "review"\) Object\.assign\(executionPermissions, \{ localExecution: false, anvil: false, forks: false \}\)/);
  assert.match(source, /runAnvilStage\(job, job\.aiDeploymentPlan, isCancelled, operation\.kind === "anvil-scenario" \? operation\.scenario : null, operation\)/);
});

test("final report worklog states whether runtime verification actually ran", () => {
  assert.match(__test.finalReportCompletionMessage({ auditDepth: "review", toolRuns: [] }), /no executable testing was selected/);
  assert.match(__test.finalReportCompletionMessage({ auditDepth: "targeted", toolRuns: [{ tool: "slither", status: "completed" }] }), /no runtime property test was executed/);
  assert.match(__test.finalReportCompletionMessage({ auditDepth: "targeted", toolRuns: [{ tool: "forge-generated:TP-1", status: "completed" }] }), /runtime verification completed/);
  assert.match(__test.finalReportCompletionMessage({ auditDepth: "full", toolRuns: [{ tool: "anvil-scenario", status: "completed" }] }), /runtime verification completed/);
});

test("submitted source fingerprint is enforced before and after evidence verification", async (context) => {
  const root = await mkdtemp(path.join("/tmp", "attest-source-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = "pragma solidity ^0.8.20;\ncontract Sentinel { uint256 public value; } // DO_NOT_MUTATE\n";
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "Target.sol"), source);
  const job = { jobDir: root, source, sourceHash: __test.sourceHash(source) };
  await __test.assertSubmittedSourceUnchanged(job);
  await writeFile(path.join(root, "src", "Target.sol"), source.replace("value", "changed"));
  await assert.rejects(__test.assertSubmittedSourceUnchanged(job), /submitted source changed/);
});

test("whole-contract source conclusions require exact citations and retain source assurance", () => {
  const source = "contract Token {\n  uint256 public totalSupply;\n  constructor(uint256 supply) { totalSupply = supply; }\n}";
  const conclusions = __test.normalizeSourceConclusions(source, [
    {
      id: "SC-SUPPLY", statement: "Construction assigns the supplied amount to totalSupply.", category: "asset-flow", classification: "neutral-fact", severity: "info", confidence: "high",
      rationale: "The constructor performs the only shown supply assignment.", relatedQuestionIds: ["Q-RUNTIME", "Q-UNKNOWN"],
      evidence: [{ lineStart: 3, lineEnd: 3, quote: "totalSupply = supply", why: "Direct constructor state assignment" }],
    },
    {
      id: "SC-FAKE", statement: "Anyone can mint.", category: "authorization", classification: "vulnerability", severity: "high", confidence: "high", rationale: "fabricated", relatedQuestionIds: [],
      evidence: [{ lineStart: 2, lineEnd: 2, quote: "function mint", why: "not present" }],
    },
  ], new Set(["Q-RUNTIME"]));
  assert.equal(conclusions.length, 1);
  assert.equal(conclusions[0].assurance, "ai-source-supported");
  assert.deepEqual(conclusions[0].relatedQuestionIds, ["Q-RUNTIME"]);
  assert.equal(conclusions[0].evidence[0].sourceValidated, true);
});

test("source findings require exact citations and retain actionable security fields", () => {
  const source = "contract Vault {\n  function withdraw() external {}\n}";
  const findings = __test.normalizeSourceFindings(source, [{
    id: "SF-1", title: "Unrestricted withdrawal", summary: "Any caller can invoke withdrawal.", category: "authorization", classification: "vulnerability", severity: "high", confidence: "high",
    rationale: "No access modifier is present.", impact: "Funds can be redirected.", trigger: "An untrusted caller invokes withdraw.", action: "Restrict the caller.", relatedQuestionIds: ["Q-1", "Q-UNKNOWN"],
    evidence: [{ lineStart: 2, lineEnd: 2, quote: "function withdraw() external", why: "External entry point." }],
  }, {
    id: "SF-FAKE", title: "Fabricated", summary: "Not present.", category: "authorization", classification: "vulnerability", severity: "high", confidence: "high", rationale: "bad", impact: "bad", trigger: "bad", action: "bad", relatedQuestionIds: [],
    evidence: [{ lineStart: 2, lineEnd: 2, quote: "onlyOwner", why: "not present" }],
  }], new Set(["Q-1"]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].sourceValidated, true);
  assert.equal(findings[0].action, "Restrict the caller.");
  assert.deepEqual(findings[0].relatedQuestionIds, ["Q-1"]);
});

test("targeted material questions block the opinion while optional assurance does not", () => {
  const normalized = __test.normalizeVerificationQuestions([
    { id: "Q-REQUIRED", question: "Can an untrusted caller drain funds?", rationale: "Funds safety", priority: "critical", expectedEvidence: "Foundry proof", requiredEvidenceKinds: ["source", "foundry"] },
    { id: "Q-OPTIONAL", question: "Does the exact event formatting match?", rationale: "Extra assurance", priority: "low", expectedEvidence: "Receipt", materiality: "optional-assurance", requiredEvidenceKinds: ["source", "anvil-observation"] },
  ]);
  const job = { auditDepth: "targeted", verificationQuestions: normalized, evidenceReview: { questionResults: [] } };
  assert.deepEqual(__test.requiredUnresolvedQuestionIds(job), ["Q-REQUIRED"]);
  assert.deepEqual(normalized[0].sufficientEvidenceRoutes, [["source", "foundry"]]);
});

test("a source-proven constructor allocation remains a conclusion instead of becoming an intent question", () => {
  const source = [
    "contract SimpleToken {",
    "  uint256 public totalSupply;",
    "  mapping(address => uint256) public balanceOf;",
    "  constructor() { totalSupply = 1_000_000 ether; balanceOf[msg.sender] = totalSupply; }",
    "}",
  ].join("\n");
  const questions = __test.normalizeVerificationQuestions([{
    id: "VQ-001",
    question: "Is assigning the entire initial supply to the deployment caller intended production allocation?",
    rationale: "The developer should confirm the allocation policy.",
    expectedEvidence: "Exact source trace plus developer confirmation",
    materiality: "optional-assurance",
    requiredEvidenceKinds: ["source", "developer-context"],
    sufficientEvidenceRoutes: [["source", "developer-context"]],
  }]);
  const sourceConclusions = __test.normalizeSourceConclusions(source, [{
    id: "SC-001",
    statement: "The constructor creates the fixed supply and assigns the entire amount to the deployment caller.",
    category: "asset-flow",
    classification: "neutral-fact",
    severity: "info",
    confidence: "high",
    rationale: "The constructor writes totalSupply and balanceOf[msg.sender] directly.",
    evidence: [{
      lineStart: 4,
      lineEnd: 4,
      quote: "constructor() { totalSupply = 1_000_000 ether; balanceOf[msg.sender] = totalSupply; }",
      why: "This is the complete constructor allocation flow.",
    }],
    relatedQuestionIds: ["VQ-001"],
  }], new Set(["VQ-001"]));
  const reconciled = __test.reconcileVerificationArtifacts({ questions, sourceConclusions, sourceFindings: [] });
  assert.deepEqual(reconciled.questions, []);
  assert.deepEqual(reconciled.sourceConclusions[0].relatedQuestionIds, []);
  assert.match(reconciled.sourceConclusions[0].statement, /assigns the entire amount to the deployment caller/);
});

test("full coverage applicability skips meaningless forks for a self-contained contract", () => {
  const applicability = __test.assessCoverageApplicability({
    source: "pragma solidity 0.8.20; interface IERC20 { function balanceOf(address) external view returns (uint256); } contract Token { function transfer(address, uint256) external {} }",
    aiContractProfile: { externalDependencies: [] },
  });
  assert.equal(applicability.fork.applicable, false);
  assert.equal(applicability["compiler-matrix"].applicable, false);
  assert.equal(applicability.foundry.applicable, true);

  const integrated = __test.assessCoverageApplicability({
    source: "pragma solidity ^0.8.20; contract Vault { function quoteFromRouter() external view returns (uint256) { return 1; } }",
    aiContractProfile: { externalDependencies: ["configured DEX router"] },
  });
  assert.equal(integrated.fork.applicable, true);
});

function finding(overrides = {}) {
  return {
    id: "slither:reentrancy:src/Target.sol:10",
    title: "reentrancy",
    summary: "state update follows call",
    severity: "high",
    confidence: "high",
    verification: "static-only",
    category: "reentrancy",
    location: { file: "src/Target.sol", lineStart: 10, lineEnd: 14 },
    evidence: [{ kind: "static", tool: "slither", detectorId: "reentrancy" }],
    aiReview: null,
    testPlans: [],
    ...overrides,
  };
}

test("deduplicates nearby findings without losing tool evidence", () => {
  const first = finding();
  const second = finding({
    id: "aderyn:reentrancy:src/Target.sol:12",
    severity: "critical",
    confidence: "medium",
    location: { file: "src/Target.sol", lineStart: 10, lineEnd: 10 },
    evidence: [{ kind: "static", tool: "aderyn", detectorId: "reentrancy" }],
  });
  const result = __test.deduplicate([first, second]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].evidence.map((item) => item.tool), ["slither", "aderyn"]);
  assert.equal(result[0].severity, "critical");
  assert.equal(result[0].confidence, "high");
});

test("does not merge nearby same-category findings in distinct functions", () => {
  const first = finding({ location: { file: "src/Target.sol", lineStart: 10, lineEnd: 12, function: "withdraw" } });
  const second = finding({
    id: "aderyn:reentrancy:src/Target.sol:13",
    location: { file: "src/Target.sol", lineStart: 13, lineEnd: 15, function: "claim" },
    evidence: [{ kind: "static", tool: "aderyn", detectorId: "reentrancy" }],
  });
  assert.equal(__test.deduplicate([first, second]).length, 2);
});

test("does not assign metadata-free evidence when same-line candidates are ambiguous", () => {
  const first = finding({ id: "slither:a", location: { file: "src/Target.sol", lineStart: 3, lineEnd: 3, function: "withdrawA" } });
  const second = finding({ id: "slither:b", location: { file: "src/Target.sol", lineStart: 3, lineEnd: 3, function: "withdrawB" } });
  const unknown = finding({
    id: "aderyn:unknown",
    location: { file: "src/Target.sol", lineStart: 3, lineEnd: 3, function: null },
    evidence: [{ kind: "static", tool: "aderyn" }],
  });
  const result = __test.deduplicate([unknown, first, second]);
  __test.corroborate(result);
  assert.equal(result.length, 3);
  assert.equal(result.filter((item) => item.verification === "corroborated").length, 0);
});

test("corroboration requires independent deterministic tools", () => {
  const single = finding({ aiReview: { verdict: "likely", sourceValidated: true } });
  __test.corroborate([single]);
  assert.equal(single.verification, "ai-reviewed");

  const multiple = finding({
    evidence: [
      { kind: "static", tool: "slither" },
      { kind: "static", tool: "aderyn" },
    ],
  });
  __test.corroborate([multiple]);
  assert.equal(multiple.verification, "corroborated");

  const lintIsNotCorroboration = finding({
    evidence: [
      { kind: "static", tool: "slither" },
      { kind: "lint", tool: "solhint" },
    ],
  });
  __test.corroborate([lintIsNotCorroboration]);
  assert.equal(lintIsNotCorroboration.verification, "static-only");
});

test("dynamic reproduction outranks static corroboration", () => {
  const reproduced = finding({
    evidence: [
      { kind: "static", tool: "slither" },
      { kind: "dynamic-reproduction", tool: "forge", reproduced: true },
    ],
  });
  __test.corroborate([reproduced]);
  assert.equal(reproduced.verification, "confirmed-by-test");
});

test("AI result accepts only known finding ids and validates exact source quotes", () => {
  const known = finding();
  const job = {
    source: "pragma solidity ^0.8.20;\ncontract Vault {\n  function withdraw() external {}\n}",
    findings: [known],
  };
  const result = __test.validateAiResult(job, {
    reviewedFindings: [
      {
        findingId: known.id,
        evidence: [{ lineStart: 3, lineEnd: 3, quote: "function withdraw()", why: "target" }],
      },
      { findingId: "invented", evidence: [] },
    ],
    testPlans: [{ id: "t1", findingIds: [known.id, "invented"] }],
  });
  assert.equal(result.reviewedFindings.length, 1);
  assert.equal(result.reviewedFindings[0].evidence[0].sourceValidated, true);
  assert.deepEqual(result.testPlans[0].findingIds, [known.id]);
  assert.equal(result.testPlans[0].executionStatus, "not-run");
});

test("source fingerprint is deterministic", () => {
  assert.equal(__test.sourceHash("contract A {}"), __test.sourceHash("contract A {}"));
  assert.notEqual(__test.sourceHash("contract A {}"), __test.sourceHash("contract B {}"));
});

test("generated tests are rejected when they are vacuous or use cheatcodes", () => {
  const job = { source: "contract Vault { function withdraw() external {} }", findings: [finding({ location: { file: "src/Target.sol", lineStart: 10, lineEnd: 14, function: "withdraw" } })] };
  const base = { findingIds: [job.findings[0].id] };
  assert.equal(__test.validateGeneratedTest(job, { ...base, code: "contract T { function testBad() public { assert(true); } }" }).ok, false);
  assert.equal(__test.validateGeneratedTest(job, { ...base, code: "contract T { function testBad() public { vm.prank(address(1)); require(false); } }" }).ok, false);
  assert.equal(__test.validateGeneratedTest(job, { ...base, code: "contract T { function testBad() public { /* target.withdraw(); */ uint x=1; require(x==1); } }" }).ok, false);
  assert.equal(__test.validateGeneratedTest(job, { ...base, code: 'contract T { function testBad() public { string memory fake = ".withdraw("; uint x=1; require(x==1); } }' }).ok, false);
  assert.equal(__test.validateGeneratedTest({ source: job.source, findings: [] }, { findingIds: [], suitePlanIds: ["AUTH-01"], code: "contract T { function testNothing() public { require(1 == 1); } }" }).ok, false);
  assert.equal(__test.validateGeneratedTest({ source: job.source, findings: [] }, { findingIds: [], suitePlanIds: ["AUTH-01"], code: "contract T { function dead(Vault v) internal { v.withdraw(); } function testNothing() public { require(2 == 2); } }" }).ok, false);
});

test("generated tests may use only the app-owned adversarial wrappers", () => {
  const job = {
    source: "contract Counter { uint256 public value; function increment() external { value += 1; } }",
    findings: [], suitePlan: [], verificationQuestions: [{ id: "Q-INCREMENT" }],
  };
  const code = [
    'import "../src/Target.sol";',
    'import "../test-support/AttestTest.sol";',
    "contract CounterAdversarialTest is AttestTest {",
    "  function testCallerBoundIncrement() external {",
    "    Counter target = new Counter();",
    "    _prank(address(0xBEEF));",
    "    target.increment();",
    '    require(target.value() == 1, "increment mismatch");',
    "  }",
    "}",
  ].join("\n");
  const plan = { findingIds: [], suitePlanIds: [], questionIds: ["Q-INCREMENT"], code };
  assert.equal(__test.validateGeneratedTest(job, plan).ok, true);
  assert.equal(__test.validateGeneratedTest(job, { ...plan, code: code.replace("_prank(address(0xBEEF));", "vm.prank(address(0xBEEF));") }).ok, false);
});

test("invalid or empty AI citations cannot produce an accepted verdict", () => {
  const known = finding();
  const job = { source: "contract Vault {}", findings: [known], suitePlan: [] };
  const result = __test.validateAiResult(job, {
    reviewedFindings: [{ findingId: known.id, verdict: "likely", assumptionEffect: "none", evidence: [{ lineStart: -1, lineEnd: 999, quote: "", why: "invalid" }] }],
    testPlans: [],
  });
  assert.equal(result.reviewedFindings[0].sourceValidated, false);
  assert.equal(result.reviewedFindings[0].verdict, "needs-review");
});

test("generated test execution is not equivalent to vulnerability reproduction", () => {
  const item = finding({ evidence: [{ kind: "static", tool: "slither" }, { kind: "generated-test-execution", tool: "forge", reproduced: false }] });
  __test.corroborate([item]);
  assert.equal(item.verification, "static-only");
});

test("generated assertion failures remain unverified until oracle review", () => {
  assert.equal(__test.classifyGeneratedTestFailure({ stdout: "[FAIL: invariant violated] test_supply()", stderr: "" }), "unverified-assertion");
  assert.equal(__test.classifyGeneratedTestFailure({ stdout: "", stderr: "Compiler run failed: TypeError: bad type" }), "harness-error");
  assert.equal(__test.classifyGeneratedTestFailure({ stdout: "", stderr: "process exited unexpectedly" }), "execution-error");
});

test("an all-rejected pre-Forge campaign is skipped rather than reported as a property failure", () => {
  assert.equal(__test.generatedTestStageStatus({ executed: 0, rejected: 7, failed: 0, timedOut: 0, awaitingOracle: 0, budgetExhausted: false }), "skipped");
  assert.equal(__test.generatedTestStageStatus({ executed: 1, rejected: 0, failed: 0, timedOut: 0, awaitingOracle: 1, budgetExhausted: false }), "completed");
  assert.equal(__test.generatedTestStageStatus({ executed: 1, rejected: 0, failed: 1, timedOut: 0, awaitingOracle: 0, budgetExhausted: false }), "failed");
});

test("the AI controller's terminal state determines operational completion", () => {
  const failedProfile = { aiProfile: { status: "failed" } };
  assert.equal(__test.deriveFinalStatus(failedProfile), "failed");
  const reviewJob = { aiProfile: { status: "completed" }, auditDepth: "review", operationLoop: { status: "completed" } };
  assert.equal(__test.deriveFinalStatus(reviewJob), "completed");
  const completeJob = { aiProfile: { status: "completed" }, auditDepth: "targeted", verificationQuestions: [], evidenceReview: { questionResults: [] }, operationLoop: { status: "completed", evidenceLedger: [] }, ai: { requested: true }, findings: [] };
  assert.equal(__test.deriveFinalStatus(completeJob), "completed");
  const unresolvedJob = { ...completeJob, verificationQuestions: [{ id: "Q-1" }], operationLoop: { status: "evidence-exhausted", evidenceLedger: [] } };
  assert.equal(__test.deriveFinalStatus(unresolvedJob), "partial");
  const unresolvedFullJob = { ...unresolvedJob, auditDepth: "full", operationLoop: { status: "evidence-exhausted", evidenceLedger: [], coverageObligations: [] } };
  assert.equal(__test.deriveFinalStatus(unresolvedFullJob), "partial");
  const manualReviewJob = { ...completeJob, findings: [{ aiReview: { sourceValidated: false, terminalDisposition: "manual-review-required" } }] };
  assert.equal(__test.deriveFinalStatus(manualReviewJob), "completed", "server finding counters do not override the AI controller's terminal decision");
});

test("a Foundry assertion failure is evidence awaiting oracle review, not a broken tool run", () => {
  assert.equal(__test.generatedToolRunStatus({ timedOut: false, exitCode: 1 }, "unverified-assertion"), "completed");
  assert.equal(__test.generatedToolRunStatus({ timedOut: false, exitCode: 1 }, "compile-error"), "failed");
  assert.equal(__test.generatedToolRunStatus({ timedOut: true, exitCode: null }, "timeout"), "timed-out");
});

test("AI controller reports source-supported and unresolved analyzer judgments separately", async () => {
  const source = await readFile(new URL("../src/server/audit.js", import.meta.url), "utf8");
  assert.match(source, /AI reviewed analyzer evidence: \$\{sourceValidated\} source-supported; \$\{manualReview\} still require judgment/);
  assert.doesNotMatch(source, /stage\(job, "ai-tests"/);
});

test("final synthesis and findings render only inside final publication", async () => {
  const source = await readFile(new URL("../src/server/audit.js", import.meta.url), "utf8");
  const synthesis = source.indexOf("await runFinalSynthesis(artifactJob, presentation, artifactJob.status)");
  const render = source.indexOf("artifactJob.reportMarkdown = renderFindingsMarkdown(artifactJob)");
  const artifacts = source.indexOf("await writePublishedArtifacts(artifactJob, revision)");
  const ready = source.indexOf("job.reportState = artifactJob.reportState");
  assert.ok(synthesis >= 0 && synthesis < render);
  assert.ok(render < artifacts);
  assert.ok(artifacts < ready);
  assert.doesNotMatch(source, /deterministicSynthesis/);
  assert.match(source, /basis: "ai-auditor"/);
  assert.match(source, /kind: "conclusion"/);
  assert.doesNotMatch(source, /job\.codex\.synthesize/);
});

test("whole-contract AI assessment precedes the adaptive operation loop and fixed scheduling is removed", async () => {
  const source = await readFile(new URL("../src/server/audit.js", import.meta.url), "utf8");
  const profileCall = source.indexOf("await runAiProfile(job)");
  const controllerCall = source.indexOf("await runAiControlledAudit(job)");
  assert.ok(profileCall >= 0 && profileCall < controllerCall);
  assert.doesNotMatch(source, /AI review depth selected; no executable verification operations were authorized/);
  assert.match(source, /planAuditOperations/);
  assert.match(source, /executeControllerOperation/);
  assert.match(source, /await adjudicateControllerEvidence\(job\)/);
  assert.doesNotMatch(source, /async function runAuditCampaign/);
  assert.doesNotMatch(source, /async function designTargetedPass/);
});

test("a compiler matrix does not masquerade as the standard artifact build Anvil consumes", async () => {
  const source = await readFile(new URL("../src/server/audit.js", import.meta.url), "utf8");
  const ensureBlock = source.slice(source.indexOf("async function ensureCompiledArtifacts"), source.indexOf("async function runControllerFoundryOperation"));
  assert.match(ensureBlock, /\["forge-bootstrap", "forge"\]/);
  assert.doesNotMatch(ensureBlock, /\["forge-bootstrap", "forge", "compiler-matrix"\]/);
  assert.match(ensureBlock, /inspectDeploymentArtifacts/);
});

test("AI test plans are deduplicated by stable id before execution", () => {
  const job = {
    source: "contract Token { function totalSupply() external pure returns (uint256) { return 100; } }",
    findings: [],
    suitePlan: [{ id: "ERC20-01" }],
    testCampaign: { generatedTestBudget: 8 },
  };
  const plan = { id: "TP-1", title: "Supply", findingIds: [], suitePlanIds: ["ERC20-01"], questionIds: ["Q-1"], target: "Token", testType: "unit", code: "contract T {}", expectedBehavior: "Supply is fixed" };
  const result = __test.validateAiResult(job, { verificationQuestions: [{ id: "Q-1", question: "Is supply fixed?", expectedEvidence: "source", requiredEvidenceKinds: ["source"] }], reviewedFindings: [], testPlans: [plan, { ...plan }] });
  assert.equal(result.testPlans.length, 1);
  assert.equal(job.testCampaign.duplicatePlansRejected, 1);
});

test("constructor allocation and constructor events become separate evidence questions", () => {
  const [state, event] = __test.splitCompoundVerificationQuestions([{
    id: "Q-SUPPLY",
    question: "Does deployment establish exactly 1,000 tokens, assign every unit to the deployer, and emit exactly one Transfer event from the zero address?",
    expectedEvidence: "Deployment state and receipt logs",
    requiredEvidenceKinds: ["source", "foundry", "anvil-deployment", "anvil-observation"],
  }]);
  assert.equal(state.id, "Q-SUPPLY-STATE");
  assert.match(state.question, /assign every unit to the deployer\?$/);
  assert.deepEqual(state.requiredEvidenceKinds, ["source", "anvil-deployment", "anvil-observation"]);
  assert.equal(event.id, "Q-SUPPLY-EVENT");
  assert.match(event.question, /emit exactly one Transfer event/);
  assert.deepEqual(event.requiredEvidenceKinds, ["source", "anvil-deployment", "anvil-observation"]);
  const withoutComma = __test.splitCompoundVerificationQuestions([{
    id: "Q-NO-COMMA",
    question: "Does the constructor assign supply to the deployer and emit the expected Transfer event?",
  }]);
  assert.equal(withoutComma.length, 2);
  assert.equal(__test.splitCompoundVerificationQuestions(withoutComma).length, 2);
  assert.equal(__test.splitCompoundVerificationQuestions([{
    id: "Q-LOG",
    question: "Does the constructor allocate supply to the deployer while logging the expected Transfer event?",
  }]).length, 2);
});

test("plans for a split constructor question retain the atomic property they actually assert", () => {
  const job = {
    source: "contract Token { uint256 public totalSupply; mapping(address => uint256) public balanceOf; }",
    findings: [], suitePlan: [{ id: "ERC20-01" }], testCampaign: { generatedTestBudget: 4 },
  };
  const result = __test.validateAiResult(job, {
    verificationQuestions: [{
      id: "Q-SUPPLY",
      question: "Does deployment assign every unit to the deployer and emit one Transfer event?",
      expectedEvidence: "Deployment state and event evidence",
      requiredEvidenceKinds: ["source", "foundry", "anvil-deployment", "anvil-observation"],
    }],
    reviewedFindings: [],
    testPlans: [{
      id: "TP-STATE", title: "Constructor supply and deployer balance", findingIds: [], suitePlanIds: ["ERC20-01"], questionIds: ["Q-SUPPLY"],
      target: "Token", testType: "unit", code: "require(token.totalSupply() == token.balanceOf(address(this)));", expectedBehavior: "Supply is assigned to deployer",
    }],
  });
  assert.deepEqual(result.testPlans[0].questionIds, ["Q-SUPPLY-STATE"]);
  assert.deepEqual(result.verificationQuestions.find((item) => item.id === "Q-SUPPLY-EVENT").requiredEvidenceKinds.sort(), ["anvil-deployment", "anvil-observation", "source"]);
});

test("required evidence cannot be weakened below the question's own expected evidence", () => {
  const job = { source: "contract Token {}", findings: [], suitePlan: [], testCampaign: { generatedTestBudget: 0 } };
  const result = __test.validateAiResult(job, {
    verificationQuestions: [{ id: "Q-1", question: "Does the invariant hold?", expectedEvidence: "An executed Foundry fuzz invariant", requiredEvidenceKinds: ["source"] }],
    reviewedFindings: [], testPlans: [],
  });
  assert.deepEqual(result.verificationQuestions[0].requiredEvidenceKinds.sort(), ["foundry", "source"]);
});

test("Foundry transfer evidence does not accidentally require a duplicate Anvil scenario", () => {
  const job = { source: "contract Token {}", findings: [], suitePlan: [], testCampaign: { generatedTestBudget: 0 } };
  const result = __test.validateAiResult(job, {
    verificationQuestions: [{
      id: "Q-ACCOUNT",
      question: "Do transfers conserve supply?",
      expectedEvidence: "Fresh Anvil deployment observations and executed Foundry transfer invariants",
      requiredEvidenceKinds: ["source", "anvil-deployment", "anvil-observation", "foundry"],
    }],
    reviewedFindings: [], testPlans: [],
  });
  assert.deepEqual(result.verificationQuestions[0].requiredEvidenceKinds.sort(), ["anvil-deployment", "anvil-observation", "foundry", "source"]);
});

test("generated tests reject an address-exists assertion unrelated to the property", () => {
  const job = {
    source: "contract Counter { uint256 public x; function mutate() external { x++; } }",
    findings: [],
    suitePlan: [{ id: "CUSTOM-01" }],
    verificationQuestions: [{ id: "Q-X", question: "Does mutate preserve x?" }],
  };
  const plan = {
    id: "TP-X", findingIds: [], suitePlanIds: ["CUSTOM-01"], questionIds: ["Q-X"], target: "Counter", testType: "unit",
    code: 'import "../src/Target.sol"; contract T { function testX() external { Counter c = new Counter(); c.mutate(); require(address(c) != address(0), "exists"); } }',
  };
  assert.equal(__test.validateGeneratedTest(job, plan).ok, false);
});

test("artifact projection includes report completion without mutating the live running job", () => {
  const job = {
    status: "running",
    updatedAt: "before",
    stages: [
      { id: "evidence-review", status: "queued", message: "Waiting" },
      { id: "report", status: "running", message: "Rendering" },
    ],
    worklog: [{ id: "earlier", stage: "report", status: "running", message: "Rendering" }],
  };
  const projected = __test.projectCompletedArtifactJob(job, "partial", "Artifacts generated");

  assert.equal(job.status, "running");
  assert.equal(job.stages[0].status, "queued");
  assert.equal(job.stages[1].status, "running");
  assert.equal(job.worklog.length, 1);
  assert.equal(projected.status, "partial");
  assert.equal(projected.stages[0].status, "skipped");
  assert.equal(projected.stages[1].status, "completed");
  assert.equal(projected.stages[1].message, "Artifacts generated");
  assert.equal(projected.worklog.at(-2).stage, "evidence-review");
  assert.equal(projected.worklog.at(-2).status, "skipped");
  assert.equal(projected.worklog.at(-1).status, "completed");
  assert.equal(projected.worklog.at(-1).stage, "report");
});

test("generated tests must target the affected function and use a real assertion", () => {
  const target = finding({ location: { file: "src/Target.sol", lineStart: 10, lineEnd: 14, function: "withdraw" } });
  const job = { source: "contract VulnerableVault { function withdraw() external {} }", findings: [target] };
  const result = __test.validateGeneratedTest(job, {
    findingIds: [target.id],
    code: 'import "../src/Target.sol"; contract T { function testWithdraw() public { VulnerableVault vault = new VulnerableVault(); vault.withdraw(); require(address(vault).balance == 0, "unexpected"); } }',
  });
  assert.equal(result.ok, true);
});

test("generated-test screening rejects unrelated assertions and computed low-level cheatcode calls", () => {
  const target = finding({ location: { file: "src/Target.sol", lineStart: 1, lineEnd: 1, function: "withdraw" } });
  const job = { source: "contract Vault { function withdraw() external {} }", findings: [target] };
  const base = { findingIds: [target.id], suitePlanIds: [] };
  const unrelated = __test.validateGeneratedTest(job, {
    ...base,
    code: 'import "../src/Target.sol"; contract T { function testFake() public { Vault vault = new Vault(); vault.withdraw(); uint256 x = 1; require(x == 1); } }',
  });
  assert.equal(unrelated.ok, false);
  assert.match(unrelated.error, /instance created/);
  const lowLevel = __test.validateGeneratedTest(job, {
    ...base,
    code: 'contract T { function testWarp(Vault vault) public { vault.withdraw(); address h = address(uint160(uint256(keccak256("hevm cheat code")))); h.call(abi.encodeWithSignature("warp(uint256)", 123)); require(address(vault) != address(0)); } }',
  });
  assert.equal(lowLevel.ok, false);
  assert.match(lowLevel.error, /Low-level calls/);
  const callOptions = __test.validateGeneratedTest(job, {
    ...base,
    code: 'contract T { function testWarp(Vault vault) public { vault.withdraw(); address h = address(uint160(uint256(keccak256("hevm cheat code")))); h.call{gas: gasleft()}(abi.encodeWithSignature("warp(uint256)", 123)); require(address(vault) != address(0)); } }',
  });
  assert.equal(callOptions.ok, false);
  assert.match(callOptions.error, /Low-level calls/);
});

test("generated tests cannot substitute a decoy for the submitted contract", () => {
  const job = {
    source: "contract Counter { uint256 public x; function mutate() external { x++; } }",
    findings: [], suitePlan: [{ id: "S-1" }], verificationQuestions: [{ id: "Q-1" }],
  };
  const base = { findingIds: [], suitePlanIds: ["S-1"], questionIds: ["Q-1"] };
  const noImport = __test.validateGeneratedTest(job, {
    ...base,
    code: "contract CounterDecoy { uint256 public x; function mutate() external { x++; } } contract T { function testX() external { CounterDecoy c = new CounterDecoy(); c.mutate(); require(c.x() == 1); } }",
  });
  assert.equal(noImport.ok, false);
  assert.match(noImport.error, /import only one bare/);
  const aliasShadow = __test.validateGeneratedTest(job, {
    ...base,
    code: 'import {Counter as SubmittedCounter} from "../src/Target.sol"; contract Counter { uint256 public x; function mutate() external { x += 100; } } contract T { function testX() external { Counter c = new Counter(); c.mutate(); require(c.x() == 100); } }',
  });
  assert.equal(aliasShadow.ok, false);
  assert.match(aliasShadow.error, /import only one bare/);
  const unusedImport = __test.validateGeneratedTest(job, {
    ...base,
    code: 'import "../src/Target.sol"; contract CounterDecoy { uint256 public x; function mutate() external { x++; } } contract T { function testX() external { CounterDecoy c = new CounterDecoy(); c.mutate(); require(c.x() == 1); } }',
  });
  assert.equal(unusedImport.ok, false);
  assert.match(unusedImport.error, /instantiate/);
  const derived = __test.validateGeneratedTest({ ...job, source: "contract Counter { uint256 public x; function mutate() external virtual { x++; } }" }, {
    ...base,
    code: 'import "../src/Target.sol"; contract CounterDecoy is Counter { function mutate() external override { x += 100; } } contract T { function testX() external { CounterDecoy c = new CounterDecoy(); c.mutate(); require(c.x() == 100); } }',
  });
  assert.equal(derived.ok, false);
  assert.match(derived.error, /substitute or derived targets/);
  const genuine = __test.validateGeneratedTest(job, {
    ...base,
    code: 'import "../src/Target.sol"; contract T { function testX() external { Counter c = new Counter(); c.mutate(); require(c.x() == 1); } }',
  });
  assert.equal(genuine.ok, true);
  const setupGenuine = __test.validateGeneratedTest(job, {
    ...base,
    code: 'import "../src/Target.sol"; contract T { Counter c; function setUp() public { c = new Counter(); } function testX() external { c.mutate(); require(c.x() == 1); } }',
  });
  assert.equal(setupGenuine.ok, true);
  const publicGetter = __test.validateGeneratedTest({ ...job, source: "contract Counter { uint256 public x; }" }, {
    ...base,
    code: 'import "../src/Target.sol"; contract T { function testX() external { Counter c = new Counter(); require(c.x() == 0); } }',
  });
  assert.equal(publicGetter.ok, true);
});

test("one generated harness cannot promote multiple atomic questions", () => {
  const job = {
    source: "contract Counter { uint256 public x; function mutate() external { x++; } }",
    findings: [], suitePlan: [{ id: "S-1" }], verificationQuestions: [{ id: "Q-SUPPLY" }, { id: "Q-OWNER" }],
  };
  const result = __test.validateGeneratedTest(job, {
    findingIds: [], suitePlanIds: ["S-1"], questionIds: ["Q-SUPPLY", "Q-OWNER"],
    code: 'import "../src/Target.sol"; contract T { function testX() external { Counter c = new Counter(); c.mutate(); require(c.x() == 1); } }',
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /complete oracleBindings/);
});

test("one harness may group related questions only with complete function-level oracle bindings", () => {
  const job = {
    source: "contract Counter { uint256 public x; function mutate() external { x++; } }",
    findings: [], suitePlan: [], verificationQuestions: [{ id: "Q-INITIAL" }, { id: "Q-MUTATE" }],
  };
  const code = [
    'import "../src/Target.sol";',
    "contract T {",
    "  function testInitialValue() external { Counter c = new Counter(); require(c.x() == 0); }",
    "  function testMutation() external { Counter c = new Counter(); c.mutate(); require(c.x() == 1); }",
    "}",
  ].join("\n");
  const result = __test.validateGeneratedTest(job, {
    findingIds: [], suitePlanIds: [], questionIds: ["Q-INITIAL", "Q-MUTATE"], code,
    oracleBindings: [
      { testFunction: "testInitialValue", questionIds: ["Q-INITIAL"] },
      { testFunction: "testMutation", questionIds: ["Q-MUTATE"] },
    ],
  });
  assert.equal(result.ok, true, result.error);
});

test("obfuscated HEVM receivers cannot manufacture generated-test evidence", () => {
  const job = { source: "contract Counter { uint256 public x; }", findings: [], suitePlan: [{ id: "S-1" }], verificationQuestions: [{ id: "Q-1" }] };
  const result = __test.validateGeneratedTest(job, {
    findingIds: [], suitePlanIds: ["S-1"], questionIds: ["Q-1"],
    code: `import "../src/Target.sol";
interface Cheat { function store(address,uint256,bytes32) external; }
contract T { function testForged() external { Counter c = new Counter(); uint160 hi = 0x7109709ECfa91a80626f; uint160 lo = 0xF3989D68f67F5b1DD12D; address receiver = address((hi << 80) | lo); Cheat(receiver).store(address(c), 0, bytes32(uint256(99))); require(c.x() == 99); } }`,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /interfaces|arbitrary address-to-contract/);
});

test("verification questions are append-only and cannot be weakened by later analyzer review", () => {
  const original = [{ id: "Q-1", question: "Does supply remain fixed?", requiredEvidenceKinds: ["source", "foundry"] }];
  const incoming = [
    { id: "Q-1", question: "Is there source code?", requiredEvidenceKinds: ["source"] },
    { id: "Q-2", question: "Is owner bounded?", requiredEvidenceKinds: ["source"] },
  ];
  const merged = __test.mergeStableVerificationQuestions(original, incoming);
  assert.deepEqual(merged[0], original[0]);
  assert.equal(merged[1].id, "Q-2");
});

test("server coverage counters do not override a completed AI auditor decision", () => {
  const job = {
    aiProfile: { status: "completed" }, auditDepth: "full", verificationQuestions: [], evidenceReview: { questionResults: [] },
    operationLoop: { status: "completed", evidenceLedger: [], coverageObligations: [
      { kind: "slither", required: true, status: "completed" },
      { kind: "fork", required: true, status: "not-authorized" },
    ] }, ai: { requested: true }, findings: [],
  };
  assert.equal(__test.deriveFinalStatus(job), "completed");
  job.operationLoop.coverageObligations[1].status = "completed";
  assert.equal(__test.deriveFinalStatus(job), "completed");
});

test("full mode has server-owned scheduling questions and compiler scope rules", () => {
  const questions = __test.buildFullCoverageQuestions([{ kind: "slither", status: "pending" }, { kind: "fork", status: "not-authorized" }]);
  assert.deepEqual(questions.map((item) => item.id), ["Q-FULL-SLITHER"]);
  assert.equal(__test.compilerMatrixScopeComplete("pragma solidity 0.8.20; contract T {}", ["0.8.20"]), true);
  assert.equal(__test.compilerMatrixScopeComplete("pragma solidity ^0.8.20; contract T {}", ["0.8.20"]), false);
  assert.equal(__test.compilerMatrixScopeComplete("pragma solidity ^0.8.20; contract T {}", ["0.8.20", "0.8.28"]), true);
});

test("full Foundry coverage remains schedulable across multiple controller rounds", () => {
  const job = {
    auditDepth: "full",
    verificationQuestions: [],
    evidenceReview: { questionResults: [] },
    operationLoop: {
      coverageObligations: [{ kind: "foundry", status: "pending", requiredQuestionIds: ["Q-1", "Q-2", "Q-3", "Q-4", "Q-5"], completedQuestionIds: [] }],
      coverageQuestions: ["Q-1", "Q-2", "Q-3", "Q-4", "Q-5"].map((id) => ({ id, coverageKind: "foundry" })),
    },
  };
  for (const id of ["Q-1", "Q-2", "Q-3", "Q-4"]) {
    __test.updateCoverageObligation(job, { kind: "foundry", questionId: id }, { status: "completed" });
    job.evidenceReview.questionResults.push({ questionId: id, status: "ai-supported" });
  }
  __test.reconcileFullCoverageAfterAdjudication(job);
  assert.equal(job.operationLoop.coverageObligations[0].status, "pending");
  assert.deepEqual(__test.controllerOperationQuestionIds(job), ["Q-5"]);
  __test.updateCoverageObligation(job, { kind: "foundry", questionId: "Q-5" }, { status: "completed" });
  job.evidenceReview.questionResults.push({ questionId: "Q-5", status: "ai-supported" });
  __test.reconcileFullCoverageAfterAdjudication(job);
  assert.equal(job.operationLoop.coverageObligations[0].status, "completed");
});

test("restart releases an interrupted Copilot turn without changing evidence", () => {
  const job = {
    status: "completed",
    evidenceRevision: 3,
    sourceFindings: [],
    worklog: [],
    reportRevisions: [],
    followup: { status: "idle", active: null, history: [], actions: [] },
    copilot: { status: "running", error: null, messages: [{ role: "user", text: "Explain the result" }] },
  };
  __test.normalizeRestoredJob(job);
  assert.equal(job.copilot.status, "idle");
  assert.equal(job.evidenceRevision, 3);
  assert.match(job.copilot.error, /restarted/);
  assert.equal(job.copilot.messages.at(-1).kind, "recovery");
});

test("invalid oracle evidence permits a bounded corrected Foundry attempt", () => {
  const history = [{ id: "OP-1", kind: "foundry", questionId: "Q-1", specDigest: "digest", status: "completed" }];
  const job = {
    verificationQuestions: [{ id: "Q-1" }],
    evidenceReview: { questionResults: [{ questionId: "Q-1", status: "not-verified" }] },
    ai: { result: { testPlans: [{ followupOperationId: "OP-1", questionIds: ["Q-1"], executionStatus: "invalid-test" }] } },
  };
  assert.deepEqual(__test.retryableControllerSpecDigests(job, history), ["digest"]);
  assert.deepEqual(__test.retryableControllerSpecDigests(job, [...history, { ...history[0], id: "OP-2" }]), []);
});

test("controller campaigns enforce the global property budget while allowing one bounded correction", () => {
  const question = { id: "Q-1" };
  const operation = { id: "OP-2", kind: "foundry", questionId: "Q-1", specDigest: "digest" };
  const job = {
    evidenceRevision: 1,
    findings: [],
    suitePlan: [],
    verificationQuestions: [question],
    evidenceReview: { questionResults: [{ questionId: "Q-1", status: "not-verified" }] },
    operationLoop: { history: [{ id: "OP-1", kind: "foundry", questionId: "Q-1", specDigest: "digest", status: "completed" }, operation] },
    followup: {},
    testCampaign: { generatedTestBudget: 1, plansTruncated: 0 },
    ai: { result: { testPlans: [{ id: "old", followupOperationId: "OP-1", operationSpecDigest: "digest", questionIds: ["Q-1"], executionStatus: "invalid-test", code: "old" }] } },
  };
  assert.deepEqual(__test.controllerCampaignCapacity(job, operation), { budget: 1, remaining: 0, retryAllowed: true, maxHarnesses: 1 });
  const candidates = [1, 2, 3].map((index) => ({ id: `candidate-${index}`, code: `contract T${index} {}`, expectedBehavior: `attempt ${index}`, questionIds: ["Q-1"], findingIds: [], suitePlanIds: [] }));
  const accepted = __test.normalizeCampaignPlans(job, operation, [question], candidates);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].operationSpecDigest, "digest");
  assert.equal(job.testCampaign.plansTruncated, 2);

  const unrelated = { id: "OP-OTHER", kind: "foundry", questionId: "Q-2", specDigest: "other" };
  job.verificationQuestions.push({ id: "Q-2" });
  job.evidenceReview.questionResults.push({ questionId: "Q-2", status: "not-verified" });
  assert.deepEqual(__test.controllerCampaignCapacity(job, unrelated), { budget: 1, remaining: 0, retryAllowed: false, maxHarnesses: 0 });
  assert.equal(__test.normalizeCampaignPlans(job, unrelated, [{ id: "Q-2" }], [{ code: "contract Other {}", expectedBehavior: "new property", questionIds: ["Q-2"], findingIds: [], suitePlanIds: [] }]).length, 0);
});

test("the hard operation envelope does not manufacture a follow-up action", () => {
  const job = {
    auditDepth: "full",
    reportState: { status: "waiting-for-audit" },
    followup: { actions: [] },
    operationLoop: { status: "evidence-exhausted", evidenceLedger: Array.from({ length: 64 }, (_, index) => ({ id: index })), coverageQuestions: [], coverageObligations: [] },
    verificationQuestions: [{ id: "Q-OPEN", materiality: "required-for-opinion" }],
    evidenceReview: { questionResults: [] },
    developerEvidence: [],
  };
  __test.refreshFollowupActions(job);
  assert.equal(job.followup.actions.filter((item) => item.status === "open").length, 0);
});
