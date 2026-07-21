import http from "node:http";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { probeTools } from "./tools.js";
import { CodexAppServer } from "./ai/codex-app-server.js";
import { askAuditCopilot, cancelAudit, cancelAuditFollowup, createAudit, finalizeAuditReport, getJob, getReportRevision, initializeAuditPersistence, listJobs, prepareAuditShutdown, queueAuditFollowup } from "./audit.js";
import { originMatches, sessionRefreshAllowed } from "./origin.js";
import { shutdownChildren } from "./process-registry.js";
import { listForkNetworks } from "./fork-networks.js";
import { openBrowserLauncher, publishBrowserLauncher } from "./browser-launch.js";
import { loadStaticAssetSnapshot, staticSnapshotBuildId } from "./static-assets.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const webRoot = path.join(projectRoot, "src", "web");
const sharedRoot = path.join(projectRoot, "src", "shared");
const runtimeRoot = path.resolve(process.env.ATTEST_DATA_DIR || path.join(os.homedir(), ".local", "share", "attest"));
const host = process.env.SOLTESTING_HOST || "127.0.0.1";
const port = Number(process.env.SOLTESTING_PORT || 8787);
const sessionToken = randomBytes(24).toString("base64url");
const staticEntries = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/setup": ["setup.html", "text/html; charset=utf-8"],
  "/setup.html": ["setup.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/auth-flow.js": ["auth-flow.js", "text/javascript; charset=utf-8"],
  "/audit-input-controls.js": ["audit-input-controls.js", "text/javascript; charset=utf-8"],
  "/audit-progress.js": ["audit-progress.js", "text/javascript; charset=utf-8"],
  "/copilot-controls.js": ["copilot-controls.js", "text/javascript; charset=utf-8"],
  "/copilot-options.js": ["copilot-options.js", "text/javascript; charset=utf-8"],
  "/session-client.js": ["session-client.js", "text/javascript; charset=utf-8"],
  "/solidity-highlight.js": ["solidity-highlight.js", "text/javascript; charset=utf-8"],
  "/setup.js": ["setup.js", "text/javascript; charset=utf-8"],
  "/setup-model.js": ["../shared/setup.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml"],
  "/evidence.js": ["../shared/evidence.js", "text/javascript; charset=utf-8"],
};
const staticAssets = await loadStaticAssetSnapshot({ webRoot, sharedRoot, entries: staticEntries });
const buildId = staticSnapshotBuildId(staticAssets);

if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
  throw new Error("SOLTESTING_HOST must be loopback-only for the local audit MVP");
}

let capabilities = await probeTools(projectRoot);
const codex = capabilities.codex.available
  ? new CodexAppServer({
      binary: capabilities.codex.command,
      codexHome: path.join(runtimeRoot, "work", "codex-home"),
      model: process.env.SOLTESTING_MODEL || "gpt-5.6-luna",
    })
  : null;

await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
await chmod(runtimeRoot, 0o700);
await initializeAuditPersistence({ projectRoot: runtimeRoot, capabilities, codex });
const sessionUrlFile = path.join(runtimeRoot, "session-url.txt");
const browserLauncherFile = path.join(runtimeRoot, "open-attest.html");

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);
    const method = request.method || "GET";

    if (url.pathname === "/api/session" && method === "GET") {
      if (!sessionRefreshAllowed(request.headers)) throw httpError(403, "Session refresh rejected");
      sendJson(response, 200, { token: sessionToken });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname !== "/api/health") enforceLocalSession(request, ["POST", "PUT", "PATCH", "DELETE"].includes(method));
      await routeApi(request, response, url, method);
      return;
    }
    await serveStatic(response, url.pathname);
  } catch (error) {
    const status = error.statusCode || 500;
    sendJson(response, status, { error: status === 500 ? "Internal server error" : error.message });
    if (status === 500) console.error(error);
  }
});

try {
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
} catch (error) {
  const reason = error?.code === "EADDRINUSE"
    ? `Port ${port} is already in use; the existing Attest session URL was left unchanged`
    : `Attest could not bind to ${host}:${port}: ${error.message}`;
  console.error(reason);
  await prepareAuditShutdown().catch(() => {});
  await shutdownChildren().catch(() => {});
  process.exitCode = 1;
  throw httpError(503, reason);
}
const sessionUrl = `http://${host}:${port}/#attest-session=${sessionToken}`;
await publishSessionUrl(sessionUrlFile, `${sessionUrl}\n`);
await publishBrowserLauncher(browserLauncherFile, sessionUrl);
console.log(`attest is running at http://${host}:${port}`);
const browserLaunch = await openBrowserLauncher(browserLauncherFile);
if (browserLaunch.opened) console.log("Opened the private Attest session in the default browser");
else if (browserLaunch.reason === "disabled") console.log(`Automatic browser launch is disabled; open ${browserLauncherFile}`);
else console.log(`The browser did not open automatically; open ${browserLauncherFile}`);
console.log(`Foundry: ${toolState("forge")}; Slither: ${toolState("slither")}; Codex: ${capabilities.codex.available ? capabilities.codex.version : "unavailable"}`);

async function publishSessionUrl(file, content) {
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
    await chmod(file, 0o600);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function routeApi(request, response, url, method) {
  if (method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, service: "soltesting", buildId, now: new Date().toISOString() });
    return;
  }
  if (method === "GET" && url.pathname === "/api/capabilities") {
    sendJson(response, 200, { ...capabilities, forkNetworks: listForkNetworks() });
    return;
  }
  if (method === "POST" && url.pathname === "/api/capabilities/refresh") {
    const refreshed = await probeTools(projectRoot);
    // Codex is constructed at startup. Keep the capability aligned with the
    // authentication routes until the local app is restarted.
    capabilities = { ...refreshed, codex: capabilities.codex };
    sendJson(response, 200, { ...capabilities, forkNetworks: listForkNetworks() });
    return;
  }
  if (method === "GET" && url.pathname === "/api/auth") {
    if (!codex) {
      sendJson(response, 200, { available: false, connected: false, error: "Codex CLI is unavailable" });
      return;
    }
    try {
      sendJson(response, 200, { available: true, ...(await codex.account()) });
    } catch (error) {
      sendJson(response, 200, { available: true, connected: false, error: error.message });
    }
    return;
  }
  if (method === "POST" && url.pathname === "/api/auth/login") {
    if (!codex) throw httpError(503, "Codex CLI is unavailable");
    let result;
    try {
      result = await codex.login();
    } catch (error) {
      const message = String(error?.message || error || "");
      const reason = /device code|auth\.openai\.com|network|request|resolve|connect|timed out/i.test(message)
        ? "ChatGPT sign-in could not reach OpenAI. Check this WSL session's internet or proxy access, then retry."
        : `ChatGPT sign-in could not start: ${message.slice(0, 500) || "Codex returned no login details"}`;
      throw httpError(503, reason);
    }
    sendJson(response, 200, {
      type: result.type,
      loginId: result.loginId,
      authUrl: result.authUrl,
      verificationUrl: result.verificationUrl,
      userCode: result.userCode,
    });
    return;
  }
  if (method === "POST" && url.pathname === "/api/auth/logout") {
    if (codex) await codex.logout();
    sendJson(response, 200, { ok: true });
    return;
  }
  if (method === "GET" && url.pathname === "/api/audits") {
    sendJson(response, 200, { jobs: listJobs() });
    return;
  }
  if (method === "POST" && url.pathname === "/api/audits") {
    const body = await readJson(request, 300_000);
    let job;
    try {
      job = createAudit({
        projectRoot: runtimeRoot,
        capabilities,
        codex,
        source: body.source,
        fileName: body.fileName,
        useAi: body.useAi !== false,
        auditDepth: body.auditDepth || "targeted",
        allowLocalExecution: body.allowLocalExecution ?? body.runGeneratedTests === true,
        allowAnvil: body.allowAnvil ?? body.runAnvil === true,
        allowForks: body.allowForks === true,
        testCampaign: body.testCampaign,
        declaredContext: body.declaredContext,
      });
    } catch (error) {
      throw httpError(400, error.message);
    }
    sendJson(response, 202, job);
    return;
  }

  const cancelMatch = url.pathname.match(/^\/api\/audits\/([0-9a-f-]+)\/cancel$/i);
  if (method === "POST" && cancelMatch) {
    const job = await cancelAudit(cancelMatch[1]);
    if (!job) throw httpError(404, "Audit job not found");
    sendJson(response, 200, job);
    return;
  }

  const copilotMatch = url.pathname.match(/^\/api\/audits\/([0-9a-f-]+)\/copilot$/i);
  if (method === "POST" && copilotMatch) {
    const body = await readJson(request, 10_000);
    const job = await askAuditCopilot(copilotMatch[1], body);
    if (!job) throw httpError(404, "Audit job not found");
    sendJson(response, 200, job);
    return;
  }

  const followupMatch = url.pathname.match(/^\/api\/audits\/([0-9a-f-]+)\/followups$/i);
  if (method === "POST" && followupMatch) {
    const body = await readJson(request, 10_000);
    const job = await queueAuditFollowup(followupMatch[1], body);
    if (!job) throw httpError(404, "Audit job not found");
    sendJson(response, 202, job);
    return;
  }

  const followupCancelMatch = url.pathname.match(/^\/api\/audits\/([0-9a-f-]+)\/followups\/([0-9a-f-]+)\/cancel$/i);
  if (method === "POST" && followupCancelMatch) {
    const job = await cancelAuditFollowup(followupCancelMatch[1], followupCancelMatch[2]);
    if (!job) throw httpError(404, "Audit job not found");
    sendJson(response, 200, job);
    return;
  }

  const finalizeMatch = url.pathname.match(/^\/api\/audits\/([0-9a-f-]+)\/finalize$/i);
  if (method === "POST" && finalizeMatch) {
    const job = await finalizeAuditReport(finalizeMatch[1]);
    if (!job) throw httpError(404, "Audit job not found");
    sendJson(response, 200, job);
    return;
  }

  const match = url.pathname.match(/^\/api\/audits\/([0-9a-f-]+)(?:\/report)?$/i);
  if (method === "GET" && match) {
    const job = getJob(match[1]);
    if (!job) throw httpError(404, "Audit job not found");
    if (url.pathname.endsWith("/report")) {
      const format = url.searchParams.get("format") || "md";
      const revisionNumber = url.searchParams.has("revision") ? Number(url.searchParams.get("revision")) : null;
      const revision = revisionNumber == null ? null : getReportRevision(job.id, revisionNumber);
      if (revisionNumber != null && (!Number.isInteger(revisionNumber) || revisionNumber < 1 || !revision)) throw httpError(404, "Report revision not found");
      if (revisionNumber == null && (job.reportState?.status !== "ready" || !job.reportMarkdown)) throw httpError(409, "Final findings are not ready; finish the remaining testing or explicitly close testing first");
      if (format === "json") {
        const { copilot: _discussion, ...immutableAudit } = revision?.snapshot || job;
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="attest-evidence-${job.id}.json"`,
          "x-content-type-options": "nosniff",
        });
        response.end(JSON.stringify(immutableAudit, null, 2));
      } else {
        response.writeHead(200, {
          "content-type": "text/markdown; charset=utf-8",
          "content-disposition": `attachment; filename="attest-findings-${job.id}.md"`,
          "x-content-type-options": "nosniff",
        });
        response.end(revision?.markdown || job.reportMarkdown);
      }
      return;
    }
    sendJson(response, 200, job);
    return;
  }

  throw httpError(404, "API route not found");
}

function enforceLocalSession(request, mutation = false) {
  if (request.headers["x-soltesting-token"] !== sessionToken) throw httpError(403, "Missing local session token");
  if (!mutation) return;
  const origin = request.headers.origin;
  if (origin) {
    if (!originMatches(origin, host, port)) throw httpError(403, "Cross-origin mutation rejected");
  }
}

async function readJson(request, limitBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limitBytes) throw httpError(413, "Request is too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw httpError(400, "Invalid JSON body");
  }
}

async function serveStatic(response, pathname) {
  const asset = staticAssets.get(pathname);
  if (!asset) throw httpError(404, "Page not found");
  response.writeHead(200, {
    "content-type": asset.contentType,
    "cache-control": "no-store",
    "x-attest-build-id": buildId,
    "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://chatgpt.com https://auth.openai.com",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  response.end(asset.body);
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function toolState(id) {
  const tool = capabilities.analyzers.find((item) => item.id === id);
  return tool?.available ? tool.version : "unavailable";
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; stopping local workers`);
  server.close();
  await prepareAuditShutdown();
  await shutdownChildren();
  process.exit(0);
}
process.on("SIGINT", () => { void shutdown("SIGINT"); });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
