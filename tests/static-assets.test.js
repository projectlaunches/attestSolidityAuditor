import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadStaticAssetSnapshot, staticSnapshotBuildId } from "../src/server/static-assets.js";

test("a running backend serves one immutable frontend snapshot", async (context) => {
  const root = await mkdtemp(path.join("/tmp", "attest-static-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const webRoot = path.join(root, "web");
  const sharedRoot = path.join(root, "shared");
  await mkdir(webRoot);
  await mkdir(sharedRoot);
  await writeFile(path.join(webRoot, "app.js"), "export const version = 1;\n");
  await writeFile(path.join(sharedRoot, "shared.js"), "export const shared = 1;\n");
  const entries = {
    "/app.js": ["app.js", "text/javascript"],
    "/shared.js": ["../shared/shared.js", "text/javascript"],
  };
  const snapshot = await loadStaticAssetSnapshot({ webRoot, sharedRoot, entries });
  const firstBuild = staticSnapshotBuildId(snapshot);
  await writeFile(path.join(webRoot, "app.js"), "export const version = 2;\n");
  assert.equal(snapshot.get("/app.js").body, "export const version = 1;\n");
  assert.equal(staticSnapshotBuildId(snapshot), firstBuild);
  const restarted = await loadStaticAssetSnapshot({ webRoot, sharedRoot, entries });
  assert.notEqual(staticSnapshotBuildId(restarted), firstBuild);
});
