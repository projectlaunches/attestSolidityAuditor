import test from "node:test";
import assert from "node:assert/strict";
import {
  AUDIT_CONTROLLER_VERSION,
  controllerCapabilityCatalog,
  fullCoverageObligations,
  normalizeAuditDepth,
  normalizeControllerDecision,
} from "../src/server/audit-operations.js";

function operation(overrides = {}) {
  return {
    id: "OP-1",
    kind: "slither",
    questionId: "Q-1",
    objective: "Check the external-call ordering signal",
    rationale: "Static control-flow evidence can challenge the source assessment",
    slitherDetectors: ["reentrancy-eth"],
    aderynSeverity: "all",
    compilerVersions: [],
    networkId: "",
    scenario: null,
    ...overrides,
  };
}

function decision(operations, overrides = {}) {
  return { status: "continue", assessment: "One material question needs evidence", operations, coverageUpdates: [], requestedInput: "", ...overrides };
}

test("supports one controller with review, targeted, and full depth policies", () => {
  assert.equal(normalizeAuditDepth("review"), "review");
  assert.equal(normalizeAuditDepth("targeted"), "targeted");
  assert.equal(normalizeAuditDepth("full"), "full");
  assert.throws(() => normalizeAuditDepth("legacy-pipeline"), /review, targeted, or full/);
  assert.match(AUDIT_CONTROLLER_VERSION, /controller/);
});

test("capability catalog separates installation from user authorization", () => {
  const capabilities = { analyzers: [
    { id: "forge", available: true }, { id: "anvil", available: true },
    { id: "slither", available: true }, { id: "aderyn", available: false },
  ] };
  const catalog = controllerCapabilityCatalog(capabilities, { localExecution: true, anvil: false, forks: true });
  assert.equal(catalog.find((item) => item.kind === "slither").executable, true);
  assert.equal(catalog.find((item) => item.kind === "aderyn").installed, false);
  assert.equal(catalog.find((item) => item.kind === "anvil-deployment").authorized, false);
  assert.equal(catalog.find((item) => item.kind === "anvil-scenario").authorized, false);
  assert.equal(catalog.find((item) => item.kind === "fork").executable, true);
  assert.equal(fullCoverageObligations(catalog).find((item) => item.kind === "anvil-scenario").status, "not-authorized");
});

test("normalizes one question-bound allowlisted operation and rejects duplicates", () => {
  const first = normalizeControllerDecision(decision([operation()]), { questionIds: ["Q-1"] });
  assert.equal(first.status, "continue");
  assert.equal(first.operations[0].kind, "slither");
  assert.equal(first.operations[0].questionId, "Q-1");
  assert.match(first.operations[0].specDigest, /^[0-9a-f]{64}$/);
  const duplicate = normalizeControllerDecision(decision([operation()]), { questionIds: ["Q-1"], priorSpecDigests: [first.operations[0].specDigest] });
  assert.equal(duplicate.status, "blocked");
  assert.equal(duplicate.operations.length, 0);
});

test("rejects generic command, path, RPC, and key authority before execution", () => {
  for (const injected of [
    { command: "bash" },
    { args: ["--broadcast"] },
    { cwd: "/tmp" },
    { rpcUrl: "https://attacker.invalid" },
    { privateKey: "0xdead" },
    { rawCalldata: "0x1234" },
  ]) {
    const normalized = normalizeControllerDecision(decision([operation(injected)]), { questionIds: ["Q-1"] });
    assert.equal(normalized.status, "blocked");
    assert.equal(normalized.operations.length, 0);
  }
});

test("accepts bounded compiler, fork, and typed Anvil operation parameters", () => {
  const compiler = operation({ kind: "compiler-matrix", compilerVersions: ["0.8.20", "0.8.28"], slitherDetectors: [] });
  const fork = operation({ id: "OP-2", kind: "fork", networkId: "base", slitherDetectors: [] });
  const deployment = operation({ id: "OP-DEPLOY", kind: "anvil-deployment", slitherDetectors: [] });
  const anvil = operation({
    id: "OP-3", kind: "anvil-scenario", slitherDetectors: [],
    scenario: { steps: [{ id: "S-1", actor: 1, functionSignature: "transfer(address,uint256)", arguments: [{ kind: "actor", value: "2" }, { kind: "literal", value: "1" }], valueWei: "0", expectedOutcome: "success", expectedReturn: null }] },
  });
  const normalized = normalizeControllerDecision(decision([compiler, fork, deployment, anvil]), { questionIds: ["Q-1"] });
  assert.equal(normalized.operations.length, 4);
  assert.deepEqual(normalized.operations[0].compilerVersions, ["0.8.20", "0.8.28"]);
  assert.equal(normalized.operations[1].networkId, "base");
  assert.equal(normalized.operations[2].kind, "anvil-deployment");
  assert.equal(normalized.operations[2].scenario, null);
  assert.equal(normalized.operations[3].scenario.steps[0].actor, 1);
});

test("model coverage updates cannot waive executable full-suite classes", () => {
  const normalized = normalizeControllerDecision({
    status: "conclude",
    assessment: "No public-chain integration exists in this source",
    operations: [],
    coverageUpdates: [
      { kind: "fork", status: "inapplicable", reason: "No external protocol or chain-state dependency is reachable" },
      { kind: "mythril", status: "inapplicable", reason: "Deferred tool" },
    ],
    requestedInput: "",
  }, { questionIds: [] });
  assert.deepEqual(normalized.coverageUpdates, []);
  const serverApproved = normalizeControllerDecision({
    status: "conclude", assessment: "Server predicate approved the exemption", operations: [],
    coverageUpdates: [{ kind: "fork", status: "inapplicable", reason: "Server-validated no external integration" }], requestedInput: "",
  }, { questionIds: [], serverApprovedInapplicableKinds: ["fork"] });
  assert.deepEqual(serverApproved.coverageUpdates.map((item) => item.kind), ["fork"]);
});

test("semantic operation digests ignore model prose and operation ids while ids remain unique", () => {
  const first = operation({ id: "OP-A", objective: "first wording", rationale: "first reason", slitherDetectors: ["reentrancy-eth"] });
  const sameExecution = operation({ id: "OP-B", objective: "different wording", rationale: "different reason", slitherDetectors: ["reentrancy-eth"] });
  const normalized = normalizeControllerDecision(decision([first, sameExecution]), { questionIds: ["Q-1"], sourceHash: "source-a" });
  assert.equal(normalized.operations.length, 1);
  const duplicateId = normalizeControllerDecision(decision([first, operation({ id: "OP-A", kind: "aderyn", slitherDetectors: [] })]), { questionIds: ["Q-1"], sourceHash: "source-a" });
  assert.equal(duplicateId.operations.length, 1);
  const priorId = normalizeControllerDecision(decision([first]), { questionIds: ["Q-1"], priorOperationIds: ["OP-A"], sourceHash: "source-a" });
  assert.equal(priorId.operations.length, 0);
});

test("needs-input requires a concrete developer request", () => {
  const normalized = normalizeControllerDecision({
    status: "needs-input",
    assessment: "More context required",
    operations: [],
    coverageUpdates: [],
    requestedInput: "",
  }, { questionIds: ["Q-1"] });
  assert.equal(normalized.status, "blocked");
  assert.equal(normalized.requestedInput, "");
  assert.match(normalized.assessment, /specific developer input/);
});

test("a failed Foundry operation may be retried once per decision with a new harness", () => {
  const foundry = operation({ kind: "foundry", slitherDetectors: [] });
  const first = normalizeControllerDecision(decision([foundry]), { questionIds: ["Q-1"], sourceHash: "source" });
  const retried = normalizeControllerDecision(decision([{ ...foundry, id: "OP-RETRY" }]), {
    questionIds: ["Q-1"], sourceHash: "source",
    priorSpecDigests: [first.operations[0].specDigest],
    retryableSpecDigests: [first.operations[0].specDigest],
  });
  assert.equal(retried.operations.length, 1);
  const duplicateSameDecision = normalizeControllerDecision(decision([{ ...foundry, id: "OP-R1" }, { ...foundry, id: "OP-R2" }]), {
    questionIds: ["Q-1"], sourceHash: "source",
    priorSpecDigests: [first.operations[0].specDigest],
    retryableSpecDigests: [first.operations[0].specDigest],
  });
  assert.equal(duplicateSameDecision.operations.length, 1);
});
