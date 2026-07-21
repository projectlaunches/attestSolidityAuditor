# Dependency and tool gate

Dependency review is performed while adding each tool, not deferred until the
end of the build.

## JavaScript packages

- `@openai/codex` is exact-pinned at `0.144.5` and installed with lifecycle
  scripts disabled.
- `solhint-community` is exact-pinned at `4.0.1` and installed with lifecycle
  scripts disabled. Its registry metadata reports MIT. The current dependency
  tree passes `npm audit`, but npm reports deprecated transitive packages
  `inflight@1.0.6` and `glob@8.1.0`. Solhint therefore runs as a bounded local
  lint lane in **Full audit suite** mode and is not trusted as security
  corroboration.

Latest release check (2026-07-20): `npm audit --offline` reported no known
cached vulnerabilities across production and development dependencies, and
`npm ci --ignore-scripts --dry-run` completed.
The online `npm audit --audit-level=high` check could not reach the npm registry
in the restricted validation environment (`EAI_AGAIN`), so an online advisory
refresh remains a release-machine gate. No package was added by the production
hardening work.

## Aderyn

- Aderyn is pinned at `0.6.8` for x64 Linux/WSL.
- The npm wrapper was not used because its lifecycle script downloads a binary
  without verifying the published checksum. Its package metadata also declares
  MIT while the bundled `LICENSE` and upstream repository use GPL-3.0.
- `scripts/install-aderyn.mjs` downloads the exact official release artifact
  and verifies SHA-256
  `ffd6ca658962e211a3ac821c646f69c8e14bf1b1001cbfe091bcd4535a691e46`
  before installing it under ignored `work/tools`.
- Installation and every capability probe also verify the extracted executable
  SHA-256 `a268d616826901e17717b1bc6368d8b2c063045a46fb99a0c0f657f102d977ca`
  and exact `aderyn 0.6.8` version text. PATH fallbacks are not accepted.
- The binary is an external GPL-3.0 audit tool; it is not linked into or
  redistributed with the application source.

## Compiler model checker

The setup page offers `solc-select 1.2.0` (AGPL-3.0) as an external, user-owned
compiler version manager and the distribution's Z3 package as a concise setup
example. Users select the compiler and solver versions appropriate for their
contract and workstation. These optional tools are not linked into,
redistributed with, or installed as package dependencies of attest.

## Public RPC profiles

- Ethereum uses the keyless PublicNode endpoint; Base and BNB use their public
  documented endpoints. No RPC SDK or new package was added.
- The server verifies the returned chain ID and pins the latest block number
  and hash before a fork run. Full URLs are not returned by the capabilities
  API or written to reports.
- These shared endpoints are rate-limited and observable and are suitable for
  the local demo, not production reliability. Request-supplied or credentialed
  URLs are deliberately unsupported until a loopback RPC gateway is added.
