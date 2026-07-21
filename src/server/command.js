import { spawn } from "node:child_process";
import { registerChild, terminateChild } from "./process-registry.js";

const MAX_OUTPUT_BYTES = 1_500_000;

export async function runCommand(command, args = [], options = {}) {
  const startedAt = new Date().toISOString();
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;

  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let truncated = false;
    let settled = false;
    let cancelled = false;

    const child = registerChild(spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    }));

    const append = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") <= maxOutputBytes) return next;
      truncated = true;
      return Buffer.from(next, "utf8").subarray(0, maxOutputBytes).toString("utf8");
    };

    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });

    if (options.input) child.stdin.end(options.input);

    const timer = setTimeout(() => {
      timedOut = true;
      void terminateChild(child, 0);
    }, timeoutMs);
    const cancellationTimer = typeof options.isCancelled === "function" ? setInterval(() => {
      if (!options.isCancelled()) return;
      cancelled = true;
      void terminateChild(child, 0);
    }, 250) : null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (cancellationTimer) clearInterval(cancellationTimer);
      resolve({
        command,
        args,
        commandSummary: [command, ...args].join(" "),
        startedAt,
        finishedAt: new Date().toISOString(),
        timedOut,
        cancelled,
        truncated,
        stdout,
        stderr,
        ...result,
      });
    };

    child.on("error", (error) => finish({ exitCode: null, error: error.message }));
    child.on("close", (exitCode, signal) => finish({ exitCode, signal, error: null }));
  });
}

export async function commandVersion(command, args = ["--version"]) {
  const result = await runCommand(command, args, { timeoutMs: 8_000, maxOutputBytes: 20_000 });
  const available = result.exitCode === 0;
  return {
    command,
    available,
    version: available ? (result.stdout || result.stderr).trim().split("\n")[0] : null,
    error: available ? null : result.error || result.stderr.trim() || "not available",
  };
}
