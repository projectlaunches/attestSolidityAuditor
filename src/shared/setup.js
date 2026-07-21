export function capabilityFor(data, id) {
  if (id === "codex") return data?.codex || null;
  return data?.analyzers?.find((tool) => tool.id === id) || null;
}

export function capabilityStatus(data, id) {
  if (id === "node") {
    const version = data?.runtime?.node;
    if (!version) return { available: false, text: "Not detected" };
    const major = Number.parseInt(String(version).replace(/^v/, "").split(".")[0], 10);
    return Number.isInteger(major) && major >= 22
      ? { available: true, text: `Installed — ${version}` }
      : { available: false, text: `Upgrade required — ${version} detected; Node 22+ is required` };
  }
  if (id === "wsl") {
    return data?.runtime?.wsl
      ? { available: true, text: "Running inside WSL" }
      : { available: false, text: "WSL not detected by this process" };
  }
  const tool = capabilityFor(data, id);
  return tool?.available
    ? { available: true, text: `Installed — ${tool.version || "version unavailable"}` }
    : { available: false, text: "Missing or not verified" };
}

export function coreCoverage(data) {
  const ids = ["forge", "anvil", "slither", "aderyn", "solhint"];
  const installed = ids.filter((id) => capabilityStatus(data, id).available).length;
  return { installed, total: ids.length };
}
