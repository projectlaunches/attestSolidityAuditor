import { createHash } from "node:crypto";

export const AUDIT_CONTROLLER_VERSION = "attest-audit-controller-v1";
export const AUDIT_DEPTHS = new Set(["review", "targeted", "full"]);
export const EXECUTABLE_OPERATION_KINDS = new Set([
  "slither",
  "aderyn",
  "compiler-matrix",
  "foundry",
  "anvil-deployment",
  "anvil-scenario",
  "fork",
]);

const DETECTOR_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const FUNCTION_SIGNATURE = /^[A-Za-z_$][A-Za-z0-9_$]*\((?:[A-Za-z0-9_$\[\], ]{0,500})\)$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export const AUDIT_CONTROLLER_DECISION_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["continue", "conclude", "blocked", "needs-input"] },
    assessment: { type: "string", maxLength: 30000 },
    operations: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          id: { type: "string", maxLength: 128 },
          kind: { type: "string", enum: [...EXECUTABLE_OPERATION_KINDS] },
          questionId: { type: "string", maxLength: 128 },
          objective: { type: "string", maxLength: 2000 },
          rationale: { type: "string", maxLength: 3000 },
          slitherDetectors: { type: "array", maxItems: 12, items: { type: "string", maxLength: 80 } },
          aderynSeverity: { type: "string", enum: ["all", "high"] },
          compilerVersions: { type: "array", maxItems: 6, items: { type: "string", maxLength: 16 } },
          networkId: { type: "string", enum: ["ethereum", "base", "bnb"] },
          scenario: {
            type: "object",
            properties: {
              steps: {
                type: "array",
                minItems: 1,
                maxItems: 24,
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", maxLength: 128 },
                    actor: { type: "integer", minimum: 0, maximum: 3 },
                    functionSignature: { type: "string", maxLength: 512 },
                    arguments: {
                      type: "array",
                      maxItems: 32,
                      items: {
                        type: "object",
                        properties: {
                          kind: { type: "string", enum: ["literal", "actor"] },
                          value: { type: "string", maxLength: 1026 },
                        },
                        required: ["kind", "value"],
                        additionalProperties: false,
                      },
                    },
                    valueWei: { type: "string", maxLength: 24 },
                    expectedOutcome: { type: "string", enum: ["success", "revert"] },
                    expectedReturn: { type: ["string", "null"], maxLength: 1026 },
                  },
                  required: ["id", "actor", "functionSignature", "arguments", "valueWei", "expectedOutcome", "expectedReturn"],
                  additionalProperties: false,
                },
              },
            },
            required: ["steps"],
            additionalProperties: false,
          },
        },
        required: ["id", "kind", "questionId", "objective", "rationale", "slitherDetectors", "aderynSeverity", "compilerVersions", "networkId", "scenario"],
        additionalProperties: false,
      },
    },
    coverageUpdates: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...EXECUTABLE_OPERATION_KINDS] },
          status: { type: "string", enum: ["inapplicable"] },
          reason: { type: "string", maxLength: 2000 },
        },
        required: ["kind", "status", "reason"],
        additionalProperties: false,
      },
    },
    requestedInput: { type: "string", maxLength: 3000 },
  },
  required: ["status", "assessment", "operations", "coverageUpdates", "requestedInput"],
  additionalProperties: false,
};

export function normalizeAuditDepth(value) {
  const depth = String(value || "targeted").trim().toLowerCase();
  if (!AUDIT_DEPTHS.has(depth)) throw new Error("Audit depth must be review, targeted, or full");
  return depth;
}

export function controllerCapabilityCatalog(capabilities, permissions = {}) {
  const tools = new Map((capabilities?.analyzers || []).map((tool) => [tool.id, tool]));
  const available = (id) => Boolean(tools.get(id)?.available);
  return [
    capability("slither", available("slither"), true, "Focused or complete static analysis"),
    capability("aderyn", available("aderyn"), true, "Independent full-project static analysis"),
    capability("compiler-matrix", available("forge"), Boolean(permissions.localExecution), "Offline compilation using requested installed Solidity versions"),
    capability("foundry", available("forge"), Boolean(permissions.localExecution), "Disposable unit, fuzz, and invariant harnesses"),
    capability("anvil-deployment", available("anvil") && available("forge"), Boolean(permissions.anvil), "Deploy the compiled target to a disposable loopback chain and verify its artifact"),
    capability("anvil-scenario", available("anvil") && available("forge"), Boolean(permissions.anvil), "Typed ABI calls on a disposable loopback chain"),
    capability("fork", available("forge"), Boolean(permissions.forks), "Foundry execution against a server-selected pinned public-chain fork"),
  ];
}

function capability(kind, installed, authorized, description) {
  return { kind, installed, authorized, executable: installed && authorized, description };
}

export function normalizeControllerDecision(raw, context = {}) {
  const status = ["continue", "conclude", "blocked", "needs-input"].includes(raw?.status) ? raw.status : "blocked";
  const assessment = boundedText(raw?.assessment, 30000, "No controller assessment was returned");
  const requestedInput = boundedText(raw?.requestedInput, 3000, "");
  const knownQuestionIds = new Set(context.questionIds || []);
  const seen = new Set(context.priorSpecDigests || []);
  const retryable = new Set(context.retryableSpecDigests || []);
  const retried = new Set();
  const seenOperationIds = new Set(context.priorOperationIds || []);
  const serverApprovedInapplicable = new Set(context.serverApprovedInapplicableKinds || []);
  const operations = [];
  const coverageUpdates = [...new Map((Array.isArray(raw?.coverageUpdates) ? raw.coverageUpdates : [])
    .filter((item) => serverApprovedInapplicable.has(item?.kind) && item.status === "inapplicable" && boundedText(item.reason, 2000, ""))
    .map((item) => [item.kind, { kind: item.kind, status: "inapplicable", reason: boundedText(item.reason, 2000, "") }])).values()];
  for (const value of Array.isArray(raw?.operations) ? raw.operations : []) {
    if (operations.length >= 4) break;
    const operation = normalizeOperation(value, knownQuestionIds);
    if (!operation || seenOperationIds.has(operation.id)) continue;
    const specDigest = operationSpecDigest(operation, context.sourceHash);
    if (seen.has(specDigest) && (!retryable.has(specDigest) || retried.has(specDigest))) continue;
    if (seen.has(specDigest)) retried.add(specDigest);
    seen.add(specDigest);
    seenOperationIds.add(operation.id);
    operations.push({ ...operation, specDigest });
  }
  if (status === "continue" && operations.length === 0) {
    return { status: "blocked", assessment: `${assessment} No new valid operation was proposed.`, operations: [], coverageUpdates, requestedInput };
  }
  if (status === "needs-input" && !requestedInput) {
    return {
      status: "blocked",
      assessment: `${assessment} The AI auditor did not identify a specific developer input, so the audit cannot enter an opaque awaiting-input state.`,
      operations: [],
      coverageUpdates,
      requestedInput: "",
    };
  }
  if (status !== "continue") return { status, assessment, operations: [], coverageUpdates, requestedInput };
  return { status, assessment, operations, coverageUpdates, requestedInput };
}

function normalizeOperation(value, knownQuestionIds) {
  if (!value || !EXECUTABLE_OPERATION_KINDS.has(value.kind)) return null;
  const allowedKeys = new Set(["id", "kind", "questionId", "objective", "rationale", "slitherDetectors", "aderynSeverity", "compilerVersions", "networkId", "scenario"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return null;
  const id = String(value.id || "").trim();
  const questionId = String(value.questionId || "").trim();
  if (!SAFE_ID.test(id) || !knownQuestionIds.has(questionId)) return null;
  const base = {
    id,
    kind: value.kind,
    questionId,
    objective: boundedText(value.objective, 2000, ""),
    rationale: boundedText(value.rationale, 3000, ""),
    slitherDetectors: [],
    aderynSeverity: "all",
    compilerVersions: [],
    networkId: "",
    scenario: null,
  };
  if (!base.objective || !base.rationale) return null;
  if (value.kind === "slither") {
    base.slitherDetectors = [...new Set((value.slitherDetectors || []).map(String).filter((item) => DETECTOR_ID.test(item)))].slice(0, 12);
  } else if (value.kind === "aderyn") {
    base.aderynSeverity = value.aderynSeverity === "high" ? "high" : "all";
  } else if (value.kind === "compiler-matrix") {
    base.compilerVersions = [...new Set((value.compilerVersions || []).map(String).filter((item) => SEMVER.test(item)))].slice(0, 6);
    if (!base.compilerVersions.length) return null;
  } else if (value.kind === "fork") {
    if (!["ethereum", "base", "bnb"].includes(value.networkId)) return null;
    base.networkId = value.networkId;
  } else if (value.kind === "anvil-scenario") {
    base.scenario = normalizeScenario(value.scenario);
    if (!base.scenario) return null;
  }
  return base;
}

function normalizeScenario(value) {
  const steps = [];
  const seen = new Set();
  for (const raw of Array.isArray(value?.steps) ? value.steps : []) {
    if (steps.length >= 24) break;
    const allowedStepKeys = new Set(["id", "actor", "functionSignature", "arguments", "valueWei", "expectedOutcome", "expectedReturn"]);
    if (!raw || Object.keys(raw).some((key) => !allowedStepKeys.has(key))) return null;
    const id = String(raw?.id || "").trim();
    const signature = String(raw?.functionSignature || "").trim();
    const actor = Number(raw?.actor);
    const valueWei = String(raw?.valueWei ?? "0");
    if (!SAFE_ID.test(id) || seen.has(id) || !Number.isInteger(actor) || actor < 0 || actor > 3 || !FUNCTION_SIGNATURE.test(signature)) return null;
    if (!/^\d{1,24}$/.test(valueWei) || BigInt(valueWei) > 100_000_000_000_000_000_000n) return null;
    const args = [];
    for (const arg of Array.isArray(raw.arguments) ? raw.arguments : []) {
      const kind = arg?.kind;
      const argumentValue = String(arg?.value ?? "");
      if (kind === "actor") {
        if (!/^[0-3]$/.test(argumentValue)) return null;
      } else if (kind === "literal") {
        if (argumentValue.length > 1026 || /(?:https?:\/\/|private\s*key|mnemonic|seed\s*phrase)/i.test(argumentValue)) return null;
      } else return null;
      args.push({ kind, value: argumentValue });
      if (args.length > 32) return null;
    }
    seen.add(id);
    steps.push({
      id,
      actor,
      functionSignature: signature.replace(/\s+/g, ""),
      arguments: args,
      valueWei: BigInt(valueWei).toString(),
      expectedOutcome: raw.expectedOutcome === "revert" ? "revert" : "success",
      expectedReturn: raw.expectedReturn == null ? null : boundedText(raw.expectedReturn, 1026, null),
    });
  }
  return steps.length ? { steps } : null;
}

export function operationSpecDigest(operation, sourceHash = "") {
  const executionSpec = {
    controller: AUDIT_CONTROLLER_VERSION,
    sourceHash: String(sourceHash || ""),
    kind: operation.kind,
    questionId: operation.questionId,
    slitherDetectors: operation.slitherDetectors || [],
    aderynSeverity: operation.aderynSeverity || "all",
    compilerVersions: operation.compilerVersions || [],
    networkId: operation.networkId || "",
    scenario: operation.scenario || null,
  };
  return createHash("sha256").update(JSON.stringify(executionSpec)).digest("hex");
}

function boundedText(value, max, fallback) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, max) : fallback;
}

export function fullCoverageObligations(catalog, applicability = {}) {
  return (catalog || []).map((item) => ({
    kind: item.kind,
    required: true,
    applicable: applicability[item.kind]?.applicable !== false,
    status: applicability[item.kind]?.applicable === false ? "inapplicable" : item.executable ? "pending" : item.installed ? "not-authorized" : "unavailable",
    reason: applicability[item.kind]?.applicable === false
      ? applicability[item.kind].reason
      : item.executable ? "Full-suite coverage has not run yet" : item.installed ? "The user did not authorize this execution class" : "The required local tool is unavailable",
  }));
}

export function operationEvidenceRecord({ job, operation, status, toolRunIds = [], evidenceDigest = null, blocker = null }) {
  return Object.freeze({
    operationId: operation.id,
    kind: operation.kind,
    registryVersion: AUDIT_CONTROLLER_VERSION,
    specDigest: operation.specDigest,
    questionId: operation.questionId,
    sourceHash: job.sourceHash,
    evidenceRevision: job.evidenceRevision,
    status,
    toolRunIds: [...toolRunIds],
    evidenceDigest,
    blocker,
  });
}
