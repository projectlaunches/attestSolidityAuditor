import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

const JOB_ID = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,127})$/;
const TEMP_MARKER = ".attest-tmp-";

/**
 * Creates a filesystem-backed job store. All mutations for one job are
 * serialized, while different jobs may be written concurrently.
 */
export function createJobStore({ root }) {
  if (typeof root !== "string" || !root.trim()) throw new TypeError("A job-store root is required");
  const storeRoot = path.resolve(root);
  const queues = new Map();

  function jobDirectory(jobId) {
    assertJobId(jobId);
    return path.join(storeRoot, jobId);
  }

  function serialize(jobId, operation) {
    assertJobId(jobId);
    const previous = queues.get(jobId) || Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    queues.set(jobId, result);
    return result.finally(() => {
      if (queues.get(jobId) === result) queues.delete(jobId);
    });
  }

  return Object.freeze({
    root: storeRoot,

    async saveState(jobId, state) {
      return serialize(jobId, async () => {
        const directory = jobDirectory(jobId);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await chmod(storeRoot, 0o700);
        await chmod(directory, 0o700);
        await atomicWriteJson(path.join(directory, "state.json"), state);
      });
    },

    async loadState(jobId) {
      const file = path.join(jobDirectory(jobId), "state.json");
      try {
        return JSON.parse(await readFile(file, "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw annotate(error, `Could not load state for job ${jobId}`);
      }
    },

    async listStates() {
      let entries;
      try {
        entries = await readdir(storeRoot, { withFileTypes: true });
      } catch (error) {
        if (error?.code === "ENOENT") return [];
        throw error;
      }
      const states = [];
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || !JOB_ID.test(entry.name)) continue;
        const state = await this.loadState(entry.name);
        if (state !== null) states.push(state);
      }
      return states;
    },

    /**
     * Atomically publishes one immutable report revision. Artifact values may
     * be strings, Buffers, or JSON-compatible values. The manifest is replaced
     * only after the complete revision directory is in place.
     */
    async commitReportRevision(jobId, { revision, evidenceRevision = null, artifacts, metadata = {} }) {
      assertRevision(revision);
      validateArtifacts(artifacts);
      return serialize(jobId, async () => {
        const jobRoot = jobDirectory(jobId);
        const reportsRoot = path.join(jobRoot, "reports");
        const revisionsRoot = path.join(reportsRoot, "revisions");
        const revisionName = String(revision).padStart(6, "0");
        const finalDirectory = path.join(revisionsRoot, revisionName);
        const stagingDirectory = path.join(revisionsRoot, `${TEMP_MARKER}${revisionName}-${randomUUID()}`);
        await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
        try {
          const serializedArtifacts = Object.fromEntries(Object.entries(artifacts).map(([name, value]) => [name, serializeArtifact(name, value)]));
          for (const [name, value] of Object.entries(serializedArtifacts)) {
            const file = path.join(stagingDirectory, name);
            await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
            await durableWrite(file, value);
          }
          const revisionRecord = {
            revision,
            evidenceRevision,
            committedAt: new Date().toISOString(),
            directory: `revisions/${revisionName}`,
            artifacts: Object.keys(artifacts).sort(),
            artifactDigests: Object.fromEntries(Object.entries(serializedArtifacts).map(([name, value]) => [name, createHash("sha256").update(value).digest("hex")])),
            metadata,
          };
          await atomicWriteJson(path.join(stagingDirectory, "revision.json"), revisionRecord);
          await mkdir(revisionsRoot, { recursive: true, mode: 0o700 });
          let committedRecord = revisionRecord;
          try {
            await rename(stagingDirectory, finalDirectory);
          } catch (error) {
            if (!["EEXIST", "ENOTEMPTY"].includes(error?.code)) throw error;
            const existingRecord = await readJsonIfPresent(path.join(finalDirectory, "revision.json"));
            if (!sameRevision(existingRecord, revisionRecord)) throw error;
            await rm(stagingDirectory, { recursive: true, force: true });
            committedRecord = existingRecord;
          }

          const existing = await readJsonIfPresent(path.join(reportsRoot, "manifest.json"));
          const prior = Array.isArray(existing?.revisions) ? existing.revisions.filter((item) => item?.revision !== revision) : [];
          const manifest = {
            version: 1,
            jobId,
            currentRevision: revision,
            updatedAt: committedRecord.committedAt,
            revisions: [...prior, committedRecord].sort((a, b) => a.revision - b.revision),
          };
          await atomicWriteJson(path.join(reportsRoot, "manifest.json"), manifest);
          return manifest;
        } catch (error) {
          await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
          throw error;
        }
      });
    },

    async readReportManifest(jobId) {
      return readJsonIfPresent(path.join(jobDirectory(jobId), "reports", "manifest.json"));
    },

    async loadCommittedReportState(jobId, revision) {
      assertRevision(revision);
      return readJsonIfPresent(path.join(jobDirectory(jobId), "reports", "revisions", String(revision).padStart(6, "0"), "state.json"));
    },

    async deleteJob(jobId) {
      return serialize(jobId, async () => {
        const state = await this.loadState(jobId);
        if (state && (["queued", "running", "cancelling"].includes(state.status) || ["queued", "running"].includes(state.followup?.status))) {
          throw new Error(`Refusing to delete active job ${jobId}`);
        }
        await rm(jobDirectory(jobId), { recursive: true, force: true });
      });
    },

    async prune({ maxJobs = 100, maxBytes = 2_000_000_000 } = {}) {
      const states = (await this.listStates()).sort((a, b) => String(a.updatedAt || a.createdAt || "").localeCompare(String(b.updatedAt || b.createdAt || "")));
      const entries = [];
      for (const state of states) entries.push({ state, bytes: await directoryBytes(jobDirectory(state.id)) });
      let totalBytes = entries.reduce((sum, item) => sum + item.bytes, 0);
      let totalJobs = entries.length;
      const removed = [];
      for (const item of entries) {
        if (totalJobs <= maxJobs && totalBytes <= maxBytes) break;
        if (["queued", "running", "cancelling"].includes(item.state.status) || ["queued", "running"].includes(item.state.followup?.status)) continue;
        await this.deleteJob(item.state.id);
        totalJobs -= 1;
        totalBytes -= item.bytes;
        removed.push(item.state.id);
      }
      return { removed, totalJobs, totalBytes, limits: { maxJobs, maxBytes } };
    },

    /** Removes only store-owned temporary files/directories, never symlinks. */
    async cleanupTempFiles() {
      return cleanupTemps(storeRoot);
    },

    async flush() {
      await Promise.allSettled([...queues.values()]);
    },
  });
}

export function assertJobId(jobId) {
  if (typeof jobId !== "string" || !JOB_ID.test(jobId)) throw new TypeError("Invalid job id");
  return jobId;
}

async function atomicWriteJson(file, value) {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `${TEMP_MARKER}${path.basename(file)}-${randomUUID()}`);
  try {
    await durableWrite(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function durableWrite(file, content) {
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readJsonIfPresent(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function validateArtifacts(artifacts) {
  if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts) || !Object.keys(artifacts).length) {
    throw new TypeError("At least one report artifact is required");
  }
  for (const name of Object.keys(artifacts)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name) || name === "revision.json") throw new TypeError(`Invalid artifact name: ${name}`);
  }
}

function serializeArtifact(name, value) {
  if (typeof value === "string" || Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return value;
  if (name.endsWith(".json")) return `${JSON.stringify(value, null, 2)}\n`;
  throw new TypeError(`Artifact ${name} must be text, bytes, or use a .json extension`);
}

function assertRevision(revision) {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new TypeError("Revision must be a positive safe integer");
}

function sameRevision(left, right) {
  return Boolean(left && right
    && left.revision === right.revision
    && left.evidenceRevision === right.evidenceRevision
    && JSON.stringify(left.artifactDigests || {}) === JSON.stringify(right.artifactDigests || {})
    && JSON.stringify(left.metadata || {}) === JSON.stringify(right.metadata || {}));
}

async function cleanupTemps(root) {
  let removed = 0;
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.name.startsWith(TEMP_MARKER)) {
        await rm(target, { recursive: entry.isDirectory(), force: true });
        removed += 1;
      } else if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await visit(target);
      }
    }
  }
  await visit(root);
  return removed;
}

async function directoryBytes(directory) {
  let total = 0;
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error?.code === "ENOENT") return 0; throw error; }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) total += await directoryBytes(target);
    else if (entry.isFile()) total += (await stat(target)).size;
  }
  return total;
}

function annotate(error, context) {
  error.message = `${context}: ${error.message}`;
  return error;
}
