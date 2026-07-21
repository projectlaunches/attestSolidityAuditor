const PRESETS = {
  smoke: { generatedTestBudget: 3, fuzzRuns: 256, invariantRuns: 32, invariantDepth: 32, timeoutMinutes: 10 },
  deep: { generatedTestBudget: 25, fuzzRuns: 10_000, invariantRuns: 256, invariantDepth: 128, timeoutMinutes: 120 },
};

const RUNNABLE_ENVIRONMENTS = new Set(["local", "fuzz", "invariant"]);

export function normalizeTestCampaign(input = {}) {
  const mode = input?.mode ?? "recommended";
  if (!["smoke", "recommended", "deep", "custom"].includes(mode)) throw new Error("Unknown test campaign mode");
  if (mode !== "custom") return { mode, ...(PRESETS[mode] || { fuzzRuns: 1_000, invariantRuns: 128, invariantDepth: 64, timeoutMinutes: 45 }) };
  return {
    mode,
    generatedTestBudget: boundedInteger(input.generatedTestBudget, 1, 50, "Generated test budget"),
    fuzzRuns: boundedInteger(input.fuzzRuns, 1, 100_000, "Fuzz runs"),
    invariantRuns: boundedInteger(input.invariantRuns ?? 128, 1, 10_000, "Invariant runs"),
    invariantDepth: boundedInteger(input.invariantDepth ?? 64, 1, 1_000, "Invariant depth"),
    timeoutMinutes: boundedInteger(input.timeoutMinutes, 1, 120, "Campaign timeout"),
  };
}

export function resolveTestCampaign(campaign, suitePlan) {
  const executable = suitePlan
    .filter((item) => RUNNABLE_ENVIRONMENTS.has(item.environment) && item.preferredTools?.includes("forge"))
    .sort((a, b) => priority(a.priority) - priority(b.priority));
  const selected = campaign.mode === "smoke" ? executable.slice(0, 3) : executable;
  const obligations = selected.flatMap((item) => item.recommendedScenarios || []);
  const scenarioDrivenBudget = obligations.length;
  const generatedTestBudget = campaign.mode === "recommended"
    ? Math.min(25, scenarioDrivenBudget)
    : campaign.generatedTestBudget;
  return {
    ...campaign,
    generatedTestBudget,
    recommendationBasis: campaign.mode === "recommended" ? "sum of scenario groups for runnable contract-specific vectors" : "fixed campaign preset",
    recommendedProperties: scenarioDrivenBudget,
    selectedObligationIds: obligations.slice(0, generatedTestBudget).map((item) => item.id),
    omittedObligationIds: obligations.slice(generatedTestBudget).map((item) => item.id),
    selectedSuiteIds: selected.map((item) => item.id),
    plansReturned: 0,
    duplicatePlansRejected: 0,
    plansAccepted: 0,
    executed: 0,
    passed: 0,
    awaitingOracle: 0,
    rejected: 0,
    failed: 0,
    timedOut: 0,
    budgetExhausted: false,
    plansTruncated: 0,
  };
}

function boundedInteger(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer from ${min} to ${max}`);
  return value;
}

function priority(value) {
  return { critical: 0, high: 1, medium: 2, low: 3 }[value] ?? 4;
}
