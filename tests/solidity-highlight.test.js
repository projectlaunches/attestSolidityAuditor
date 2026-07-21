import test from "node:test";
import assert from "node:assert/strict";
import { highlightSolidity } from "../src/web/solidity-highlight.js";

test("Solidity highlighter identifies contract syntax without changing source text", () => {
  const source = `contract Vault {\n  mapping(address => uint256) balances;\n  function withdraw(uint256 amount) external { require(amount > 0, "zero"); }\n}`;
  const html = highlightSolidity(source);

  assert.match(html, /tok-keyword">contract/);
  assert.match(html, /tok-title">Vault/);
  assert.match(html, /tok-keyword">mapping/);
  assert.match(html, /tok-type">address/);
  assert.match(html, /tok-type">uint256/);
  assert.match(html, /tok-builtin">require/);
  assert.match(html, /tok-string">"zero"/);
});

test("Solidity highlighter escapes source before adding fixed token markup", () => {
  const html = highlightSolidity(`// </code><script>alert(1)</script>\nstring value = "<&>";`);

  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;&amp;&gt;/);
  assert.match(html, /tok-comment/);
});

test("Solidity highlighter tolerates incomplete source and large input", () => {
  assert.doesNotThrow(() => highlightSolidity("contract Draft { /* unfinished"));
  const output = highlightSolidity(`uint256 total;\n`.repeat(10_000));
  assert.match(output, /tok-type">uint256/);
});
