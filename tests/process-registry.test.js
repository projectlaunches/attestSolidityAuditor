import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { registerChild, shutdownChildren } from "../src/server/process-registry.js";

test("owned detached workers are terminated and reaped during shutdown", async () => {
  const child = registerChild(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: process.platform !== "win32",
    stdio: "ignore",
  }));
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  await shutdownChildren();
  await new Promise((resolve) => child.exitCode !== null || child.signalCode ? resolve() : child.once("close", resolve));
  assert.ok(child.exitCode !== null || child.signalCode);
  const lateChild = registerChild(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: false, stdio: "ignore" }));
  await new Promise((resolve) => lateChild.once("close", resolve));
  assert.ok(lateChild.exitCode !== null || lateChild.signalCode);
});
