import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTestCampaign, resolveTestCampaign } from "../src/server/campaign.js";

test("recommended campaigns select runnable Forge vectors and size the plan budget", () => {
  const campaign = resolveTestCampaign(normalizeTestCampaign(), [
    { id: "FORK", priority: "critical", environment: "fork", preferredTools: ["forge", "anvil"] },
    { id: "FUZZ", priority: "high", environment: "fuzz", preferredTools: ["forge"], recommendedScenarios: [{ id: "F-1" }, { id: "F-2" }, { id: "F-3" }] },
    { id: "LOCAL", priority: "critical", environment: "local", preferredTools: ["forge"], recommendedScenarios: [{ id: "L-1" }, { id: "L-2" }] },
  ]);
  assert.deepEqual(campaign.selectedSuiteIds, ["LOCAL", "FUZZ"]);
  assert.equal(campaign.recommendedProperties, 5);
  assert.equal(campaign.generatedTestBudget, 5);
  assert.deepEqual(campaign.selectedObligationIds, ["L-1", "L-2", "F-1", "F-2", "F-3"]);
  assert.equal(campaign.omittedObligationIds.length, 0);
  assert.equal(campaign.fuzzRuns, 1_000);
});

test("recommended campaigns disclose property obligations omitted by the property-check ceiling", () => {
  const scenarios = Array.from({ length: 30 }, (_, index) => ({ id: `P-${index + 1}` }));
  const campaign = resolveTestCampaign(normalizeTestCampaign(), [
    { id: "LARGE", priority: "critical", environment: "local", preferredTools: ["forge"], recommendedScenarios: scenarios },
  ]);
  assert.equal(campaign.recommendedProperties, 30);
  assert.equal(campaign.generatedTestBudget, 25);
  assert.equal(campaign.selectedObligationIds.length, 25);
  assert.equal(campaign.omittedObligationIds.length, 5);
});

test("custom campaigns support high case counts but enforce server ceilings", () => {
  const custom = normalizeTestCampaign({ mode: "custom", generatedTestBudget: 50, fuzzRuns: 100_000, invariantRuns: 5_000, invariantDepth: 500, timeoutMinutes: 120 });
  assert.equal(custom.generatedTestBudget, 50);
  assert.throws(() => normalizeTestCampaign({ mode: "custom", generatedTestBudget: 51, fuzzRuns: 1, timeoutMinutes: 1 }), /1 to 50/);
  assert.throws(() => normalizeTestCampaign({ mode: "custom", generatedTestBudget: 10, fuzzRuns: "100", timeoutMinutes: 1 }), /Fuzz runs/);
});
