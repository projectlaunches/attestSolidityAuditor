import test from "node:test";
import assert from "node:assert/strict";
import { createApiClient, resolveLocalSessionToken } from "../src/web/session-client.js";
import { normalizeLoginLaunch } from "../src/web/auth-flow.js";

function reply(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

test("private fragment capability is retained only in browser session storage", () => {
  const values = new Map();
  let replaced = null;
  const browser = {
    location: { hash: "#attest-session=abcdefghijklmnopqrstuvwxyz123456", pathname: "/", search: "" },
    sessionStorage: { setItem: (key, value) => values.set(key, value), getItem: (key) => values.get(key) },
    history: { replaceState: (_state, _title, url) => { replaced = url; } },
  };
  assert.equal(resolveLocalSessionToken(browser), "abcdefghijklmnopqrstuvwxyz123456");
  assert.equal(replaced, "/");
  browser.location.hash = "";
  assert.equal(resolveLocalSessionToken(browser), "abcdefghijklmnopqrstuvwxyz123456");
});

test("session capability is attached to reads and mutations", async () => {
  const calls = [];
  const api = createApiClient("abcdefghijklmnopqrstuvwxyz123456", async (path, options) => {
    calls.push({ path, options });
    return reply(200, { ok: true });
  });
  await api("/api/audits");
  await api("/api/audits", { method: "POST", body: "{}" });
  assert.equal(calls[0].options.headers["x-soltesting-token"], "abcdefghijklmnopqrstuvwxyz123456");
  assert.equal(calls[1].options.headers["x-soltesting-token"], "abcdefghijklmnopqrstuvwxyz123456");
});

test("the plain local URL bootstraps its same-origin session automatically", async () => {
  const calls = [];
  const saved = new Map();
  const replacement = "ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210abcd";
  const api = createApiClient("", async (path, options) => {
    calls.push({ path, options });
    if (path === "/api/session") return reply(200, { token: replacement });
    return reply(200, { available: true, connected: false });
  }, { sessionStorage: { setItem: (key, value) => saved.set(key, value) } });
  assert.deepEqual(await api("/api/auth"), { available: true, connected: false });
  assert.deepEqual(calls.map((call) => call.path), ["/api/session", "/api/auth"]);
  assert.equal(calls[1].options.headers["x-soltesting-token"], replacement);
  assert.equal(saved.get("attest.localSession"), replacement);
});

test("a stale browser session silently refreshes and continues ChatGPT sign-in", async () => {
  const calls = [];
  const saved = new Map();
  const replacement = "ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210abcd";
  const api = createApiClient("abcdefghijklmnopqrstuvwxyz123456", async (path, options) => {
    calls.push({ path, options });
    if (path === "/api/session") return reply(200, { token: replacement });
    if (calls.filter((call) => call.path === "/api/auth/login").length === 1) return reply(403, { error: "Missing local session token" });
    return reply(200, { type: "chatgpt", authUrl: "https://auth.openai.com/authorize" });
  }, { sessionStorage: { setItem: (key, value) => saved.set(key, value) } });
  const launch = normalizeLoginLaunch(await api("/api/auth/login", { method: "POST" }));
  assert.equal(launch.url, "https://auth.openai.com/authorize");
  assert.deepEqual(calls.map((call) => call.path), ["/api/auth/login", "/api/session", "/api/auth/login"]);
  assert.equal(calls[1].options.headers["x-attest-session-refresh"], "1");
  assert.equal(calls[2].options.headers["x-soltesting-token"], replacement);
  assert.equal(calls[2].options.method, "POST");
  assert.equal(saved.get("attest.localSession"), replacement);
});

test("session recovery retries only once", async () => {
  const replacement = "ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210abcd";
  let refreshes = 0;
  const api = createApiClient("abcdefghijklmnopqrstuvwxyz123456", async (path) => {
    if (path === "/api/session") { refreshes += 1; return reply(200, { token: replacement }); }
    return reply(403, { error: "Missing local session token" });
  }, { sessionStorage: { setItem: () => {} } });
  await assert.rejects(api("/api/auth"), /could not refresh this browser session/i);
  assert.equal(refreshes, 1);
});
