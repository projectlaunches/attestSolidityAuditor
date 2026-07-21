import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("the standalone smoke target remains a complete constructor-free Solidity contract", async () => {
  const source = await readFile(new URL("../samples/SmokeCounter.sol", import.meta.url), "utf8");
  assert.match(source, /pragma solidity \^0\.8\.20;/);
  assert.match(source, /contract SmokeCounter/);
  assert.match(source, /function increment\(\) external/);
  assert.doesNotMatch(source, /constructor\s*\(/);
  assert.doesNotMatch(source, /import\s/);
});
