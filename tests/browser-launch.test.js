import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { browserLaunchCommand, openBrowserLauncher, publishBrowserLauncher, windowsPathForWsl } from "../src/server/browser-launch.js";

test("publishes an owner-only no-referrer browser redirect", async (context) => {
  const root = await mkdtemp(path.join("/tmp", "attest-browser-launch-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "open-attest.html");
  await publishBrowserLauncher(file, "http://127.0.0.1:8787/#attest-session=private-token");
  const html = await readFile(file, "utf8");
  assert.match(html, /referrer.*no-referrer/);
  assert.match(html, /#attest-session=private-token/);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("selects a browser launcher without putting the private URL in process arguments", () => {
  const file = "/mnt/c/Users/test/attest/open-attest.html";
  assert.deepEqual(browserLaunchCommand(file, { platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" } }), {
    method: "wsl-windows-shell",
    command: "/mnt/c/Windows/System32/rundll32.exe",
    args: ["url.dll,FileProtocolHandler", "C:\\Users\\test\\attest\\open-attest.html"],
  });
  assert.equal(browserLaunchCommand(file, { platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" } }).args.join(" ").includes("attest-session"), false);
  assert.equal(windowsPathForWsl("/home/test/open-attest.html", "Ubuntu"), "\\\\wsl.localhost\\Ubuntu\\home\\test\\open-attest.html");
});

test("does not open a browser unless tester launch explicitly opts in", async () => {
  const result = await openBrowserLauncher("/tmp/open-attest.html", { env: {} });
  assert.deepEqual(result, { opened: false, reason: "disabled" });
});

test("opens a browser once when tester launch opts in", async () => {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  const result = await openBrowserLauncher("/tmp/open-attest.html", {
    env: { ATTEST_OPEN_BROWSER: "1" },
    platform: "linux",
    spawnImpl,
  });
  assert.deepEqual(result, { opened: true, method: "linux-xdg-open" });
  assert.equal(calls.length, 1);
});

test("explicit no-browser mode overrides tester launch", async () => {
  const result = await openBrowserLauncher("/tmp/open-attest.html", {
    env: { ATTEST_OPEN_BROWSER: "1", ATTEST_NO_BROWSER: "1" },
  });
  assert.deepEqual(result, { opened: false, reason: "disabled" });
});
