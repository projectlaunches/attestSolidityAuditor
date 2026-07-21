import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { registerChild, terminateChild } from "./process-registry.js";
import { runCommand } from "./command.js";

const CHAIN_ID = 31337;

async function loadArtifactCandidates(jobDir) {
  const artifactDir = path.join(jobDir, "out", "Target.sol");
  let names;
  try { names = await readdir(artifactDir); } catch { return []; }
  const candidates = [];
  for (const name of names.filter((value) => value.endsWith(".json")).sort()) {
    const artifactPath = path.join(artifactDir, name);
    let artifact;
    try { artifact = JSON.parse(await readFile(artifactPath, "utf8")); } catch { continue; }
    const bytecode = artifact?.bytecode?.object;
    if (typeof bytecode !== "string" || !/^0x[0-9a-f]+$/i.test(bytecode) || bytecode === "0x") continue;
    const constructor = artifact.abi?.find((item) => item.type === "constructor");
    if (Object.keys(artifact.bytecode?.linkReferences || {}).length) continue;
    const contract = name.slice(0, -5);
    const targetName = Object.values(artifact.metadata?.settings?.compilationTarget || {})[0] || contract;
    const definition = artifact.ast?.nodes?.find((node) => node.nodeType === "ContractDefinition" && node.name === targetName);
    candidates.push({
      contract,
      artifactPath,
      bytecode,
      abi: Array.isArray(artifact.abi) ? artifact.abi : [],
      constructorInputs: constructor?.inputs || [],
      constructorStateMutability: constructor?.stateMutability || "nonpayable",
      astId: definition?.id,
      linearizedBaseContracts: definition?.linearizedBaseContracts || [],
    });
  }
  if (candidates.some((candidate) => !Number.isInteger(candidate.astId))) {
    const definitions = await readBuildInfoDefinitions(jobDir);
    for (const candidate of candidates) {
      const definition = definitions.find((item) => item.name === candidate.contract);
      if (!definition) continue;
      candidate.astId = definition.id;
      candidate.linearizedBaseContracts = definition.linearizedBaseContracts || [];
    }
  }
  return candidates;
}

function leafCandidates(candidates) {
  return candidates.filter((candidate) => !candidates.some((other) =>
    other !== candidate &&
    Number.isInteger(candidate.astId) &&
    other.linearizedBaseContracts.slice(1).includes(candidate.astId)
  ));
}

export async function inspectDeploymentArtifacts(jobDir) {
  const candidates = await loadArtifactCandidates(jobDir);
  const leafNames = new Set(leafCandidates(candidates).map((item) => item.contract));
  return candidates.map((candidate) => ({
    contract: candidate.contract,
    constructorInputs: candidate.constructorInputs.map(({ name, type, internalType }) => ({ name, type, internalType })),
    constructorStateMutability: candidate.constructorStateMutability,
    fullyLinked: true,
    leaf: leafNames.has(candidate.contract),
  }));
}

export async function selectDeployableArtifact(jobDir, deploymentPlan = null) {
  const candidates = await loadArtifactCandidates(jobDir);
  if (!candidates.length) return { status: "unsupported", reason: "Foundry produced no concrete, fully linked Target.sol deployment artifacts" };
  const leaves = leafCandidates(candidates);

  if (deploymentPlan) {
    if (deploymentPlan.decision !== "deploy") {
      if (deploymentPlan.decision === "needs-input" && deploymentPlan.decisionReason === "implicit-deployer-identity" && leaves.length === 1 && leaves[0].constructorInputs.length === 0 && leaves[0].constructorStateMutability !== "payable") {
        const target = leaves[0];
        return { status: "ready", ...target, deploymentPlan: emptyDeploymentPlan(target, "Deterministic disposable deployment: the sole concrete target requires no constructor arguments, so advisory AI uncertainty cannot block the requested local test") };
      }
      return { status: "unsupported", reason: deploymentPlan.rationale || "AI deployment planning requires developer input" };
    }
    const target = candidates.find((candidate) => candidate.contract === deploymentPlan.targetContract);
    if (!target) return { status: "unsupported", reason: `Planned target ${deploymentPlan.targetContract || "(missing)"} is not a compiled deployable contract` };
    const leafNames = new Set(leaves.map((item) => item.contract));
    if (candidates.length > 1 && !leafNames.has(target.contract)) return { status: "unsupported", reason: `Planned target ${target.contract} is a base contract rather than a top-level deployment target` };
    const validation = validateConstructorPlan(target, deploymentPlan);
    if (!validation.ok) return { status: "unsupported", reason: validation.error };
    return { status: "ready", ...target, deploymentPlan: validation.plan };
  }

  if (leaves.length !== 1) return { status: "unsupported", reason: `Found ${leaves.length || candidates.length} eligible top-level deployment targets; automatic selection requires exactly one` };
  const target = leaves[0];
  if (target.constructorInputs.length) return { status: "unsupported", reason: `Top-level target ${target.contract} requires ${target.constructorInputs.length} constructor argument(s); AI or developer constructor planning is required` };
  return { status: "ready", ...target, deploymentPlan: emptyDeploymentPlan(target) };
}

export async function validateDeveloperDeploymentPlan(jobDir, deploymentPlan) {
  const selected = await selectDeployableArtifact(jobDir, deploymentPlan);
  if (selected.status !== "ready") {
    const error = new Error(selected.reason || "The supplied deployment values do not match a compiled target");
    error.statusCode = 422;
    throw error;
  }
  return {
    contract: selected.contract,
    artifactSha256: createHash("sha256").update(selected.bytecode).digest("hex"),
    plan: { ...selected.deploymentPlan, planSource: "developer-chat" },
  };
}

function emptyDeploymentPlan(target, rationale = "Deterministic zero-constructor fallback") {
  return { decision: "deploy", decisionReason: "deploy-ready", planSource: "deterministic-zero-arg-override", environment: "fresh-anvil", targetContract: target.contract, constructorArguments: [], transactionValueWei: "0", rationale, limitations: ["Disposable actor 0 is the local deployer; this does not select or approve a production deployer"] };
}

function validateConstructorPlan(target, deploymentPlan) {
  const args = Array.isArray(deploymentPlan.constructorArguments) ? deploymentPlan.constructorArguments : [];
  if (args.length !== target.constructorInputs.length) return { ok: false, error: `Constructor plan supplies ${args.length} argument(s), but ${target.contract} requires ${target.constructorInputs.length}` };
  for (const [index, input] of target.constructorInputs.entries()) {
    const arg = args[index];
    if (!arg || arg.position !== index || arg.name !== (input.name || "") || arg.solidityType !== input.type) {
      return { ok: false, error: `Constructor argument ${index} does not match compiled ABI ${input.type} ${input.name || ""}`.trim() };
    }
    const valueError = validateConstructorValue(input.type, arg.valueKind, arg.value);
    if (valueError) return { ok: false, error: `Constructor argument ${index}: ${valueError}` };
  }
  const transactionValueWei = String(deploymentPlan.transactionValueWei ?? "0");
  if (!/^\d+$/.test(transactionValueWei) || transactionValueWei.length > 21 || BigInt(transactionValueWei) > 100_000_000_000_000_000_000n) return { ok: false, error: "Deployment value must be a decimal wei amount no greater than 100 ETH" };
  const normalizedTransactionValueWei = BigInt(transactionValueWei).toString();
  if (normalizedTransactionValueWei !== "0" && target.constructorStateMutability !== "payable") return { ok: false, error: "A nonzero deployment value requires a payable constructor" };
  return { ok: true, plan: { ...deploymentPlan, transactionValueWei: normalizedTransactionValueWei } };
}

function validateConstructorValue(type, valueKind, value) {
  const text = typeof value === "string" ? value : "";
  if (valueKind === "anvil-account") {
    if (type !== "address") return "Anvil actor placeholders are allowed only for address values";
    if (!/^[0-3]$/.test(text)) return "Anvil actor index must be 0, 1, 2, or 3";
    return null;
  }
  if (valueKind !== "literal") return "Value kind must be literal or anvil-account";
  if (type === "address") return /^0x[0-9a-fA-F]{40}$/.test(text) ? null : "Address literal must contain exactly 20 bytes";
  const uintType = type.match(/^uint([0-9]{0,3})$/);
  if (uintType) {
    if (!/^\d+$/.test(text) || text.length > 78) return "Unsigned integer literal is invalid or too large";
    const width = uintType[1] ? Number(uintType[1]) : 256;
    if (width < 8 || width > 256 || width % 8 !== 0 || BigInt(text) >= (1n << BigInt(width))) return `${type} literal is outside its ABI range`;
    return null;
  }
  const intType = type.match(/^int([0-9]{0,3})$/);
  if (intType) {
    if (!/^-?\d+$/.test(text) || text.replace("-", "").length > 78) return "Signed integer literal is invalid or too large";
    const width = intType[1] ? Number(intType[1]) : 256;
    const number = BigInt(text);
    const limit = 1n << BigInt(width - 1);
    if (width < 8 || width > 256 || width % 8 !== 0 || number < -limit || number >= limit) return `${type} literal is outside its ABI range`;
    return null;
  }
  if (type === "bool") return /^(?:true|false)$/.test(text) ? null : "Boolean literal must be true or false";
  if (type === "string") return text.length <= 512 ? null : "String constructor literal exceeds 512 characters";
  if (type === "bytes") return /^0x(?:[0-9a-fA-F]{2})*$/.test(text) && text.length <= 1026 ? null : "Bytes literal must be bounded even-length hex";
  const fixedBytes = type.match(/^bytes([1-9]|[12][0-9]|3[0-2])$/);
  if (fixedBytes) return new RegExp(`^0x[0-9a-fA-F]{${Number(fixedBytes[1]) * 2}}$`).test(text) ? null : `${type} literal has the wrong length`;
  return `Constructor type ${type} is outside the MVP primitive-type allowlist`;
}

async function readBuildInfoDefinitions(jobDir) {
  const buildInfoDir = path.join(jobDir, "out", "build-info");
  let names;
  try { names = await readdir(buildInfoDir); } catch { return []; }
  const definitions = [];
  for (const name of names.filter((value) => value.endsWith(".json")).sort()) {
    try {
      const buildInfo = JSON.parse(await readFile(path.join(buildInfoDir, name), "utf8"));
      const nodes = buildInfo?.output?.sources?.["src/Target.sol"]?.ast?.nodes || [];
      definitions.push(...nodes.filter((node) => node.nodeType === "ContractDefinition"));
    } catch { /* Ignore incomplete build-info files and preserve safe ambiguity. */ }
  }
  return definitions;
}

export async function runFreshAnvilDeployment({ jobDir, anvilCommand = "anvil", castCommand = "cast", deploymentPlan = null, scenario = null, isCancelled = () => false }) {
  const target = await selectDeployableArtifact(jobDir, deploymentPlan);
  if (target.status !== "ready") return target;
  const validatedScenario = scenario ? validateAnvilScenario(target.abi, scenario) : null;
  if (scenario && !validatedScenario.ok) return { status: "failed", failureKind: "scenario-validation", reason: validatedScenario.error };
  throwIfDeploymentCancelled(isCancelled);
  const env = await isolatedToolEnvironment(jobDir);
  const port = await reservePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const child = registerChild(spawn(anvilCommand, ["--host", "127.0.0.1", "--port", String(port), "--chain-id", String(CHAIN_ID), "--accounts", "4", "--balance", "1000", "--mnemonic-random", "12", "--quiet"], {
    cwd: jobDir,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }));
  let processError = null;
  child.once("error", (error) => { processError = error; });
  child.stdout.resume();
  child.stderr.resume();
  try {
    await waitUntilReady(rpcUrl, child, () => processError, 10_000, isCancelled);
    await delay(25);
    throwIfDeploymentCancelled(isCancelled);
    assertChildRunning(child, processError);
    const chainId = await rpc(rpcUrl, "eth_chainId");
    assertChildRunning(child, processError);
    if (Number.parseInt(chainId, 16) !== CHAIN_ID) throw new Error("Fresh Anvil returned an unexpected chain id");
    const accounts = await rpc(rpcUrl, "eth_accounts");
    throwIfDeploymentCancelled(isCancelled);
    assertChildRunning(child, processError);
    if (!Array.isArray(accounts) || accounts.length < 4) throw new Error("Fresh Anvil did not expose the four required development actors");
    const constructorValues = target.deploymentPlan.constructorArguments.map((arg) => arg.valueKind === "anvil-account" ? accounts[Number(arg.value)] : arg.value);
    let deploymentData = target.bytecode;
    if (target.constructorInputs.length) {
      const signature = `constructor(${target.constructorInputs.map((input) => input.type).join(",")})`;
      const encoded = await runCommand(castCommand, ["abi-encode", signature, ...constructorValues], { cwd: jobDir, env, timeoutMs: 20_000, maxOutputBytes: 100_000 });
      throwIfDeploymentCancelled(isCancelled);
      const value = encoded.stdout.trim();
      if (encoded.exitCode !== 0 || !/^0x[0-9a-f]*$/i.test(value)) throw new Error(`Constructor ABI encoding failed: ${(encoded.stderr || encoded.error || "invalid cast output").slice(0, 240)}`);
      deploymentData += value.slice(2);
    }
    const transaction = { from: accounts[0], data: deploymentData, gas: "0xb71b00" };
    if (target.deploymentPlan.transactionValueWei !== "0") transaction.value = `0x${BigInt(target.deploymentPlan.transactionValueWei).toString(16)}`;
    const transactionHash = await rpc(rpcUrl, "eth_sendTransaction", [transaction]);
    throwIfDeploymentCancelled(isCancelled);
    assertChildRunning(child, processError);
    const receipt = await waitForReceipt(rpcUrl, transactionHash, 20_000, isCancelled);
    if (receipt.status !== "0x1" || !receipt.contractAddress) throw new Error("Local deployment reverted or returned no contract address");
    const code = await rpc(rpcUrl, "eth_getCode", [receipt.contractAddress, "latest"]);
    if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(code)) throw new Error("Local deployment receipt has no valid contract bytecode");
    assertChildRunning(child, processError);
    const observations = await collectStandardReadObservations({ target, rpcUrl, contractAddress: receipt.contractAddress, accounts, castCommand, jobDir, isCancelled });
    const scenarioResult = validatedScenario
      ? await executeValidatedScenario({ scenario: validatedScenario.scenario, target, rpcUrl, contractAddress: receipt.contractAddress, accounts, castCommand, jobDir, env, isCancelled })
      : null;
    const snapshotId = await rpc(rpcUrl, "evm_snapshot");
    return {
      status: "completed",
      environment: "fresh-anvil",
      chainId: CHAIN_ID,
      contract: target.contract,
      constructorArgumentCount: target.constructorInputs.length,
      deployer: accounts[0],
      deployerRole: "actor-0",
      actors: accounts.slice(0, 4),
      actorRoles: accounts.slice(0, 4).map((address, index) => ({ alias: `actor-${index}`, address })),
      observations,
      scenario: scenarioResult,
      deploymentReceipt: {
        status: receipt.status,
        blockNumber: Number.parseInt(receipt.blockNumber, 16),
        logs: (receipt.logs || []).map((log) => ({
          address: String(log.address || "").toLowerCase(),
          topics: Array.isArray(log.topics) ? log.topics.map((topic) => String(topic).toLowerCase()) : [],
          data: String(log.data || "").toLowerCase(),
          logIndex: log.logIndex ? Number.parseInt(log.logIndex, 16) : null,
        })),
      },
      effectiveDeploymentPlan: target.deploymentPlan,
      transactionHash,
      blockNumber: Number.parseInt(receipt.blockNumber, 16),
      contractAddress: receipt.contractAddress,
      codeSha256: deployedBytecodeSha256(code),
      snapshotCreated: Boolean(snapshotId),
      endpoint: "loopback-ephemeral-redacted",
    };
  } finally {
    await terminateChild(child);
  }
}

export function standardReadObservationSpecs(abi = []) {
  const functions = (Array.isArray(abi) ? abi : []).filter((item) => item?.type === "function" && ["view", "pure"].includes(item.stateMutability));
  const exact = (name, inputs, output) => functions.find((item) => item.name === name
    && JSON.stringify((item.inputs || []).map((input) => input.type)) === JSON.stringify(inputs)
    && item.outputs?.length === 1
    && item.outputs[0].type === output);
  const specs = [];
  if (exact("totalSupply", [], "uint256")) specs.push({ id: "total-supply", functionSignature: "totalSupply()", arguments: [], resultType: "uint256" });
  if (exact("balanceOf", ["address"], "uint256")) {
    specs.push({ id: "balance-actor-0", functionSignature: "balanceOf(address)", argumentActors: [0], resultType: "uint256" });
    specs.push({ id: "balance-actor-1", functionSignature: "balanceOf(address)", argumentActors: [1], resultType: "uint256" });
  }
  if (exact("owner", [], "address")) specs.push({ id: "owner", functionSignature: "owner()", arguments: [], resultType: "address" });
  return specs;
}

export function decodeObservationValue(value, type) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("Read-only observation returned a non-word ABI value");
  if (/^uint(?:[0-9]+)?$/.test(type)) return BigInt(value).toString();
  if (/^int(?:[0-9]+)?$/.test(type)) {
    const unsigned = BigInt(value);
    return (unsigned >= (1n << 255n) ? unsigned - (1n << 256n) : unsigned).toString();
  }
  if (type === "address") return `0x${value.slice(-40).toLowerCase()}`;
  if (type === "bool") return BigInt(value) === 0n ? "false" : "true";
  if (/^bytes(?:[1-9]|[12][0-9]|3[0-2])$/.test(type)) return `0x${value.slice(2, 2 + Number(type.slice(5)) * 2).toLowerCase()}`;
  throw new Error(`Read-only observation type ${type} is unsupported`);
}

async function collectStandardReadObservations({ target, rpcUrl, contractAddress, accounts, castCommand, jobDir, isCancelled }) {
  const observations = [];
  for (const spec of standardReadObservationSpecs(target.abi)) {
    throwIfDeploymentCancelled(isCancelled);
    const args = (spec.argumentActors || []).map((index) => accounts[index]);
    const encoded = await runCommand(castCommand, ["calldata", spec.functionSignature, ...args], { cwd: jobDir, env: await isolatedToolEnvironment(jobDir), timeoutMs: 20_000, maxOutputBytes: 100_000 });
    if (encoded.exitCode !== 0 || !/^0x[0-9a-fA-F]+$/.test(encoded.stdout.trim())) {
      observations.push({ ...spec, arguments: (spec.argumentActors || []).map((index) => `actor-${index}`), status: "failed", error: `Call encoding failed: ${(encoded.stderr || encoded.error || "invalid cast output").slice(0, 240)}` });
      continue;
    }
    try {
      const result = await rpc(rpcUrl, "eth_call", [{ to: contractAddress, data: encoded.stdout.trim() }, "latest"]);
      observations.push({ ...spec, arguments: (spec.argumentActors || []).map((index) => `actor-${index}`), status: "completed", value: decodeObservationValue(result, spec.resultType) });
    } catch (error) {
      observations.push({ ...spec, arguments: (spec.argumentActors || []).map((index) => `actor-${index}`), status: "failed", error: error.message.slice(0, 240) });
    }
  }
  return observations;
}

export function validateAnvilScenario(abi, value) {
  const functions = new Map((Array.isArray(abi) ? abi : [])
    .filter((item) => item?.type === "function" && ["external", "public"].includes(item.visibility || "external"))
    .map((item) => [`${item.name}(${(item.inputs || []).map((input) => input.type).join(",")})`, item]));
  const steps = [];
  const ids = new Set();
  for (const raw of Array.isArray(value?.steps) ? value.steps : []) {
    if (steps.length >= 24) return { ok: false, error: "Anvil scenarios are limited to 24 ABI steps" };
    const allowedKeys = new Set(["id", "actor", "functionSignature", "arguments", "valueWei", "expectedOutcome", "expectedReturn"]);
    if (!raw || Object.keys(raw).some((key) => !allowedKeys.has(key))) return { ok: false, error: "Anvil scenario steps may contain only typed ABI fields" };
    const id = String(raw?.id || "");
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id) || ids.has(id)) return { ok: false, error: "Every Anvil step needs a unique bounded id" };
    const fn = functions.get(String(raw.functionSignature || "").replace(/\s+/g, ""));
    if (!fn) return { ok: false, error: `Anvil step ${id} does not reference a compiled public ABI function` };
    if (!Number.isInteger(raw.actor) || raw.actor < 0 || raw.actor > 3) return { ok: false, error: `Anvil step ${id} actor must be 0 through 3` };
    if (!Array.isArray(raw.arguments) || raw.arguments.length !== (fn.inputs || []).length) return { ok: false, error: `Anvil step ${id} argument count does not match the compiled ABI` };
    const argumentsNormalized = [];
    for (const [index, input] of (fn.inputs || []).entries()) {
      const argument = raw.arguments[index];
      const error = validateConstructorValue(input.type, argument?.kind === "actor" ? "anvil-account" : argument?.kind, String(argument?.value ?? ""));
      if (error) return { ok: false, error: `Anvil step ${id} argument ${index}: ${error}` };
      argumentsNormalized.push({ kind: argument.kind, value: String(argument.value), solidityType: input.type });
    }
    const valueWei = String(raw.valueWei ?? "0");
    if (!/^\d{1,24}$/.test(valueWei) || BigInt(valueWei) > 100_000_000_000_000_000_000n) return { ok: false, error: `Anvil step ${id} value is outside the 100 ETH local-test limit` };
    const expectedOutcome = raw.expectedOutcome === "revert" ? "revert" : "success";
    if (BigInt(valueWei) !== 0n && fn.stateMutability !== "payable" && expectedOutcome !== "revert") {
      return { ok: false, error: `Anvil step ${id} sends value to a nonpayable function but expects success` };
    }
    const readOnly = ["view", "pure"].includes(fn.stateMutability);
    if (raw.expectedReturn != null && (!readOnly || fn.outputs?.length !== 1 || !isDecodableWordType(fn.outputs[0].type))) {
      return { ok: false, error: `Anvil step ${id} can compare a return value only for a one-word view result` };
    }
    ids.add(id);
    steps.push({
      id,
      actor: raw.actor,
      functionSignature: `${fn.name}(${(fn.inputs || []).map((input) => input.type).join(",")})`,
      arguments: argumentsNormalized,
      valueWei: BigInt(valueWei).toString(),
      expectedOutcome,
      expectedReturn: raw.expectedReturn == null ? null : String(raw.expectedReturn),
      readOnly,
      outputType: fn.outputs?.[0]?.type || null,
    });
  }
  return steps.length ? { ok: true, scenario: { steps } } : { ok: false, error: "Anvil scenario contains no executable ABI steps" };
}

async function executeValidatedScenario({ scenario, rpcUrl, contractAddress, accounts, castCommand, jobDir, env, isCancelled }) {
  const results = [];
  for (const step of scenario.steps) {
    throwIfDeploymentCancelled(isCancelled);
    const args = step.arguments.map((argument) => argument.kind === "actor" ? accounts[Number(argument.value)] : argument.value);
    const encoded = await runCommand(castCommand, ["calldata", step.functionSignature, ...args], { cwd: jobDir, env, timeoutMs: 20_000, maxOutputBytes: 100_000 });
    if (encoded.exitCode !== 0 || !/^0x[0-9a-fA-F]+$/.test(encoded.stdout.trim())) {
      results.push({ id: step.id, status: "failed", matchedExpectation: false, error: "ABI encoding failed" });
      continue;
    }
    const request = { from: accounts[step.actor], to: contractAddress, data: encoded.stdout.trim(), gas: "0xb71b00" };
    if (step.valueWei !== "0") request.value = `0x${BigInt(step.valueWei).toString(16)}`;
    try {
      if (step.readOnly) {
        const raw = await rpc(rpcUrl, "eth_call", [request, "latest"]);
        const decoded = step.outputType ? decodeObservationValue(raw, step.outputType) : null;
        const matchedExpectation = step.expectedOutcome === "success" && (step.expectedReturn == null || decoded === step.expectedReturn);
        results.push({ id: step.id, status: "completed", mode: "read", actor: `actor-${step.actor}`, functionSignature: step.functionSignature, rawResult: raw, decodedResult: decoded, expectedOutcome: step.expectedOutcome, expectedReturn: step.expectedReturn, matchedExpectation });
      } else {
        const transactionHash = await rpc(rpcUrl, "eth_sendTransaction", [request]);
        const receipt = await waitForReceipt(rpcUrl, transactionHash, 20_000, isCancelled);
        const succeeded = receipt.status === "0x1";
        const matchedExpectation = step.expectedOutcome === (succeeded ? "success" : "revert");
        results.push({ id: step.id, status: "completed", mode: "transaction", actor: `actor-${step.actor}`, functionSignature: step.functionSignature, transactionHash, receiptStatus: receipt.status, expectedOutcome: step.expectedOutcome, matchedExpectation, logs: (receipt.logs || []).length });
      }
    } catch (error) {
      const matchedExpectation = step.expectedOutcome === "revert";
      const errorText = String(error.message || error).slice(0, 500);
      const observedRevert = /revert|execution error|invalid opcode/i.test(errorText);
      results.push({ id: step.id, status: observedRevert ? "completed" : "failed", mode: step.readOnly ? "read" : "transaction", actor: `actor-${step.actor}`, functionSignature: step.functionSignature, expectedOutcome: step.expectedOutcome, matchedExpectation, error: errorText });
    }
  }
  const executionCompleted = results.every((item) => item.status === "completed");
  return {
    status: !executionCompleted ? "failed" : results.every((item) => item.matchedExpectation) ? "completed" : "property-failure",
    steps: results,
  };
}

function isDecodableWordType(type) {
  return /^(?:u?int(?:[0-9]+)?|address|bool|bytes(?:[1-9]|[12][0-9]|3[0-2]))$/.test(type);
}

async function isolatedToolEnvironment(jobDir) {
  const toolHome = path.join(jobDir, ".tool-home");
  await mkdir(toolHome, { recursive: true, mode: 0o700 });
  const env = {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: toolHome,
    XDG_CONFIG_HOME: path.join(toolHome, ".config"),
    XDG_CACHE_HOME: path.join(toolHome, ".cache"),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
  for (const name of ["SSL_CERT_FILE", "SSL_CERT_DIR"]) if (process.env[name]) env[name] = process.env[name];
  return env;
}

async function rpc(url, method, params = []) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(5_000),
  });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(`Anvil RPC ${method} failed: ${payload.error?.message || response.status}`);
  return payload.result;
}

async function waitUntilReady(url, child, getProcessError, timeoutMs, isCancelled) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfDeploymentCancelled(isCancelled);
    if (getProcessError()) throw new Error(`Anvil failed to start: ${getProcessError().message}`);
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Anvil exited before readiness (${child.exitCode ?? child.signalCode})`);
    try { await rpc(url, "eth_chainId"); return; } catch { await delay(100); }
  }
  throw new Error("Anvil readiness timed out");
}

function assertChildRunning(child, processError) {
  if (processError) throw new Error(`Anvil failed to start: ${processError.message}`);
  if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Fresh Anvil process exited unexpectedly (${child.exitCode ?? child.signalCode})`);
}

async function waitForReceipt(url, hash, timeoutMs, isCancelled) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfDeploymentCancelled(isCancelled);
    const receipt = await rpc(url, "eth_getTransactionReceipt", [hash]);
    if (receipt) return receipt;
    await delay(100);
  }
  throw new Error("Local deployment receipt timed out");
}

function throwIfDeploymentCancelled(isCancelled) {
  if (!isCancelled()) return;
  const error = new Error("Fresh Anvil deployment cancelled by user");
  error.code = "AUDIT_CANCELLED";
  throw error;
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export function deployedBytecodeSha256(code) {
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(code)) throw new Error("Deployed bytecode must be nonempty even-length hex");
  return createHash("sha256").update(Buffer.from(code.slice(2), "hex")).digest("hex");
}
