# Security tool suite decisions

Research date: 2026-07-17. The suite is organized by the evidence each tool can
add, not by logo count. A missing or inapplicable tool is reported as such.

| Tool | Decision | Unique role | Machine integration |
|---|---|---|---|
| Foundry / Forge | Active controller adapter | Compilation truth, unit/fuzz/invariant tests and traces | Question-bound generated harness plus captured result |
| Anvil | Active controller adapter | Fresh local EVM with typed ABI scenarios | Loopback JSON-RPC, bounded actors 0–3, normalized receipts |
| Pinned public forks | Active controller adapter | Ethereum/Base/BNB integration evidence | Server-owned RPC profile, verified chain and pinned block/hash |
| Compiler matrix | Active controller adapter | Offline compiler/version compatibility | Capped Forge build profiles with exact status |
| Slither | Active controller adapter | Mature broad or detector-focused static analysis | JSON plus normalized source-bound evidence |
| Aderyn 0.6.8 | Active controller adapter | Independent Rust static opinion | Pinned JSON adapter plus raw artifacts |
| Solhint 6.2.3 | Full-suite quality lane | Fast lint and hygiene | Exact-pinned JSON pass after AI profiling; update checks disabled and excluded from security corroboration |
| solc SMTChecker | Deferred adapter | Compiler-native BMC/CHC proofs and counterexamples | Standard JSON diagnostics |
| Mythril | Deferred adapter | Detector-driven multi-transaction symbolic witnesses | JSONv2; strict timeout |
| Echidna | Deferred adapter | Stateful property fuzzing and minimized counterexamples | JSON campaign/corpus output |
| Medusa | Alternative to Echidna | Parallel coverage-guided stateful fuzzing | JSON config/corpus; result adapter needs pinning |
| Halmos | Deferred adapter | Symbolic execution of Foundry properties | No stable report schema evidenced; pin/parser required |
| Wake | Optional | Independent IR/static framework, SARIF, Python detectors | SARIF / JSON-HTML |
| Scribble | Annotated projects only | Instruments developer properties for other engines | Standard JSON + source maps |
| hevm | Deferred | Symbolic EVM and bytecode equivalence | Human CLI output; custom pinned adapter needed |
| Kontrol | Deferred formal mode | KEVM semantics and reusable proofs | Heavy installation/proof workflow |
| Certora | External integration only | Industrial CVL formal verification | Hosted/commercial; source leaves machine |
| Semgrep | BYO-rules only | Easy custom cross-language patterns | JSON/SARIF; bundled-rule licensing needs review |

Primary sources:

- Foundry: https://github.com/foundry-rs/foundry and https://getfoundry.sh/
- Solidity compiler and SMTChecker: https://docs.soliditylang.org/en/latest/using-the-compiler.html and https://docs.soliditylang.org/en/latest/smtchecker.html
- Slither: https://github.com/crytic/slither
- Aderyn: https://github.com/Cyfrin/aderyn
- Mythril: https://github.com/ConsenSysDiligence/mythril
- Echidna: https://github.com/crytic/echidna
- Medusa: https://github.com/crytic/medusa
- Halmos: https://github.com/a16z/halmos
- Wake: https://github.com/Ackee-Blockchain/wake
- Solhint: https://github.com/protofire/solhint
- Scribble: https://github.com/ConsenSys/scribble
- hevm: https://github.com/argotorg/hevm
- Kontrol: https://github.com/runtimeverification/kontrol
- Certora: https://docs.certora.com/

## Pertinent-suite rule

Contract classification and declared intent choose the suite. A vault receives
share-accounting, donation/inflation, rounding, and preview-consistency tests. A
proxy receives initializer, admin, implementation-takeover, and storage-layout
tests. A memecoin receives fee accounting, exempt-role, launch-limit, liquidity,
swap-back, price-impact, MEV, and recovery tests. Tools are invoked only when
they can execute a relevant property or add independent evidence.

For **AI review**, no execution adapter is invoked. **Targeted verification**
uses only operations expected to alter or materially strengthen the conclusion.
**Full audit suite** requires an explicit completed, unavailable, unauthorized,
or inapplicable disposition for every active controller adapter.
