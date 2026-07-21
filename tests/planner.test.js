import test from "node:test";
import assert from "node:assert/strict";
import { buildBaselineSuite, profileContract } from "../src/server/planner.js";

test("profiles an external-calling vault and plans pertinent vectors", () => {
  const source = `
    contract Vault {
      function deposit(uint256 assets) external returns (uint256) {}
      function withdraw(uint256 assets) external returns (uint256) {
        (bool ok,) = msg.sender.call{value: assets}("");
      }
      function redeem(uint256 shares) external returns (uint256) {}
      function totalAssets() external view returns (uint256) {}
    }
  `;
  const profile = profileContract(source);
  assert.ok(profile.archetypes.includes("erc4626-vault"));
  assert.equal(profile.externalInteractions, true);
  const ids = buildBaselineSuite(profile).map((plan) => plan.id);
  assert.ok(ids.includes("VAULT-01"));
  assert.ok(ids.includes("EXT-01"));
});

test("profiles memecoin-relevant token signals without treating them as proof", () => {
  const profile = profileContract("contract Token { function transfer(address,uint256) external {} function approve(address,uint256) external {} }");
  assert.ok(profile.archetypes.includes("erc20-token"));
  assert.match(profile.analysisBasis, /deterministic source signals/);
  const suite = buildBaselineSuite(profile);
  const obligations = suite.filter((plan) => ["local", "fuzz", "invariant"].includes(plan.environment)).flatMap((plan) => plan.recommendedScenarios);
  assert.equal(obligations.length, 16);
  assert.ok(obligations.every((item) => /^\w+(?:-\w+)*-S\d{2}$/.test(item.id)));
  assert.ok(obligations.some((item) => item.title === "allowance transitions"));
});

test("declared memecoin intent creates tokenomics and swap-back attack suites", () => {
  const profile = profileContract("contract Token { function transfer(address,uint256) external {} }");
  profile.archetypes.unshift("memecoin");
  const ids = buildBaselineSuite(profile, { trustedRoles: "owner multisig is trusted" }).map((plan) => plan.id);
  assert.ok(ids.includes("MEME-FEE-01"));
  assert.ok(ids.includes("MEME-SWAP-01"));
  assert.ok(ids.includes("MEME-LAUNCH-01"));
  assert.ok(ids.includes("TRUST-01"));
});

test("comments and generic deposit/withdraw names do not imply ERC-4626", () => {
  const profile = profileContract("// ERC4626 previewDeposit totalAssets\ncontract Vault { function deposit() external {} function withdraw() external {} }");
  assert.equal(profile.archetypes.includes("erc4626-vault"), false);
});
