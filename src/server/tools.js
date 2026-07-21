import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import { commandVersion } from "./command.js";

const DEFINITIONS = [
  { id: "forge", label: "Foundry", command: "forge", tier: "MVP", role: "Compile and execute tests" },
  { id: "anvil", label: "Anvil", command: "anvil", tier: "Environment", role: "Local and forked chain execution" },
  { id: "solc", label: "solc / SMTChecker", command: "solc", tier: "Next", role: "Compiler matrix and formal diagnostics" },
  { id: "slither", label: "Slither", command: "slither", tier: "MVP", role: "Primary static analyzer" },
  { id: "aderyn", label: "Aderyn", command: "aderyn", tier: "MVP", role: "Independent static analyzer" },
  { id: "solhint", label: "Solhint", command: "solhint", tier: "Quality", role: "Fast lint and best-practice checks" },
  { id: "wake", label: "Wake", command: "wake", tier: "Optional", role: "Independent static and fuzz framework" },
  { id: "mythril", label: "Mythril", command: "myth", tier: "Next", role: "Bounded symbolic analysis" },
  { id: "echidna", label: "Echidna", command: "echidna", tier: "Harness", role: "Stateful property fuzzing" },
  { id: "medusa", label: "Medusa", command: "medusa", tier: "Alternative", role: "Parallel stateful fuzzing" },
  { id: "halmos", label: "Halmos", command: "halmos", tier: "Harness", role: "Symbolic property testing" },
];

const ADERYN_BINARY_SHA256 = "a268d616826901e17717b1bc6368d8b2c063045a46fb99a0c0f657f102d977ca";

export async function probeTools(projectRoot) {
  const localAderyn = path.join(projectRoot, "work", "tools", "aderyn", "0.6.8", "aderyn");
  const localSolhint = path.join(projectRoot, "node_modules", ".bin", process.platform === "win32" ? "solhint.cmd" : "solhint");
  let aderynCommand = null;
  let solhintCommand = null;
  let pinnedSolhintVersion = null;
  try {
    await access(localAderyn, constants.X_OK);
    const digest = createHash("sha256").update(await readFile(localAderyn)).digest("hex");
    if (digest === ADERYN_BINARY_SHA256) aderynCommand = localAderyn;
  } catch {
    // Only the project-local checksum-pinned binary is accepted.
  }
  try {
    await access(localSolhint, constants.X_OK);
    const manifest = JSON.parse(await readFile(path.join(projectRoot, "node_modules", "solhint-community", "package.json"), "utf8"));
    const expectedEntry = path.join(projectRoot, "node_modules", "solhint-community", "solhint.js");
    if (manifest.name === "solhint-community" && manifest.version === "4.0.1" && await realpath(localSolhint) === await realpath(expectedEntry)) {
      solhintCommand = localSolhint;
      pinnedSolhintVersion = manifest.version;
    }
  } catch {
    // Only the exact project-lock installation is accepted.
  }
  const results = await Promise.all(DEFINITIONS.map(async (definition) => {
    const command = definition.id === "aderyn" ? aderynCommand : definition.id === "solhint" ? solhintCommand : definition.command;
    if (!command) return { ...definition, command: null, available: false, version: null, error: `verified project-local ${definition.label} is unavailable` };
    const probe = await commandVersion(command, definition.id === "solhint" && pinnedSolhintVersion ? ["--help"] : ["--version"]);
    if (definition.id === "solhint" && probe.available && pinnedSolhintVersion) probe.version = pinnedSolhintVersion;
    const integrity = definition.id === "aderyn" ? "sha256-verified" : definition.id === "solhint" ? "project-lock" : undefined;
    return { ...definition, ...probe, integrity };
  }));

  const bundledCodex = path.join(projectRoot, "node_modules", ".bin", process.platform === "win32" ? "codex.cmd" : "codex");
  let codexCommand = process.env.CODEX_BIN || bundledCodex;
  try {
    await access(codexCommand, constants.X_OK);
  } catch {
    codexCommand = "codex";
  }
  const codex = await commandVersion(codexCommand);

  return {
    analyzers: results,
    codex: { ...codex, label: "Codex app-server", role: "ChatGPT sign-in and AI review" },
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      wsl: Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP || /microsoft|wsl/i.test(os.release())),
    },
  };
}

export function getToolDefinition(id) {
  return DEFINITIONS.find((tool) => tool.id === id);
}
