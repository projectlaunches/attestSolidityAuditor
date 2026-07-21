import test from "node:test";
import assert from "node:assert/strict";
import { displayClassification } from "../src/shared/evidence.js";

test("browser classification never accepts an AI label with invalid citations", () => {
  assert.equal(displayClassification({ sourceValidated: false, classification: "false-positive" }), "unvalidated AI hypothesis");
  assert.equal(displayClassification({ sourceValidated: true, classification: "intentional-design" }), "intentional-design");
  assert.equal(displayClassification(null), null);
});
