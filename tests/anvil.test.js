import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { decodeObservationValue, deployedBytecodeSha256, inspectDeploymentArtifacts, runFreshAnvilDeployment, selectDeployableArtifact, standardReadObservationSpecs, validateAnvilScenario } from "../src/server/anvil.js";

test("Anvil deployment selection accepts exactly one linked zero-constructor target", async () => {
  const root = await mkdtemp(path.join("/tmp", "soltesting-anvil-"));
  const out = path.join(root, "out", "Target.sol");
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, "Target.json"), JSON.stringify({ abi: [], bytecode: { object: "0x60006000", linkReferences: {} } }));
  const selected = await selectDeployableArtifact(root);
  assert.equal(selected.status, "ready");
  assert.equal(selected.contract, "Target");
});

test("AI uncertainty cannot block a sole zero-argument disposable target", async () => {
  const root = await mkdtemp(path.join("/tmp", "soltesting-anvil-"));
  const out = path.join(root, "out", "Target.sol");
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, "SenderOwned.json"), JSON.stringify({ abi: [], bytecode: { object: "0x60006000", linkReferences: {} } }));
  const selected = await selectDeployableArtifact(root, { decision: "needs-input", decisionReason: "implicit-deployer-identity", environment: "fresh-anvil", targetContract: "SenderOwned", constructorArguments: [], transactionValueWei: "0", rationale: "Intended deployer was not named", limitations: [] });
  assert.equal(selected.status, "ready");
  assert.equal(selected.contract, "SenderOwned");
  assert.equal(selected.deploymentPlan.decision, "deploy");
  assert.deepEqual(selected.deploymentPlan.constructorArguments, []);
  assert.equal(selected.deploymentPlan.transactionValueWei, "0");
  assert.match(selected.deploymentPlan.rationale, /disposable deployment/);
});

test("payable or explicit skip decisions are never overridden", async () => {
  const root = await mkdtemp(path.join("/tmp", "soltesting-anvil-"));
  const out = path.join(root, "out", "Target.sol");
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, "Payable.json"), JSON.stringify({ abi: [{ type: "constructor", stateMutability: "payable", inputs: [] }], bytecode: { object: "0x60006000", linkReferences: {} } }));
  const base = { environment: "fresh-anvil", targetContract: "Payable", constructorArguments: [], transactionValueWei: "0", rationale: "Deployment value is material", limitations: [] };
  const payable = await selectDeployableArtifact(root, { ...base, decision: "needs-input", decisionReason: "payable-value" });
  assert.equal(payable.status, "unsupported");
  assert.match(payable.reason, /material/);
  const skipped = await selectDeployableArtifact(root, { ...base, decision: "skip", decisionReason: "chain-environment" });
  assert.equal(skipped.status, "unsupported");
});

test("standard Anvil observations are limited to safe common view calls", () => {
  const abi = [
    { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
    { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
    { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  ];
  assert.deepEqual(standardReadObservationSpecs(abi).map((item) => item.id), ["total-supply", "balance-actor-0", "balance-actor-1", "owner"]);
  assert.equal(decodeObservationValue(`0x${"0".repeat(63)}a`, "uint256"), "10");
  assert.equal(decodeObservationValue(`0x${"0".repeat(24)}1234567890abcdef1234567890abcdef12345678`, "address"), "0x1234567890abcdef1234567890abcdef12345678");
});

test("Anvil deployment selection refuses constructor arguments and ambiguous targets", async () => {
  const root = await mkdtemp(path.join("/tmp", "soltesting-anvil-"));
  const out = path.join(root, "out", "Target.sol");
  await mkdir(out, { recursive: true });
  const withConstructor = { abi: [{ type: "constructor", inputs: [{ name: "owner", type: "address" }] }], bytecode: { object: "0x6000", linkReferences: {} } };
  await writeFile(path.join(out, "NeedsArgs.json"), JSON.stringify(withConstructor));
  assert.match((await selectDeployableArtifact(root)).reason, /constructor planning is required/);
  const eligible = { abi: [], bytecode: { object: "0x6000", linkReferences: {} } };
  await writeFile(path.join(out, "One.json"), JSON.stringify(eligible));
  await writeFile(path.join(out, "Two.json"), JSON.stringify(eligible));
  assert.match((await selectDeployableArtifact(root)).reason, /top-level deployment targets/);
});

test("AI deployment plans select constructor targets only after exact ABI validation", async () => {
  const root = await mkdtemp(path.join("/tmp", "soltesting-anvil-"));
  const out = path.join(root, "out", "Target.sol");
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, "Token.json"), JSON.stringify({
    abi: [{ type: "constructor", stateMutability: "nonpayable", inputs: [
      { name: "owner", type: "address", internalType: "address" },
      { name: "supply", type: "uint256", internalType: "uint256" },
    ] }],
    bytecode: { object: "0x60006000", linkReferences: {} },
  }));
  const plan = {
    decision: "deploy",
    environment: "fresh-anvil",
    targetContract: "Token",
    constructorArguments: [
      { position: 0, name: "owner", solidityType: "address", valueKind: "anvil-account", value: "0", rationale: "ephemeral owner" },
      { position: 1, name: "supply", solidityType: "uint256", valueKind: "literal", value: "1000000", rationale: "bounded test supply" },
    ],
    transactionValueWei: "0",
    rationale: "Deploy the compiled token",
    limitations: [],
  };

  const inventory = await inspectDeploymentArtifacts(root);
  assert.deepEqual(inventory[0].constructorInputs.map((item) => item.type), ["address", "uint256"]);
  const selected = await selectDeployableArtifact(root, plan);
  assert.equal(selected.status, "ready");
  assert.equal(selected.contract, "Token");
  assert.equal(selected.deploymentPlan.constructorArguments.length, 2);

  const wrongType = structuredClone(plan);
  wrongType.constructorArguments[1].solidityType = "uint128";
  assert.match((await selectDeployableArtifact(root, wrongType)).reason, /does not match compiled ABI/);
  const badActor = structuredClone(plan);
  badActor.constructorArguments[0].value = "4";
  assert.match((await selectDeployableArtifact(root, badActor)).reason, /actor index/);
  const unexpectedValue = { ...structuredClone(plan), transactionValueWei: "1" };
  assert.match((await selectDeployableArtifact(root, unexpectedValue)).reason, /payable constructor/);
  const zeroWithPadding = { ...structuredClone(plan), transactionValueWei: "00" };
  assert.equal((await selectDeployableArtifact(root, zeroWithPadding)).deploymentPlan.transactionValueWei, "0");
});

test("Anvil deployment selection prefers the concrete leaf over its deployable base", async () => {
  const root = await mkdtemp(path.join("/tmp", "soltesting-anvil-"));
  const out = path.join(root, "out", "Target.sol");
  await mkdir(out, { recursive: true });
  const ast = {
    nodes: [
      { id: 10, nodeType: "ContractDefinition", name: "Ownable", linearizedBaseContracts: [10] },
      { id: 20, nodeType: "ContractDefinition", name: "Token", linearizedBaseContracts: [20, 10] },
    ],
  };
  const artifact = (contract) => ({
    abi: [],
    ast,
    metadata: { settings: { compilationTarget: { "src/Target.sol": contract } } },
    bytecode: { object: "0x60006000", linkReferences: {} },
  });
  await writeFile(path.join(out, "Ownable.json"), JSON.stringify(artifact("Ownable")));
  await writeFile(path.join(out, "Token.json"), JSON.stringify(artifact("Token")));

  const selected = await selectDeployableArtifact(root);
  assert.equal(selected.status, "ready");
  assert.equal(selected.contract, "Token");
});

test("Anvil deployment selection reads inheritance from build-info when early artifacts omit AST", async () => {
  const root = await mkdtemp(path.join("/tmp", "soltesting-anvil-"));
  const out = path.join(root, "out", "Target.sol");
  const buildInfo = path.join(root, "out", "build-info");
  await mkdir(out, { recursive: true });
  await mkdir(buildInfo, { recursive: true });
  const artifact = (contract) => ({
    abi: [],
    metadata: { settings: { compilationTarget: { "src/Target.sol": contract } } },
    bytecode: { object: "0x60006000", linkReferences: {} },
  });
  await writeFile(path.join(out, "Ownable.json"), JSON.stringify(artifact("Ownable")));
  await writeFile(path.join(out, "Token.json"), JSON.stringify(artifact("Token")));
  await writeFile(path.join(buildInfo, "build.json"), JSON.stringify({
    output: { sources: { "src/Target.sol": { ast: { nodes: [
      { id: 10, nodeType: "ContractDefinition", name: "Ownable", linearizedBaseContracts: [10] },
      { id: 20, nodeType: "ContractDefinition", name: "Token", linearizedBaseContracts: [20, 10] },
    ] } } } },
  }));

  const selected = await selectDeployableArtifact(root);
  assert.equal(selected.status, "ready");
  assert.equal(selected.contract, "Token");
});

test("deterministic fallback never deploys a base or guesses among independent targets", async () => {
  const inheritedRoot = await mkdtemp(path.join("/tmp", "soltesting-anvil-"));
  const inheritedOut = path.join(inheritedRoot, "out", "Target.sol");
  await mkdir(inheritedOut, { recursive: true });
  const ast = { nodes: [
    { id: 10, nodeType: "ContractDefinition", name: "Base", linearizedBaseContracts: [10] },
    { id: 20, nodeType: "ContractDefinition", name: "Derived", linearizedBaseContracts: [20, 10] },
  ] };
  const artifact = (contract, abi) => ({ abi, ast, metadata: { settings: { compilationTarget: { "src/Target.sol": contract } } }, bytecode: { object: "0x6000", linkReferences: {} } });
  await writeFile(path.join(inheritedOut, "Base.json"), JSON.stringify(artifact("Base", [])));
  await writeFile(path.join(inheritedOut, "Derived.json"), JSON.stringify(artifact("Derived", [{ type: "constructor", inputs: [{ name: "owner", type: "address" }] }])));
  const inherited = await selectDeployableArtifact(inheritedRoot);
  assert.equal(inherited.status, "unsupported");
  assert.match(inherited.reason, /Derived requires 1 constructor argument/);

  const independentRoot = await mkdtemp(path.join("/tmp", "soltesting-anvil-"));
  const independentOut = path.join(independentRoot, "out", "Target.sol");
  await mkdir(independentOut, { recursive: true });
  await writeFile(path.join(independentOut, "Alpha.json"), JSON.stringify({ abi: [], bytecode: { object: "0x6000", linkReferences: {} } }));
  await writeFile(path.join(independentOut, "Beta.json"), JSON.stringify({ abi: [{ type: "constructor", inputs: [{ name: "owner", type: "address" }] }], bytecode: { object: "0x6000", linkReferences: {} } }));
  const independent = await selectDeployableArtifact(independentRoot);
  assert.equal(independent.status, "unsupported");
  assert.match(independent.reason, /2 eligible top-level deployment targets/);
});

test("constructor numeric literals are checked against exact ABI widths", async () => {
  const root = await mkdtemp(path.join("/tmp", "soltesting-anvil-"));
  const out = path.join(root, "out", "Target.sol");
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, "Narrow.json"), JSON.stringify({ abi: [{ type: "constructor", inputs: [{ name: "u", type: "uint8" }, { name: "i", type: "int8" }] }], bytecode: { object: "0x6000", linkReferences: {} } }));
  const plan = (u, i) => ({ decision: "deploy", environment: "fresh-anvil", targetContract: "Narrow", constructorArguments: [
    { position: 0, name: "u", solidityType: "uint8", valueKind: "literal", value: u, rationale: "boundary" },
    { position: 1, name: "i", solidityType: "int8", valueKind: "literal", value: i, rationale: "boundary" },
  ], transactionValueWei: "0", rationale: "boundary test", limitations: [] });
  assert.equal((await selectDeployableArtifact(root, plan("255", "-128"))).status, "ready");
  assert.equal((await selectDeployableArtifact(root, plan("255", "127"))).status, "ready");
  assert.match((await selectDeployableArtifact(root, plan("256", "0"))).reason, /uint8 literal is outside/);
  assert.match((await selectDeployableArtifact(root, plan("0", "-129"))).reason, /int8 literal is outside/);
  assert.match((await selectDeployableArtifact(root, plan("0", "128"))).reason, /int8 literal is outside/);
});

test("deployed bytecode fingerprints hash bytes rather than RPC hex text", () => {
  assert.equal(deployedBytecodeSha256("0x6000"), "f3df0a62b10f205b0f29768aa3d69e777154caaa179f64aabb0a4899c666b017");
});

test("typed Anvil scenarios are bound to compiled ABI functions and disposable actors", () => {
  const abi = [
    { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
    { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  ];
  const result = validateAnvilScenario(abi, { steps: [
    { id: "send", actor: 0, functionSignature: "transfer(address,uint256)", arguments: [{ kind: "actor", value: "1" }, { kind: "literal", value: "25" }], valueWei: "0", expectedOutcome: "success", expectedReturn: null },
    { id: "read", actor: 1, functionSignature: "balanceOf(address)", arguments: [{ kind: "actor", value: "1" }], valueWei: "0", expectedOutcome: "success", expectedReturn: "25" },
  ] });
  assert.equal(result.ok, true);
  assert.equal(result.scenario.steps[0].arguments[0].solidityType, "address");
  assert.equal(result.scenario.steps[1].readOnly, true);
});

test("typed Anvil scenarios allow nonzero value on nonpayable functions only as an expected-revert check", () => {
  const abi = [{ type: "function", name: "increment", stateMutability: "nonpayable", inputs: [], outputs: [] }];
  const expectedRevert = validateAnvilScenario(abi, { steps: [
    { id: "nonzero-value", actor: 0, functionSignature: "increment()", arguments: [], valueWei: "1", expectedOutcome: "revert", expectedReturn: null },
  ] });
  assert.equal(expectedRevert.ok, true);
  assert.equal(expectedRevert.scenario.steps[0].expectedOutcome, "revert");
  assert.equal(expectedRevert.scenario.steps[0].valueWei, "1");

  const impossibleSuccess = validateAnvilScenario(abi, { steps: [
    { id: "nonzero-value", actor: 0, functionSignature: "increment()", arguments: [], valueWei: "1", expectedOutcome: "success", expectedReturn: null },
  ] });
  assert.equal(impossibleSuccess.ok, false);
  assert.match(impossibleSuccess.error, /expects success/);
});

test("invalid AI Anvil scenarios are tool failures rather than requests for developer input", async () => {
  const root = await mkdtemp(path.join("/tmp", "soltesting-anvil-"));
  const out = path.join(root, "out", "Target.sol");
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, "Target.json"), JSON.stringify({
    abi: [{ type: "function", name: "increment", stateMutability: "nonpayable", inputs: [], outputs: [] }],
    bytecode: { object: "0x60006000", linkReferences: {} },
  }));
  const result = await runFreshAnvilDeployment({ jobDir: root, scenario: { steps: [
    { id: "unknown", actor: 0, functionSignature: "missing()", arguments: [], valueWei: "0", expectedOutcome: "success", expectedReturn: null },
  ] } });
  assert.equal(result.status, "failed");
  assert.equal(result.failureKind, "scenario-validation");
  assert.match(result.reason, /compiled public ABI/);
});

test("typed Anvil scenarios reject unknown functions, external targets, and ABI mismatches", () => {
  const abi = [{ type: "function", name: "set", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] }];
  assert.match(validateAnvilScenario(abi, { steps: [{ id: "x", actor: 0, functionSignature: "missing()", arguments: [], valueWei: "0", expectedOutcome: "success", expectedReturn: null }] }).error, /compiled public ABI/);
  assert.match(validateAnvilScenario(abi, { steps: [{ id: "x", actor: 4, functionSignature: "set(uint256)", arguments: [{ kind: "literal", value: "1" }], valueWei: "0", expectedOutcome: "success", expectedReturn: null }] }).error, /actor must be 0 through 3/);
  assert.match(validateAnvilScenario(abi, { steps: [{ id: "x", actor: 0, functionSignature: "set(uint256)", arguments: [{ kind: "literal", value: "1" }], valueWei: "0", expectedOutcome: "success", expectedReturn: null, target: "0x0000000000000000000000000000000000000001" }] }).error, /only typed ABI fields/);
});
