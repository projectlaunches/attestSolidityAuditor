import test from "node:test";
import assert from "node:assert/strict";
import { AUDIT_OUTPUT_SCHEMAS } from "../src/server/ai/codex-app-server.js";
import { strictSchemaIssues } from "../src/server/ai/strict-schema.js";

test("every structured AI output schema satisfies strict required-property rules", () => {
  const issues = Object.entries(AUDIT_OUTPUT_SCHEMAS)
    .flatMap(([name, schema]) => strictSchemaIssues(schema, name));
  assert.deepEqual(issues, []);
});
