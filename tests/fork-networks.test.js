import test from "node:test";
import assert from "node:assert/strict";
import { listForkNetworks, resolveForkNetwork, verifyForkNetwork, verifyPinnedForkBlock } from "../src/server/fork-networks.js";

test("ships bounded public fork presets without exposing full URLs", () => {
  assert.deepEqual(listForkNetworks().map(({ id, chainId }) => [id, chainId]), [["ethereum", 1], ["base", 8453], ["bnb", 56]]);
  assert.equal("url" in listForkNetworks()[0], false);
  assert.match(resolveForkNetwork("base").url, /^https:\/\/mainnet\.base\.org/);
});

test("verifies the expected RPC chain id before fork use", async () => {
  const responses = ["0x2105", "0x10", { number: "0x10", hash: `0x${"ab".repeat(32)}` }];
  const fetchImpl = async () => ({ ok: true, text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: responses.shift() }) });
  const result = await verifyForkNetwork("base", { fetchImpl });
  assert.equal(result.chainId, 8453);
  assert.equal(result.blockNumber, 16);
  await assert.rejects(() => verifyForkNetwork("base", { fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ result: "0x1" }) }) }), /chain mismatch/);
});

test("public network metadata never includes the full endpoint URL", () => {
  assert.equal(listForkNetworks().every((entry) => !Object.hasOwn(entry, "url")), true);
});

test("rechecks the exact fork block hash after execution", async () => {
  const blockHash = `0x${"ab".repeat(32)}`;
  const fetchImpl = async () => ({ ok: true, text: async () => JSON.stringify({ result: { number: "0x10", hash: blockHash } }) });
  assert.equal(await verifyPinnedForkBlock("base", { blockNumber: 16, blockHash }, { fetchImpl }), true);
  await assert.rejects(() => verifyPinnedForkBlock("base", { blockNumber: 16, blockHash }, {
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ result: { number: "0x10", hash: `0x${"cd".repeat(32)}` } }) }),
  }), /changed during execution/);
});
