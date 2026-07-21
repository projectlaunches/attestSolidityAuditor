import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, rename, rm, writeFile } from "node:fs/promises";

export async function publishBrowserLauncher(file, sessionUrl) {
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const escaped = escapeHtmlAttribute(sessionUrl);
  const html = [
    "<!doctype html>",
    '<meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    `<meta http-equiv="refresh" content="0;url=${escaped}">`,
    "<title>Opening Attest</title>",
    "<p>Opening the private Attest session…</p>",
  ].join("\n");
  try {
    await writeFile(temporary, html, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
    await chmod(file, 0o600);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function openBrowserLauncher(file, options = {}) {
  if (browserLaunchDisabled(options.env || process.env)) return { opened: false, reason: "disabled" };
  const launch = browserLaunchCommand(file, options);
  if (!launch) return { opened: false, reason: "unsupported-platform" };
  const spawnImpl = options.spawnImpl || spawn;
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawnImpl(launch.command, launch.args, { detached: true, stdio: "ignore", windowsHide: true, shell: false });
    } catch (error) {
      finish({ opened: false, reason: error.message });
      return;
    }
    child.once?.("spawn", () => {
      child.unref?.();
      finish({ opened: true, method: launch.method });
    });
    child.once?.("error", (error) => finish({ opened: false, reason: error.message }));
  });
}

export function browserLaunchCommand(file, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  if (platform === "win32") {
    return { method: "windows-shell", command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", file] };
  }
  if (platform === "darwin") return { method: "macos-open", command: "open", args: [file] };
  if (isWsl(env)) {
    const windowsFile = windowsPathForWsl(file, env.WSL_DISTRO_NAME);
    if (!windowsFile) return null;
    return {
      method: "wsl-windows-shell",
      command: "/mnt/c/Windows/System32/rundll32.exe",
      args: ["url.dll,FileProtocolHandler", windowsFile],
    };
  }
  if (platform === "linux") return { method: "linux-xdg-open", command: "xdg-open", args: [file] };
  return null;
}

export function windowsPathForWsl(file, distroName = "") {
  const mounted = String(file).match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (mounted) return `${mounted[1].toUpperCase()}:\\${mounted[2].replaceAll("/", "\\")}`;
  if (!/^[-._A-Za-z0-9]+$/.test(String(distroName || "")) || !String(file).startsWith("/")) return null;
  return `\\\\wsl.localhost\\${distroName}${String(file).replaceAll("/", "\\")}`;
}

function browserLaunchDisabled(env) {
  if (/^(?:1|true|yes)$/i.test(String(env.ATTEST_NO_BROWSER || ""))) return true;
  return !/^(?:1|true|yes)$/i.test(String(env.ATTEST_OPEN_BROWSER || ""));
}

function isWsl(env) {
  return Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
}

function escapeHtmlAttribute(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
