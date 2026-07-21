import test from "node:test";
import assert from "node:assert/strict";
import { canonicalLoopbackOrigin, originMatches, sessionRefreshAllowed } from "../src/server/origin.js";

test("canonicalizes IPv4, IPv6, localhost, and default HTTP ports", () => {
  assert.equal(canonicalLoopbackOrigin("127.0.0.1", 8787), "http://127.0.0.1:8787");
  assert.equal(canonicalLoopbackOrigin("::1", 8787), "http://[::1]:8787");
  assert.equal(canonicalLoopbackOrigin("localhost", 80), "http://localhost");
});

test("origin matching rejects alternate scheme, host, or port", () => {
  assert.equal(originMatches("http://[::1]:8787", "::1", 8787), true);
  assert.equal(originMatches("http://localhost", "localhost", 80), true);
  assert.equal(originMatches("https://localhost", "localhost", 80), false);
  assert.equal(originMatches("http://127.0.0.1:9000", "127.0.0.1", 8787), false);
  assert.equal(originMatches("http://example.test:8787", "127.0.0.1", 8787), false);
});

test("session refresh accepts only the app's same-origin custom request", () => {
  assert.equal(sessionRefreshAllowed({ "x-attest-session-refresh": "1", "sec-fetch-site": "same-origin" }), true);
  assert.equal(sessionRefreshAllowed({ "x-attest-session-refresh": "1" }), true);
  assert.equal(sessionRefreshAllowed({ "x-attest-session-refresh": "1", "sec-fetch-site": "cross-site" }), false);
  assert.equal(sessionRefreshAllowed({}), false);
});
