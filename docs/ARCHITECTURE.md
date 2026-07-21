# Architecture and local release boundary

## Product promise

Drop in one Solidity contract and receive an evidence-backed audit with visible
tool provenance, AI-designed adversarial tests, and Markdown/JSON exports. A
clean run never means "secure"; it means no source-validated security concern
was surfaced by the review and execution stages that actually completed.

## AI-controlled execution flow

1. Validate a single UTF-8 Solidity source file and hash the exact input.
2. Probe local analyzer capabilities and record exact versions.
3. Build an isolated Foundry job project. Source, outputs, and project config
   stay job-local; Foundry may use the user's compiler cache and, if the exact
   compiler is not cached, may fetch that compiler version as a bounded fallback.
4. Ask Codex to act as the primary auditor: build a whole-contract model, trace
   logic and asset flows, record exact-cited source conclusions, and formulate
   verification questions only for claims that need stronger evidence before
   analyzer findings are supplied.
5. Apply the selected audit depth:
   - **AI review** concludes from exact-cited source reasoning and does not run
     execution adapters.
   - **Targeted verification** lets AI request only checks expected to change or
     materially strengthen a conclusion.
   - **Full audit suite** requires a completed, unavailable, unauthorized, or
     inapplicable disposition for every registered operation class.
6. Give AI a capability catalog derived from installed tools and explicit user
   permissions. AI can request only typed operations from the closed registry:
   Slither, Aderyn, compiler matrix, Foundry, fresh-Anvil scenario, or pinned
   fork. It never controls commands, arguments, paths, environment variables,
   URLs, keys, calldata, or submitted source.
7. Execute the selected operations with bounded time and output. Bind each
   evidence record to the immutable source hash, operation kind, operation-spec
   digest, and one verification-question ID.
8. Normalize tool-specific output into review touchpoints. These are leads for
   adjudication, not an issue count, and remain hidden from the findings view.
9. Ask Codex, through the official ChatGPT sign-in flow, to use the established
   contract model, group related detector leads, and triage them in checkpointed
   batches. Non-material observations are closed with cited context; plausible
   security-impacting groups receive deeper review. A slow batch is split and
   retried without discarding completed work.
10. Validate AI citations and finding IDs after every checkpoint. Only source-validated,
   security-relevant classifications can enter the findings view; rejected,
   intentional-design, quality, not-substantiated, and manual-review-required touchpoints remain summarized.
   AI review is not independent proof.
11. When Foundry or fork evidence is selected, ask a separate bounded AI turn to
   design contract-specific execution only where it adds evidence beyond source
   reasoning. Each
   disposable Foundry harness is bound to one atomic verification question,
   then compiled/run in the isolated job copy.
12. After every evidence batch, ask a read-only AI evidence turn to validate the
   oracle and answer every verification question. A Forge pass is execution
   evidence only; a
   Forge assertion failure is not a contract defect until the oracle is
   source-validated. Invalid generated tests produce no contract conclusion.
13. Repeat selection, execution, and adjudication until AI concludes, evidence
   is exhausted, developer input is required, the user cancels, the selected
   execution window ends, two rounds make no evidence progress, or the 64-operation
   safety envelope is reached.
14. Corroborate conservatively. A static finding plus a reproducing test is
   stronger than two model opinions.
15. Render question-led conclusions, exact evidence gaps, and the audit worklog.
16. When the developer chooses **Continue testing**, resume the same AI
   controller from the current evidence revision and selected time window. AI receives the
   unresolved set, selects pertinent validated local or read-only fork tests,
   repairs its disposable tests after non-evidentiary failures, and re-reviews
   accumulated evidence until questions settle, a specific blocker repeats,
   the developer cancels, or the selected window ends.
17. If a runnable recommendation remains, enter `awaiting-testing`: no Markdown,
   JSON download, or final conclusion is published. The developer either runs
   the continuing campaign or explicitly closes testing with the recorded gaps.
18. After testing closes, perform one final exact-source integrity check and
   atomically publish `findings.md`, `evidence.json`, and `worklog.json`.

## Audit Copilot discussion layer

The browser combines real audit worklog milestones, adaptive AI checkpoints,
and post-audit questions in a conversation-style Audit Copilot panel. It does
not stream private model reasoning or manufacture intermediate thoughts.

When a check is blocked on developer knowledge, the same panel accepts explicit
constructor fixtures and scoped context. Codex returns typed candidates, not an
execution command. The server validates deployment candidates against the
compiled ABI and records accepted information with `developer-chat`
provenance. The normalized local plan is displayed and becomes eligible for the
same revision-bound continuing campaign. Secrets are rejected before the
message is retained or sent to Codex.

Context that does not require chain execution is recorded with developer
provenance and applied during the next continuing campaign. The interface does
not create one action for every context or verification question.

The bottom of the existing Copilot dialogue contains at most three controls:
**Continue testing**, **Provide information** only for a genuine intent or
configuration blocker, and **Finish report**. Verification questions remain
inspectable evidence rather than per-question control cards. Historical feed
entries explain what ran and what it proved.

The result presentation leads with a practical-use verdict derived from
validated state, never unconstrained model prose. It distinguishes “do not use
as submitted,” “usable in the completed contract-specific test scope but not
cleared for deployment,” and “usability not established,” then names the exact
supported properties, failures, security concerns, decisions, and evidence gaps
behind that statement.

Follow-up questions are available only after the audit reaches a terminal
state, use the Ask button or Enter as the explicit additional-AI-turn action, and run in a new
ephemeral read-only Codex thread. Source-specific answers use structured exact
quotes and line ranges that the server validates before display. **Continue
testing**—or an unambiguous phrase such as “run it” when that is the sole
available action—authorizes one AI-directed campaign for the selected execution
window. Source, tool, network, cancellation, and machine-resource guardrails
remain server-controlled; the application does not impose an arbitrary AI-turn
count.

Informational discussion remains excluded from technical evidence. No report is
published merely because the initial pass finished. The final Markdown is a
short findings summary—not a pipeline transcript—and every point names its
location or audit-wide scope, evidence, impact, condition, conclusion, and one
specific action. Raw tool provenance and execution history stay in the JSON
evidence and worklog artifacts.

## Contextual adjudication

The tool asks the developer to declare contract intent, trusted roles, intended
behaviors, and accepted risks. Those assumptions influence classification but
never erase raw evidence. For example, a trusted owner may turn an access-control
alert into a documented centralization/trust disclosure, while compromised-key
and privilege-transfer tests remain pertinent. A memecoin swap-back with no
minimum output may be intentional, but still receives pool-depth, sandwich,
threshold, price-impact, and recovery tests before being labeled as an
assumption-dependent MEV risk rather than a generic vulnerability.

## Execution-environment ladder

1. Local compiler/Forge tests: fast, deterministic unit, negative, fuzz, and
   invariant evidence.
2. Symbolic/property workers: bounded Mythril, Echidna/Medusa, Halmos, or
   SMTChecker are deferred adapters. They remain in the roadmap and setup guide,
   but the active controller cannot claim to have run them.
3. Fresh Anvil chain: after the whole-contract AI review, the current opt-in
   slice validates a structured deployment plan against compiled artifact and
   constructor ABI metadata. Only an eligible concrete leaf target, bounded
   primitive arguments, Anvil actor indexes 0–3, and payable-compatible value
   can proceed. Constructor encoding uses Foundry Cast with direct arguments;
   the model cannot supply paths, bytecode, RPC URLs, or keys. The runner then
   verifies the receipt/code and records development actors. A sole
   zero-argument target deterministically deploys from disposable actor 0 even
   if the advisory AI plan requested production deployer intent. Before the
   snapshot, the runner records bounded read-only observations for common ABI
   views (`totalSupply`, two actor balances, and `owner`) when present, then
   can execute a bounded AI-selected sequence of typed ABI reads and
   transactions against the deployed submitted artifact, then shuts the chain
   down. Ambiguous targets, external contract dependencies,
   unsupported tuple/array arguments, and material economic configuration are
   reported as needing developer input. Scenario actors are limited to local
   accounts 0–3; external targets and arbitrary calldata are not representable.
4. Pinned Foundry fork: a current AI recommendation can use built-in keyless
   Ethereum, Base, or BNB RPC profiles. The server verifies the expected chain,
   pins a block number and hash, and runs the authorized harness in Foundry's
   local forked EVM.
5. Optional read-only live simulation: `eth_call`/trace-style checks only, when
   a user explicitly supplies an RPC endpoint.

The fork runner redacts RPC URLs and never accepts a request-supplied URL,
private key, command, path, source, or test body. It has no external signing or
broadcast path. Revised reports record network, expected chain ID, pinned block
number/hash, redacted host, tool result, and execution budget. Public endpoints
are rate-limited and observable; credentialed overrides remain outside this
slice until a loopback gateway can keep secrets out of child processes and
reports.

## Local components

- `src/server`: loopback-only Node service, job orchestrator, safe subprocess
  runner, tool adapters, Codex app-server client, report generator.
- `src/server/ai/review-queue.js`: conservative evidence grouping, batching,
  triage expansion, and explicit terminal manual-review fallbacks.
- `src/web`: dependency-free browser interface served by the local service.
- `$ATTEST_DATA_DIR/work/jobs/<id>`: owner-only per-audit source, raw tool
  output, generated tests, durable checkpoints, and immutable report revisions.
  `ATTEST_DATA_DIR` defaults to `$HOME/.local/share/attest`.
- `$ATTEST_DATA_DIR/work/codex-home`: owner-only app-managed Codex login state.
  Tokens are never read by Attest or included in logs and reports.
- `$ATTEST_DATA_DIR/session-url.txt`: owner-only private browser-session URL,
  published atomically only after the loopback listener successfully binds.

Every API route except the non-sensitive health check requires an unpredictable
per-process capability supplied through the private URL fragment. After a
backend restart, the trusted same-origin browser client may refresh the current
capability through a no-store endpoint and retry the interrupted request once.
The same endpoint bootstraps a direct visit to the loopback URL, so no token-file
onboarding is required. Refresh requires a custom same-origin request and rejects
cross-site browser requests. Mutation routes additionally enforce a matching
loopback Origin when the browser sends
one. Static HTML never contains the capability; the browser keeps it only for
the current tab session, and authenticated downloads use the same API client.
The runtime root, session URL, job directories, and Codex state are owner-only.

This is a single-user local authorization boundary, not a multi-user service.
Processes running as the same operating-system user can still inspect that
user's memory and files. A packaged product should prefer an OS-protected IPC
channel; a hosted product additionally needs external identity, tenant and
worker isolation, secret management, abuse controls, and independent review.

Job state survives refresh and process restart. A restart converts interrupted
audits and Copilot turns into explicit recoverable states, reconciles committed
report manifests with checkpoints, and retains immutable historical report
revisions. Retention is bounded to the 100 newest terminal jobs or 2 GB; active
jobs are never pruned.

## Submitted-source invariant

`src/Target.sol` is a sealed audit snapshot, not a repair workspace. The server
writes it once, changes it to read-only, retains the canonical bytes/hash in job
state, and checks both immediately before and after external analyzers, generated
tests, evidence review, targeted passes, and findings publication. A mismatch
stops execution and prevents publication.

Generated harnesses must import exactly `../src/Target.sol`. A property can count
only when its asserted receiver was instantiated as a contract declared in that
source. A no-import decoy, unused import plus look-alike, or derived substitute
cannot become target evidence. Codex has read-only filesystem access and is
explicitly prohibited from returning replacement Solidity, patches, or diffs.

## Finding confidence

Raw analyzer output is retained as tool evidence and counted as AI touchpoints,
not vulnerabilities. The browser and exported report expose individual security
finding cards only after completed AI adjudication validates their cited source
and classifies them as a vulnerability or assumption-dependent concern.

- `static-only`: reported by one deterministic analyzer.
- `corroborated`: supported by two independent deterministic tools.
- `test-executed`: generated assertions compiled and ran, but semantic
  reproduction still requires a vetted per-finding oracle.
- `confirmed-by-test`: a reviewed test and finding-specific oracle actually
  reproduce the claimed behavior; Forge exit status alone is never enough.
- `ai-reviewed`: the model checked source/evidence, but this is not independent
  confirmation.
- `disputed` / `needs-review`: evidence conflicts or is incomplete.

## Tool tiers

- Active controller: Foundry build/test, typed fresh-Anvil ABI scenarios,
  Slither JSON, checksum-pinned Aderyn JSON, offline compiler matrices, and
  pinned read-only Foundry forks.
- Full-suite quality support: exact-pinned Solhint diagnostics run after the AI
  source profile in **Full audit suite** mode. They remain a separate quality
  lane and cannot corroborate or negate a security finding.
- Deferred: SMTChecker with a compatible pinned solver and bounded Mythril symbolic
  analysis. A local probe confirmed that SMTChecker cannot currently complete
  because the required Z3/Horn solver library is unavailable.
- Harness-aware: Echidna and Halmos only when compatible properties/tests exist.
- Alternatives: Wake for another static implementation; Medusa instead of
  Echidna when its parallel fuzzer is the better fit.
- Infrastructure: exact compiler/settings matrix with a hard version cap.

All unavailable, skipped, failed, and timed-out checks remain visible in the
report. This MVP does not repair submitted source. The source stays read-only,
and nothing is deployed or broadcast externally. The explicit fresh-Anvil
option is confined to its disposable loopback chain.
