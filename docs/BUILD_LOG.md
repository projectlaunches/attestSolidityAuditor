# Attest hackathon build log

This is the judge-facing engineering record for the hackathon build. It keeps
the decisions, failures, and validated outcomes that shaped the product without
publishing the full working conversation or private model reasoning.

## Build summary

| Date | Milestone | Demonstrable outcome |
| --- | --- | --- |
| July 17 | Product thesis and dependency gate | Defined AI-first auditing, local-only scope, immutable source, and dependency review before installation |
| July 18 | Working tool pipeline and browser UI | Added source intake, Slither, Aderyn, Solhint, Foundry compilation, Anvil groundwork, setup guide, and normalized evidence |
| July 19 | AI-led evidence workflow | Moved whole-contract reasoning before testing, added generated Foundry checks, final evidence review, public-chain fork controls, and gated exports |
| July 20 | Unified three-level audit controller | Replaced harness-first behavior with one AI controller, added the three engagement levels, constructor-aware Anvil deployment, and local release hardening |
| July 21 | End-to-end reliability and presentation | Repaired continuation and sign-in regressions, made the AI conclusion authoritative, consolidated the dialogue, bounded retries, and stabilized live progress |

## July 17 — From idea to defensible architecture

The initial idea was “upload Solidity and run security tools.” Research quickly
showed that this would reproduce the weakness of existing scan bots: many raw
warnings and very little judgment.

The product thesis became:

1. AI reads the entire contract before tools run.
2. AI identifies assets, roles, trust assumptions, and material properties.
3. AI selects pertinent evidence-producing operations.
4. Deterministic server adapters own commands, paths, limits, and permissions.
5. AI reviews the evidence against the immutable source and writes the result.

The dependency gate was established at the same time. Every package and tool had
to have a clear role, a reviewed install path, and a pinned or lockfile-backed
version. This prevented the common hackathon pattern of installing a large tool
stack first and auditing it later.

## July 18 — Turning scanners into an evidence pipeline

The first working vertical slice accepted one Solidity file, fingerprinted it,
compiled it, ran local analyzers, normalized their output, and rendered audit
artifacts.

Important decisions:

- Slither and Aderyn supply independent security evidence.
- Solhint diagnostics remain explicitly classified as code quality.
- Duplicate analyzer hits are clustered without losing provenance.
- Installed tools are capabilities, not blanket permission to execute them.
- Submitted code is a read-only audit copy; contract repair is outside the MVP.
- The setup page detects missing tools and provides reviewed installation paths.

The browser UI was iterated from a generic dashboard into a restrained local
workbench with Solidity highlighting, equalized tool cards, three clear audit
levels, and visible tool availability.

## July 19 — Letting AI decide what needs proof

Early runs exposed the core design error: deterministic harness planning was
asking users to resolve long lists of generic “not verified” questions. That was
the opposite of the product promise.

The workflow was reordered:

1. Whole-contract AI assessment.
2. Contract-specific verification questions.
3. Relevant analyzer, compiler, Foundry, Anvil, or fork operations.
4. Source-cited AI evidence adjudication.
5. A plain-language conclusion or a deliberately bounded continuation.

This phase also added generated Foundry unit, fuzz, and invariant checks;
loopback-only Anvil execution; built-in read-only Ethereum/Base/BNB fork
profiles; source-integrity checks around every external stage; and report
publication only after testing closes.

## July 20 — Replacing the harness with an audit controller

Smoke testing showed that simply generating more test plans still constrained
the AI too heavily. A small token contract produced boilerplate questions that
the model could answer by tracing source.

The pipeline was refactored around one typed controller. It can conclude from
source, select a registered operation, review returned evidence, request one
materially corrected test, or stop with a specific capability limitation. It
cannot write commands or alter the submitted contract.

Three engagement levels replaced overlapping checkboxes:

- **AI review** for source-grounded findings and an opinion.
- **Targeted verification** for the smallest evidence set needed to strengthen
  material blocker or funds-safety conclusions.
- **Full audit suite** for broad applicable coverage.

Fresh-Anvil deployment was expanded from zero-argument contracts to validated
primitive constructor fixtures derived from compiled ABI metadata. The app also
gained bounded typed ABI scenarios, receipt and runtime-bytecode checks, and a
minimal `SmokeCounter.sol` target for fast end-to-end testing.

## July 21 — Reliability, conclusions, and presentation

The final day focused on the difference between a prototype that technically
runs and a demo people can trust.

Confirmed regressions were traced and corrected rather than hidden:

- ChatGPT sign-in and stale local-session recovery.
- Source-file loading and new-audit state reset.
- Continuation controls that displayed choices without executing them.
- False developer-input requests manufactured from evidence labels.
- Anvil artifact selection after compiler-matrix runs.
- Reports generated before testing had actually closed.
- Tool failures that stalled the audit instead of becoming documented limits.
- A scrolling progress spinner that made active audits appear frozen.

The final presentation uses one Audit Copilot dialogue. It shows real Slither,
Aderyn, Foundry, Anvil, compiler, fork, and AI activity; keeps one fixed progress
dock at the bottom; preserves expanded evidence while polling; and ends with the
AI auditor's own scoped conclusion rather than a second generic verdict engine.

Failed Foundry or fork evidence receives one materially corrected retry for the
same property. If that also fails, Attest records the limitation, moves on, and
still produces a professional conclusion.

## Final verification

- Syntax validation: **39 source files passed**
- Automated tests: **41 of 41 test entrypoints passed**
- Dependency audit: **0 known vulnerabilities** from
  `npm audit --offline --audit-level=high`
- Runtime data, audit artifacts, and Codex authentication state: ignored under
  `work/` or stored below the private Attest data directory
- External-chain broadcasts: not supported
- Submitted-contract modification: not supported

## GitHub handoff

- Replaced the 1,572-line working log with this concise milestone record and
  added a separate, candid hackathon build story.
- Reworked the README around the product problem, three-level demo, actual
  capabilities, quick start, validation, and responsible limitations.
- Positioned the release clearly as a working MVP: the core orchestration model
  is validated, while commercial polish, packaging, and hosted infrastructure
  remain the next product phase.
- Added GitHub Actions validation and Dependabot coverage for npm and workflow
  dependencies.
- Confirmed that runtime audits, generated artifacts, and Codex authentication
  state remain excluded by `work/`; local `.env` files and editor/build output
  are ignored as well.
- Validated every local Markdown link and inspected the public package file set.
- The handoff validation caught a truncated smoke fixture, restored it, and then
  passed the three affected end-to-end workflows plus the complete test suite.

## What the build log demonstrates

The interesting part of this project is not that AI produced code quickly. It
is that natural-language product critique repeatedly changed architecture,
tests, safety boundaries, and user experience while the same system remained
runnable.

The human contribution was product direction, Solidity domain context,
skepticism about weak results, and relentless acceptance testing. Codex turned
that feedback into implementation, regression tests, dependency checks, and
documentation. The result is a useful full-stack developer tool, not a static
mockup and not a transcript disguised as a repository.
