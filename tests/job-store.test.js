import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { assertJobId, createJobStore } from "../src/server/job-store.js";

async function fixture(context) {
  const root = await mkdtemp(path.join(process.cwd(), ".attest-store-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: createJobStore({ root }) };
}

test("validates job ids and persists/list states atomically", async (context) => {
  const { store } = await fixture(context);
  for (const id of ["../escape", "a/b", "a\\b", ".", "", "a b"]) assert.throws(() => assertJobId(id), /Invalid job id/);
  assert.equal(assertJobId("job_01-safe"), "job_01-safe");
  assert.equal(await store.loadState("missing"), null);
  await Promise.all([
    store.saveState("job-1", { id: "job-1", sequence: 1 }),
    store.saveState("job-1", { id: "job-1", sequence: 2 }),
  ]);
  assert.deepEqual(await store.loadState("job-1"), { id: "job-1", sequence: 2 });
  assert.deepEqual(await store.listStates(), [{ id: "job-1", sequence: 2 }]);
});

test("commits complete revision directories before a manifest", async (context) => {
  const { root, store } = await fixture(context);
  const manifest = await store.commitReportRevision("job-2", {
    revision: 1,
    evidenceRevision: 7,
    artifacts: { "findings.md": "# Findings\n", "evidence.json": { status: "complete" } },
    metadata: { trigger: "automatic" },
  });
  assert.equal(manifest.currentRevision, 1);
  assert.equal(manifest.revisions[0].evidenceRevision, 7);
  const revisionRoot = path.join(root, "job-2", "reports", "revisions", "000001");
  assert.equal(await readFile(path.join(revisionRoot, "findings.md"), "utf8"), "# Findings\n");
  assert.deepEqual(JSON.parse(await readFile(path.join(revisionRoot, "evidence.json"), "utf8")), { status: "complete" });
  assert.deepEqual(await store.readReportManifest("job-2"), manifest);
  const retried = await store.commitReportRevision("job-2", {
    revision: 1,
    evidenceRevision: 7,
    artifacts: { "findings.md": "# Findings\n", "evidence.json": { status: "complete" } },
    metadata: { trigger: "automatic" },
  });
  assert.equal(retried.currentRevision, 1);
  await assert.rejects(store.commitReportRevision("job-2", { revision: 1, artifacts: { "findings.md": "replacement" } }), /EEXIST|ENOTEMPTY/);
});

test("serializes report revisions for one job", async (context) => {
  const { store } = await fixture(context);
  await Promise.all([
    store.commitReportRevision("job-3", { revision: 1, artifacts: { "findings.md": "one" } }),
    store.commitReportRevision("job-3", { revision: 2, artifacts: { "findings.md": "two" } }),
  ]);
  const manifest = await store.readReportManifest("job-3");
  assert.equal(manifest.currentRevision, 2);
  assert.deepEqual(manifest.revisions.map((item) => item.revision), [1, 2]);
});

test("cleanup removes only owned temp entries and does not traverse symlinks", async (context) => {
  const { root, store } = await fixture(context);
  const job = path.join(root, "job-4");
  const outside = await mkdtemp(path.join(process.cwd(), ".attest-outside-test-"));
  context.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(path.join(job, `${TEMP_MARKER_FOR_TEST()}dir`), { recursive: true });
  await writeFile(path.join(job, `${TEMP_MARKER_FOR_TEST()}file`), "temporary");
  await writeFile(path.join(job, "keep.txt"), "keep");
  await writeFile(path.join(outside, `${TEMP_MARKER_FOR_TEST()}keep`), "outside");
  try {
    await symlink(outside, path.join(job, "outside-link"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error.code)) context.skip("Symlinks are unavailable in this environment");
    else throw error;
  }
  assert.equal(await store.cleanupTempFiles(), 2);
  assert.equal(await readFile(path.join(job, "keep.txt"), "utf8"), "keep");
  assert.equal(await readFile(path.join(outside, `${TEMP_MARKER_FOR_TEST()}keep`), "utf8"), "outside");
});

test("retention deletes only terminal validated job directories", async (context) => {
  const { root, store } = await fixture(context);
  await store.saveState("terminal-old", { id: "terminal-old", status: "completed", createdAt: "2026-01-01T00:00:00.000Z" });
  await store.saveState("terminal-new", { id: "terminal-new", status: "partial", createdAt: "2026-01-02T00:00:00.000Z" });
  await store.saveState("active", { id: "active", status: "running", createdAt: "2026-01-03T00:00:00.000Z" });
  await assert.rejects(store.deleteJob("../escape"), /Invalid job id/);
  await assert.rejects(store.deleteJob("active"), /Refusing to delete active job/);
  const result = await store.prune({ maxJobs: 2, maxBytes: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(result.removed, ["terminal-old"]);
  assert.equal(await store.loadState("terminal-old"), null);
  assert.ok(await store.loadState("terminal-new"));
  assert.ok(await store.loadState("active"));
  assert.equal(await readFile(path.join(root, "terminal-new", "state.json"), "utf8").then(Boolean), true);
});

function TEMP_MARKER_FOR_TEST() { return ".attest-tmp-"; }
