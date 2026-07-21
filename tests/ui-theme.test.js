import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const cssUrl = new URL("../src/web/styles.css", import.meta.url);

function luminance(hex) {
  const channels = hex.match(/[a-f\d]{2}/gi).map((value) => Number.parseInt(value, 16) / 255);
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(foreground, background) {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("workbench theme is restrained and its core text pairs meet WCAG AA", async () => {
  const css = await readFile(cssUrl, "utf8");
  const tokens = Object.fromEntries([...css.matchAll(/--([\w-]+):\s*(#[a-f\d]{6})/gi)].map((match) => [match[1], match[2]]));

  assert.doesNotMatch(css, /(?:linear|radial|conic)-gradient/i);
  assert.match(css, /\.hidden\s*\{\s*display:\s*none\s*!important/);
  assert.match(css, /\.copilot-message-details/);
  assert.match(css, /\.copilot-feed/);
  assert.doesNotMatch(css, /\.audit-progress-track|\.audit-progress-bar/);

  for (const [foreground, background] of [
    ["text", "surface"],
    ["muted", "surface"],
    ["muted", "canvas"],
    ["brand", "surface"],
    ["danger", "danger-soft"],
    ["warning", "warning-soft"],
    ["success", "success-soft"],
  ]) {
    assert.ok(contrast(tokens[foreground], tokens[background]) >= 4.5, `${foreground} on ${background} must meet 4.5:1`);
  }
});

test("audit page exposes visible and assistive tool availability states", async () => {
  const html = await readFile(new URL("../src/web/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/web/app.js", import.meta.url), "utf8");
  const css = await readFile(cssUrl, "utf8");

  assert.match(html, /id="tool-summary"[^>]*aria-live="polite"/);
  assert.match(html, /id="results-title" tabindex="-1"/);
  assert.match(html, /id="copilot-feed"[^>]*aria-live="polite"/);
  assert.match(app, /tool\.available \? "Ready" : "Missing"/);
  assert.match(app, /audit engines are available on this workstation/);
  assert.match(app, /Promise\.allSettled\(\[loadCapabilities\(\), loadAuth\(\)\]\)/);
  assert.ok(app.indexOf('addEventListener("click", startAudit)') < app.indexOf("Promise.allSettled"), "controls must activate before startup checks");
  assert.ok(app.indexOf('activeJob = await api("/api/audits"') < app.indexOf('results.classList.remove("hidden")'), "report should open only after audit creation succeeds");
  assert.match(css, /\.workspace\s*\{\s*display:\s*block/);
  assert.doesNotMatch(css, /pipeline-panel|\.pipeline(?:\s|\{|\.)/);
});

test("attest wordmark replaces the temporary ST product mark", async () => {
  const audit = await readFile(new URL("../src/web/index.html", import.meta.url), "utf8");
  const setup = await readFile(new URL("../src/web/setup.html", import.meta.url), "utf8");
  const css = await readFile(cssUrl, "utf8");

  for (const html of [audit, setup]) {
    assert.match(html, /class="brand-wordmark"/);
    assert.match(html, /class="brand-name">attest</);
    assert.match(html, /aria-label="attest home"/);
    assert.doesNotMatch(html, /class="brand-mark">ST/);
    assert.doesNotMatch(html, /-solTesting/);
  }
  assert.match(css, /\.brand-brace:last-child\s*\{\s*margin-left:\s*12px/);
  assert.match(css, /\.brand-wordmark\s*\{[^}]*gap:\s*0/);
});

test("active audit stages use a restrained motion indicator with reduced-motion support", async () => {
  const css = await readFile(cssUrl, "utf8");
  const app = await readFile(new URL("../src/web/app.js", import.meta.url), "utf8");
  assert.match(css, /\.activity-spinner/);
  assert.match(css, /\.copilot-citation pre/);
  assert.match(css, /\.copilot-fact/);
  assert.match(css, /background: var\(--code\)/);
  assert.match(css, /@keyframes activity-spin/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.copilot-live-status/);
  assert.match(css, /\.copilot-feed[^}]*height:\s*clamp\(300px, 42vh, 430px\)/);
  assert.match(css, /\.copilot-live-copy strong[^}]*font-size:\s*13px/);
  assert.match(css, /\.copilot-live-copy span[^}]*font-size:\s*12px/);
  assert.match(css, /\.copilot-live-count[^}]*font:\s*11px/);
  assert.match(css, /\.copilot-live-status\.running::after/);
  assert.match(css, /@keyframes live-progress-sweep/);
  assert.match(app, /copilot-live-spinner/);
  assert.match(app, /!progress\.active/);
});
