const ARCHETYPES = [
  ["erc4626-vault", /\b(?:ERC4626|totalAssets|convertToShares|convertToAssets|previewDeposit|previewRedeem)\b/i],
  ["erc20-token", /\b(?:transfer|transferFrom|approve|allowance|totalSupply)\s*\(/i],
  ["erc721-nft", /\b(?:ownerOf|safeTransferFrom|tokenURI)\s*\(/i],
  ["proxy-upgradeable", /\b(?:delegatecall|upgradeTo|implementation|proxiableUUID)\b/i],
  ["governance", /\b(?:propose|castVote|quorum|timelock|executeProposal)\b/i],
  ["staking-rewards", /\b(?:stake|unstake|earned|rewardPerToken|claimReward)\b/i],
  ["amm-dex", /\b(?:swap|reserve0|reserve1|getAmountOut|flash)\b/i],
  ["oracle-consumer", /\b(?:latestRoundData|priceFeed|oracle|twap)\b/i],
  ["bridge-messaging", /\b(?:bridge|relayMessage|messageHash|sourceChain|destinationChain)\b/i],
];

const SCENARIO_OBLIGATIONS = {
  "AUTH-01": ["caller model baseline", "unauthorized caller rejection", "zero-address role boundary", "revoked-role rejection", "role transfer and stale authority"],
  "STATE-01": ["valid transition order", "invalid transition order", "repeated action", "partial failure and recovery"],
  "BOUND-01": ["zero and one", "maximum numeric value", "empty input", "duplicate input", "invalid address and rounding edge"],
  "COMP-01": [],
  "EXT-01": ["reentrancy callback", "callee revert", "no-return and false-return token", "callback ordering", "gas griefing", "failure recovery"],
  "ERC20-01": ["total-supply conservation", "balance-sum conservation", "allowance transitions", "transfer boundaries", "maximum allowance", "non-standard token interaction"],
  "MEME-FEE-01": ["buy fee accounting", "sell fee accounting", "wallet transfer fee", "exemption transitions", "fee and supply conservation", "declared tokenomics limits"],
  "MEME-SWAP-01": ["swap threshold boundary", "thin-pool execution", "deep-pool execution", "zero-minimum-output exposure", "price impact and sandwich", "router failure", "stuck-fund recovery", "repeated swap-back"],
  "MEME-LAUNCH-01": ["trading enablement", "max transaction", "max wallet", "cooldown and block limits", "blacklist or pause authority", "fee and exemption changes", "ownership transfer and renunciation"],
  "VAULT-01": ["first depositor", "donation inflation", "rounding direction", "preview and action consistency", "exchange-rate monotonicity", "loss realization"],
  "UPGRADE-01": ["initializer replay", "implementation takeover", "proxy admin isolation", "storage layout compatibility", "upgrade rollback", "unauthorized upgrade"],
  "ORACLE-01": ["stale price", "zero price", "negative price", "decimal mismatch", "sequencer downtime", "update race", "spot-price manipulation"],
  "GOV-01": ["quorum boundary", "double voting", "delegation snapshot", "timelock order", "cancellation", "flash-loan voting", "execution replay"],
  "AMM-01": ["reserve invariant", "fee rounding", "sandwich condition", "flash-liquidity condition", "callback reentrancy", "token incompatibility"],
  "BRIDGE-01": ["domain separation", "duplicate message", "reordered message", "signer threshold change", "source-chain spoofing", "finality assumption"],
  "SIG-01": ["signature malleability", "expired deadline", "nonce reuse", "wrong chain domain", "wrong contract domain", "zero signer", "ERC-1271 behavior"],
  "TRUST-01": ["compromised key", "mistaken privileged call", "role transfer", "multisig or timelock boundary", "emergency recovery", "authority renunciation"],
};

export function profileContract(source) {
  const code = stripComments(source);
  const archetypes = ARCHETYPES.filter(([, pattern]) => pattern.test(code)).map(([name]) => name);
  if (!archetypes.length) archetypes.push("custom-contract");
  const signals = [];
  if (/\.call\s*\{|\.call\s*\(|\.send\s*\(|\.transfer\s*\(/.test(code)) signals.push("native-value-external-call");
  if (/\bdelegatecall\b/.test(code)) signals.push("delegatecall");
  if (/\b(?:onlyOwner|onlyRole|AccessControl|Ownable)\b/.test(code)) signals.push("privileged-access-control");
  if (/\b(?:block\.timestamp|block\.number|blockhash)\b/.test(code)) signals.push("block-context-dependency");
  if (/\b(?:ecrecover|permit|signature|nonce)\b/i.test(code)) signals.push("signature-validation");
  if (/\bselfdestruct\b/.test(code)) signals.push("selfdestruct");

  return {
    archetypes,
    signals,
    externalInteractions: /\b(?:call|delegatecall|staticcall|transferFrom|safeTransferFrom)\b/.test(code),
    upgradeable: archetypes.includes("proxy-upgradeable"),
    analysisBasis: "deterministic source signals; Codex may refine this profile",
  };
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
}

export function buildBaselineSuite(profile, declaredContext = {}) {
  const plans = [
    plan("AUTH-01", "Authorization and role boundaries", "Prove every privileged transition rejects unauthorized, zero-address, revoked, and stale-role callers.", "local", "critical", ["forge", "slither"], profile.signals.includes("privileged-access-control") ? 5 : 1),
    plan("STATE-01", "State-machine ordering", "Exercise valid and invalid action order, repeated actions, partial failure, and recovery paths.", "invariant", "high", ["forge", "echidna"], 4),
    plan("BOUND-01", "Boundary and malformed inputs", "Cover zero, one, maximum values, empty arrays, duplicate elements, invalid addresses, and rounding edges.", "fuzz", "high", ["forge"], 5),
    plan("COMP-01", "Compiler and configuration matrix", "Compile exact declared settings and a capped compatible-version matrix; compare diagnostics and bytecode hashes.", "compile-matrix", "medium", ["forge", "solc"], 0),
  ];

  if (profile.externalInteractions) {
    plans.push(plan("EXT-01", "Adversarial external-call behavior", "Test reentrancy, revert/no-return/false-return tokens, callback ordering, gas griefing, and failure recovery.", "anvil", "critical", ["forge", "anvil", "slither"], 6));
  }
  if (profile.archetypes.includes("erc20-token")) {
    plans.push(plan("ERC20-01", "Token conservation and allowance invariants", "Check supply conservation, balance sums, allowance transitions, transfer edge cases, and non-standard token interactions.", "invariant", "high", ["forge", "echidna"], 6));
  }
  if (profile.archetypes.includes("memecoin")) {
    plans.push(
      plan("MEME-FEE-01", "Fee, exemption, and supply accounting", "Fuzz buy/sell/transfer paths across exempt and non-exempt actors; prove total fees, balances, and supply transitions match declared tokenomics.", "invariant", "critical", ["forge", "echidna"], 6),
      plan("MEME-SWAP-01", "Swap-back liquidity, slippage, and MEV", "Test swap thresholds, thin/deep pools, zero minimum output, price impact, sandwichability, router failure, stuck funds, and recovery behavior.", "fork", "critical", ["forge", "anvil"], 8),
      plan("MEME-LAUNCH-01", "Launch limits and privileged transitions", "Test trading enablement, max wallet/transaction rules, cooldowns, blacklist/pause powers, fee caps, exemption changes, and ownership transfer/renunciation.", "anvil", "high", ["forge", "anvil"], 7),
    );
  }
  if (profile.archetypes.includes("erc4626-vault")) {
    plans.push(plan("VAULT-01", "Vault share accounting and inflation attacks", "Test first-depositor donation, rounding direction, preview/action consistency, exchange-rate monotonicity, and loss scenarios.", "fork", "critical", ["forge", "anvil"], 6));
  }
  if (profile.upgradeable) {
    plans.push(plan("UPGRADE-01", "Upgrade authorization and storage compatibility", "Check initializer replay, implementation takeover, proxy admin isolation, storage layout drift, and upgrade rollback.", "anvil", "critical", ["forge", "slither"], 6));
  }
  if (profile.archetypes.includes("oracle-consumer")) {
    plans.push(plan("ORACLE-01", "Oracle freshness and manipulation", "Test stale/zero/negative prices, decimals mismatch, sequencer downtime, update races, and manipulable spot-price dependencies.", "fork", "critical", ["forge", "anvil"], 7));
  }
  if (profile.archetypes.includes("governance")) {
    plans.push(plan("GOV-01", "Governance lifecycle and voting power", "Test quorum boundaries, double voting, delegation snapshots, timelock ordering, cancellation, and flash-loan voting assumptions.", "fork", "critical", ["forge", "anvil"], 7));
  }
  if (profile.archetypes.includes("amm-dex")) {
    plans.push(plan("AMM-01", "Economic and reserve invariants", "Test reserve/product invariants, fee rounding, sandwich/flash-liquidity conditions, callback reentrancy, and token incompatibilities.", "fork", "critical", ["forge", "anvil"], 6));
  }
  if (profile.archetypes.includes("bridge-messaging")) {
    plans.push(plan("BRIDGE-01", "Cross-domain replay and finality", "Test domain separation, duplicate/reordered messages, signer threshold changes, source-chain spoofing, and finality assumptions.", "anvil", "critical", ["forge", "halmos"], 6));
  }
  if (profile.signals.includes("signature-validation")) {
    plans.push(plan("SIG-01", "Signature replay and domain separation", "Test malleability, expired deadlines, nonce reuse, wrong chain/contract domains, zero signer, and ERC-1271 behavior.", "fuzz", "high", ["forge", "halmos"], 7));
  }
  if (declaredContext.trustedRoles) {
    plans.push(plan("TRUST-01", "Declared trusted-role failure model", "Keep intended authority paths as trust disclosures while testing compromised-key, mistaken-call, role-transfer, multisig/timelock, and recovery scenarios.", "local", "high", ["forge", "slither"], 6));
  }
  return plans;
}

function plan(id, vector, rationale, environment, priority, preferredTools, recommendedHarnesses) {
  const recommendedScenarios = (SCENARIO_OBLIGATIONS[id] || []).slice(0, recommendedHarnesses).map((title, index) => ({
    id: `${id}-S${String(index + 1).padStart(2, "0")}`,
    title,
  }));
  return { id, vector, rationale, environment, priority, preferredTools, recommendedScenarios, status: "planned", generatedTestIds: [] };
}
