# Built by conversation: the Attest hackathon story

Attest was created from scratch during this hackathon to test a direct question:

> Can natural-language collaboration with GPT produce a useful full-stack
> Solidity developer tool—not just a landing page or a thin AI wrapper?

## The build claim

This repository was strictly vibe-coded.

The human participant supplied the idea, Solidity and product context, security
expectations, design critique, and hands-on acceptance testing. Codex generated
and iterated the application code, tests, architecture, documentation, tool
adapters, and debugging instrumentation through conversation. The full working
conversation is not committed; this document and the condensed build log record
the decisions and outcomes that matter to reviewers.

## What “vibe-coded” meant here

It did not mean asking for an entire application once and accepting the first
output. The working loop was:

1. Describe the product behavior in ordinary language.
2. Let Codex inspect, design, and implement a bounded change.
3. Run the real application and real local security tools.
4. Challenge confusing, inconclusive, or unsafe behavior.
5. Trace the failure end to end, add a regression test, and iterate.
6. Audit dependencies continuously instead of postponing review until the end.

That loop changed the product substantially. Attest began as a conventional
multi-tool scanner. Testing showed that raw findings and deterministic harness
queues were not useful to ordinary developers. The final architecture instead
uses AI as the coordinating auditor and deterministic tools as controlled
sources of evidence.

## The full-stack result

The hackathon build includes:

- A browser workbench and local Node.js service.
- ChatGPT account sign-in through Codex app-server.
- Immutable Solidity intake and SHA-256 source-integrity enforcement.
- AI whole-contract modeling and a typed audit control loop.
- Slither, Aderyn, Solhint, Foundry, compiler-matrix, Anvil, and read-only fork
  adapters.
- AI-designed unit, fuzz, invariant, deployment, and ABI scenario testing.
- Evidence normalization, provenance, and source-cited adjudication.
- One live dialogue for progress, tool results, conclusions, and follow-up.
- Markdown and JSON audit artifacts generated only when testing is closed.
- 41 automated test entrypoints and an ongoing dependency gate.

## Where GPT was powerful

GPT was most useful where rigid automation normally fails:

- Recognizing that a trusted owner is a declared trust assumption, not
  automatically a vulnerability.
- Distinguishing ordinary token behavior from a material funds-safety issue.
- Tracing value and privilege through the whole source before choosing tests.
- Designing contract-specific evidence checks instead of a fixed three-test
  template.
- Deciding that a clean small contract may not need every available tool.
- Reading failed tool evidence as a limitation rather than falsely blaming the
  submitted contract.
- Translating technical evidence into an opinion a less-experienced developer
  can act on.

## Where human direction mattered

The most important improvements came from rejecting outputs that were
technically valid but product-wise wrong: seventy untriaged “issues,” generic
“not verified” lists, repeated requests for obvious constructor intent, reports
written too early, and progress displays that looked frozen.

Those critiques forced architectural changes. The project became AI-first,
source-first, conclusion-oriented, and visibly honest about what did and did
not run.

## Responsible boundary

Attest is intentionally an MVP, not a finished polished product. But it is a
working MVP with the difficult foundation already demonstrated: AI-led audit
planning, controlled tool execution, evidence adjudication, local-chain testing,
immutable inputs, and actionable reporting all operate as one system. The next
phase is expansion and productization, not proving that the central idea can
work.

The current release targets a trusted local workstation. It does not claim to
prove that a contract is secure, replace an independent audit, or provide a
hosted multi-tenant security boundary. It never broadcasts external-chain
transactions or modifies submitted Solidity.

That boundary is part of the demonstration: vibe coding can move quickly while
still producing explicit permissions, immutable inputs, bounded execution,
dependency review, regression tests, and candid limitations.

## Why this matters

Many developers know that Foundry, Slither, Anvil, fuzzing, invariants, and fork
testing exist, but not which combination answers the risks in the contract in
front of them. Attest turns that fragmented expertise into a guided audit
conversation backed by real execution.

The hackathon result is therefore both the product and the proof: a useful
developer-security workbench created through conversation, tested through use,
and improved by treating GPT as an engineering collaborator rather than a code
autocomplete box. Attest is early, but the model is validated and the path from
hackathon MVP to a serious developer product is concrete.
