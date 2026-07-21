import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLoginLaunch, showLoginPopupMessage } from "../src/web/auth-flow.js";

test("normalizes browser and device-code ChatGPT login responses", () => {
  assert.deepEqual(normalizeLoginLaunch({ type: "chatgpt", authUrl: "https://auth.openai.com/authorize" }), {
    type: "chatgpt",
    url: "https://auth.openai.com/authorize",
    userCode: null,
    message: "Complete ChatGPT sign-in in the opened window.",
  });
  assert.deepEqual(normalizeLoginLaunch({ type: "chatgptDeviceCode", verificationUrl: "https://auth.openai.com/device", userCode: "ABCD-EFGH" }), {
    type: "chatgptDeviceCode",
    url: "https://auth.openai.com/device",
    userCode: "ABCD-EFGH",
    message: "Enter code ABCD-EFGH in the opened ChatGPT sign-in window.",
  });
});

test("rejects missing, insecure, and unsupported login destinations", () => {
  assert.throws(() => normalizeLoginLaunch({ type: "chatgpt" }), /authorization URL/);
  assert.throws(() => normalizeLoginLaunch({ type: "chatgpt", authUrl: "http://example.test/login" }), /authorization URL/);
  assert.throws(() => normalizeLoginLaunch({ type: "apiKey" }), /unsupported/);
});

test("a pending popup receives visible sign-in state before navigation", () => {
  const children = [];
  const popup = {
    closed: false,
    document: {
      title: "",
      body: { replaceChildren: () => { children.length = 0; }, append: (item) => children.push(item) },
      createElement: () => ({ textContent: "", style: { cssText: "" } }),
    },
  };
  showLoginPopupMessage(popup, "Preparing secure ChatGPT sign-in…");
  assert.equal(popup.document.title, "Attest · ChatGPT sign-in");
  assert.equal(children[0].textContent, "Preparing secure ChatGPT sign-in…");
});
