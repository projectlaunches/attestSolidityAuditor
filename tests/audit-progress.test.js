import test from "node:test";
import assert from "node:assert/strict";
import { createRequestGeneration, deriveAuditProgress, pollAuditJob } from "../src/web/audit-progress.js";

function stages(statuses) {
  const ids = ["intake", "ai-profile", "operation-loop", "evidence-review", "report"];
  return statuses.map((status, index) => ({ id: ids[index] || `stage-${index}`, label: `Stage ${index + 1}`, status, message: `message ${index + 1}` }));
}

test("audit progress derives queued, running, partial, and cancelled states without false completion", () => {
  const queued = deriveAuditProgress({ status: "queued", stages: stages(["queued", "queued", "queued"]) });
  assert.equal(queued.percent, 0);
  assert.equal(queued.title, "Audit active");

  const running = deriveAuditProgress({ status: "running", stages: stages(["completed", "running", "queued"]) });
  assert.equal(running.percent, 33);
  assert.equal(running.count, "Stage 2 of 3 · 1 complete");
  assert.match(running.detail, /Understanding the whole contract/);

  const partial = deriveAuditProgress({ status: "partial", stages: stages(["completed", "skipped", "failed"]) });
  assert.equal(partial.percent, 100);
  assert.equal(partial.title, "Audit finished with coverage gaps");
  assert.equal(partial.count, "3 of 3 stages reached a result");

  const cancelled = deriveAuditProgress({ status: "cancelled", stages: stages(["completed", "failed", "queued", "queued"]) });
  assert.equal(cancelled.percent, 50);
  assert.equal(cancelled.title, "Audit cancelled");
  assert.equal(cancelled.active, false);
});

test("audit progress counts skipped stages as settled and never exceeds 100 percent", () => {
  const progress = deriveAuditProgress({ status: "running", stages: stages(["completed", "skipped", "running", "queued"]) });
  assert.equal(progress.percent, 50);
  assert.equal(progress.count, "Stage 3 of 4 · 2 complete");
  assert.ok(progress.percent <= 100);
});

test("a multi-round evidence stage shows live tool and round progress instead of appearing stuck", () => {
  const progress = deriveAuditProgress({
    status: "running",
    stages: stages(["completed", "completed", "running", "completed", "queued"]),
    operationLoop: {
      iteration: 7,
      history: Array.from({ length: 6 }, (_, index) => ({ id: `OP-${index + 1}` })),
      activeOperation: { kind: "foundry", objective: "Verify transfer accounting" },
    },
  });
  assert.equal(progress.title, "Foundry testing active");
  assert.equal(progress.count, "Stage 3 of 5 · AI round 7 · 6 evidence checks");
  assert.equal(progress.detail, "Foundry testing: Verify transfer accounting");
  assert.equal(progress.active, true);
});

test("a ready final report overrides stale queued intermediate stages", () => {
  const progress = deriveAuditProgress({
    status: "completed",
    reportState: { status: "ready" },
    stages: stages(["completed", "completed", "completed", "queued", "completed"]),
  });
  assert.equal(progress.percent, 100);
  assert.equal(progress.count, "5 of 5 stages reached a result");
  assert.equal(progress.title, "Audit complete");
  assert.equal(progress.active, false);
});

test("awaiting input is paused, publishing is distinct, and followup testing is active", () => {
  const waiting = deriveAuditProgress({ status: "partial", reportState: { status: "awaiting-testing", reason: "Choose" }, stages: stages(["completed", "completed", "completed"]) });
  assert.equal(waiting.title, "Testing decision needed");
  assert.equal(waiting.active, false);
  const publishing = deriveAuditProgress({ status: "partial", reportState: { status: "publishing" }, stages: stages(["completed"]) });
  assert.equal(publishing.title, "Generating final findings");
  assert.equal(publishing.active, true);
  const followup = deriveAuditProgress({ status: "partial", followup: { status: "running", active: { objective: "Check accounting" } }, reportState: { status: "awaiting-testing" }, stages: stages(["completed"]) });
  assert.equal(followup.title, "Additional testing active");
  assert.equal(followup.detail, "Check accounting");
  assert.equal(followup.active, true);
});

test("polling retries transient failures and rejects a late stale response", async () => {
  let attempts = 0;
  const received = [];
  const result = await pollAuditJob({
    sleep: async () => {}, maxRetries: 2,
    shouldContinue: () => received.length === 0,
    fetchJob: async () => { attempts += 1; if (attempts === 1) throw new Error("offline"); return { id: "job", status: "completed" }; },
    onJob: (job) => received.push(job),
  });
  assert.equal(result.status, "settled");
  assert.equal(attempts, 2);
  assert.equal(received.length, 1);

  const generation = createRequestGeneration();
  const token = generation.begin();
  const stale = await pollAuditJob({
    sleep: async () => {}, shouldContinue: () => true, isCurrent: () => generation.current(token),
    fetchJob: async () => { generation.begin(); return { id: "old" }; },
    onJob: () => assert.fail("stale response must not render"),
  });
  assert.equal(stale.status, "stale");
});
