import test from "node:test";
import assert from "node:assert/strict";
import { assertCopilotQuestionSafe, normalizeCopilotQuestion, validateCopilotResult } from "../src/server/copilot.js";

test("Audit Copilot treats submission as consent and bounds the question", () => {
  assert.throws(() => normalizeCopilotQuestion("   "), /Enter a question/);
  assert.throws(() => normalizeCopilotQuestion("x".repeat(2_001)), /2,000 character limit/);
  assert.equal(normalizeCopilotQuestion("  Why was this contextual?  "), "Why was this contextual?");
});

test("Audit Copilot rejects signing and service secrets before they can be retained", () => {
  for (const unsafe of [
    `private key: 0x${"ab".repeat(32)}`,
    "seed phrase: alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu",
    "api_key=super-secret-token",
    "rpc is https://alice:password@example.test",
    `possible key ${"ab".repeat(32)}`,
    "rpc is https://example.test/?api_key=super-secret-token",
    "password is hunter-two",
    "Authorization: Bearer example-token-value-123456",
    "rpc is https://example.test/token/example-token-value-123456",
    "rpc is https://example.test/v2/examplecredentialvalue1234567890ab",
    "mnemonic is alpha,beta,gamma,delta,epsilon,zeta,eta,theta,iota,kappa,lambda,mu",
  ]) assert.throws(() => assertCopilotQuestionSafe(unsafe), /Do not paste private keys/);
  assert.equal(assertCopilotQuestionSafe("Use actor-0 as the disposable deployer"), "Use actor-0 as the disposable deployer");
});

test("Audit Copilot keeps only exact source citations and known finding ids", () => {
  const result = validateCopilotResult({
    source: "contract Token {\n  address public owner;\n}",
    findingIds: ["known"],
  }, {
    answer: "The owner is declared in source.",
    citations: [
      { lineStart: 2, lineEnd: 2, quote: "address public owner;", why: "owner declaration" },
      { lineStart: 1, lineEnd: 99, quote: "invented", why: "invalid" },
    ],
    relatedFindingIds: ["known", "invented"],
    suggestedNextSteps: Array.from({ length: 8 }, (_, index) => ({ type: "explain", label: `Step ${index}`, requiresConfirmation: false })),
    deploymentPlanCandidates: [{ deploymentPlan: { targetContract: "Token" } }],
    developerContextCandidates: Array.from({ length: 10 }, (_, index) => ({ category: "other", statement: `Context ${index}`, relatedQuestionIds: [] })),
  });
  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0].sourceValidated, true);
  assert.deepEqual(result.relatedFindingIds, ["known"]);
  assert.equal(result.requestedAction, "none");
  assert.equal(result.suggestedNextSteps.length, 5);
  assert.equal(result.deploymentPlanCandidates.length, 1);
  assert.equal(result.developerContextCandidates.length, 8);
});

test("Audit Copilot exposes only the bounded server continuation intent", () => {
  const base = {
    answer: "Proceeding with the current server action.", citations: [], relatedFindingIds: [], suggestedNextSteps: [],
    deploymentPlanCandidates: [], developerContextCandidates: [],
  };
  const requested = validateCopilotResult({ source: "contract T {}", findingIds: [] }, { ...base, requestedAction: "run-current-continuation" });
  const invented = validateCopilotResult({ source: "contract T {}", findingIds: [] }, { ...base, requestedAction: "run-shell-command" });
  assert.equal(requested.requestedAction, "run-current-continuation");
  assert.equal(invented.requestedAction, "none");
});
