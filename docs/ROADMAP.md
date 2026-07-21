# Attest desktop application roadmap

This roadmap covers packaging the current local browser MVP as a desktop
application. It does not claim that the planned application features are
already implemented.

## Current baseline — Hardened local browser release

Attest currently runs as a loopback-only local web application. The existing
interface and audit engine already provide the foundation for a desktop app:

- Load or paste a Solidity source file as a read-only audit copy.
- Detect locally installed Solidity audit tools.
- Compile with Foundry, let AI define whole-contract verification questions,
  then collect and normalize analyzer evidence.
- Complete evidence triage, optionally validate an ABI-grounded deployment plan,
  and deploy to disposable Anvil.
- Optionally design and execute question-linked Foundry tests, followed by a
  final read-only AI evidence review of source, assertions, and tool outcomes.
- Display workflow progress, cancellation, findings, and report exports.
- Sign in with ChatGPT through the locally installed Codex flow.

The browser MVP remains the hackathon deliverable. Desktop packaging is the
next product format, not a requirement for the current demonstration.

The current baseline now includes durable audit checkpoints and immutable report
revisions, restart recovery, bounded terminal-job retention, authenticated local
API reads and writes, session-only browser capabilities, owner-only runtime
storage, child-process cancellation, and report publication only after testing
closes. These controls make the local single-user release coherent; they do not
turn it into a hosted or multi-user service.

## Milestone 1 — Electron development shell

**Goal:** Run the existing Attest interface inside a desktop window without
changing the audit behavior.

Planned work:

- Add an Electron main process and load only packaged local application files.
- Run the existing Node audit engine in a separate utility process.
- Replace browser file upload with a native `.sol` file picker while preserving
  the read-only audit copy.
- Add a small allowlisted IPC bridge for audit start, status, cancellation,
  report export, and tool detection.
- Keep Node integration disabled in the renderer.
- Enable context isolation, renderer sandboxing, restrictive navigation, and a
  local-only content security policy.

Completion gate:

- The current end-to-end demo works inside Electron without opening a terminal
  or separate browser tab.
- The renderer cannot invoke arbitrary commands or access unrelated files.

## Milestone 2 — Windows MVP installer

**Goal:** Deliver a straightforward Windows installation for hackathon follow-up
and early testers.

Planned work:

- Build a Windows installer with Electron Forge.
- Add the Attest name, icon, version metadata, uninstall support, and application
  data directory.
- Start and stop the audit worker with the application lifecycle.
- Preserve local ChatGPT/Codex authentication in the application data directory.
- Store reports and manifests in an explicit user-selected location.
- Detect WSL and required audit tools without silently modifying the machine.
- Route missing dependencies to the existing Setup and how-to page.

Completion gate:

- A clean Windows machine can install, launch, inspect tool readiness, load a
  contract, run the available audit path, export a report, and uninstall Attest.

## Milestone 3 — Managed tool experience

**Goal:** Reduce setup friction without creating an unsafe package manager.

Planned work:

- Show installed, missing, incompatible, and unverified tool states.
- Pin supported tool versions and record them in every audit manifest.
- Offer reviewed installation helpers with official sources and checksum
  verification.
- Never download or execute mutable installers without explicit approval.
- Add per-tool update notices and compatibility checks.
- Keep advanced tools optional; a missing engine reduces coverage rather than
  blocking the entire application.

Completion gate:

- Tool setup is understandable to a new Solidity developer and reproducible by
  an experienced auditor.
- Dependency and installer integrity checks are documented and tested.

## Milestone 4 — Desktop reliability and security

**Goal:** Prepare the application for distribution beyond controlled demos.

Planned work:

- Preserve the current durable audit/revision model through desktop IPC.
- Preserve cleanup of Anvil and analyzer processes on cancellation or exit.
- Separate application logs from contract source and AI content.
- Add user-facing report retention controls and a clear delete-audit action on
  top of the current automatic bounded retention.
- Validate every IPC sender, input, file path, and output destination.
- Add automated desktop tests for installation, file loading, cancellation,
  offline operation, missing tools, and update behavior.
- Perform an independent review of Electron configuration and command execution
  boundaries.

Completion gate:

- The application leaves no orphan audit processes and does not expose Node,
  shell, authentication, or unrestricted filesystem capabilities to the UI.

## Milestone 5 — Signed cross-platform releases

**Goal:** Distribute trustworthy application packages for supported desktop
platforms.

Planned sequence:

1. Signed Windows installer.
2. Notarized and signed macOS package.
3. Linux packages selected according to audit-tool compatibility.
4. Signed update manifests and controlled application updates.
5. Published checksums, release notes, supported-tool matrix, and rollback path.

Each operating system needs its own validation because Foundry, Python tooling,
native analyzers, WSL integration, permissions, signing, and installer behavior
are platform-specific.

Completion gate:

- Users can verify the publisher and package integrity before installation.
- Updates cannot silently replace audit tools or change audit behavior without
  visible release information.

## Later desktop capabilities

Potential post-release additions:

- Open a complete Foundry project with explicit dependency boundaries.
- Compare saved versions and run regression campaigns.
- Configure consent-based fork profiles and local RPC endpoints.
- Maintain a local library of reports and audit manifests.
- Generate reviewable remediation proposals in a separate workspace.
- Optional team or hosted synchronization without making cloud access mandatory.

## Application principles

- Local-first operation remains the default.
- Submitted source is read-only in the audit workspace.
- Raw analyzer output is evidence input, not a vulnerability count.
- Missing tools reduce disclosed coverage; they do not create fake results.
- AI is optional and separate from deterministic compilation and analysis.
- A completed automated run is not described as proof of security or production
  approval.
- The desktop renderer never receives unrestricted Node, shell, or filesystem
  access.
