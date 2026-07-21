import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("setup copy targets resolve and container installs are not live host probes", async () => {
  const html = await readFile(new URL("../src/web/setup.html", import.meta.url), "utf8");
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const targets = [...html.matchAll(/\bdata-copy="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(targets.length > 0);
  for (const target of targets) assert.ok(ids.has(target), `missing copy target ${target}`);
  assert.doesNotMatch(html, /data-tool="(?:mythril|echidna)"/);
  assert.match(html, /Container — manual check/);
});

test("setup journey presents prerequisites before project commands", async () => {
  const html = await readFile(new URL("../src/web/setup.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/web/styles.css", import.meta.url), "utf8");
  const foundation = html.indexOf('id="foundation-title"');
  const core = html.indexOf('id="core-title"');
  const project = html.indexOf('id="quick-title"');
  const advanced = html.indexOf('id="advanced-title"');

  assert.ok(foundation < core, "foundation must precede core tools");
  assert.ok(core < project, "core tools must precede project setup");
  assert.ok(project < advanced, "project setup must precede optional engines");
  assert.match(html, /Already configured\? Skip to project setup/);
  assert.match(css, /#quick-title\s*\{\s*scroll-margin-top:\s*96px/);
});

test("SMTChecker is presented like the other optional advanced tools", async () => {
  const html = await readFile(new URL("../src/web/setup.html", import.meta.url), "utf8");
  assert.match(html, /Advanced tool\. Change the compiler version to match the contract/);
  assert.match(html, /data-copy="cmd-smtchecker"/);
  assert.match(html, /solc-select==1\.2\.0/);
  assert.match(html, /apt-get install -y z3/);
  assert.doesNotMatch(html, /unzip|sha256sum|libz3\.so|lane remains disabled|does not restrict the feature/);
});
