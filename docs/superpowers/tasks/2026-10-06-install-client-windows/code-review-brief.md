# Code review — 2026-10-06-install-client-windows (2026-10-06)

**request-changes** · confidence: low · 8 blocking · 0 deferred · 1 filtered as noise
Coverage: blind — n/a (balanced profile) · edge-case ✓ · acceptance — n/a (no spec) · verification-gap — n/a (balanced profile)  (1/4 lenses ran)
No spec/story was available to check acceptance criteria against, which caps confidence at low regardless of the otherwise clean lens coverage.

## Look here first

- `src/cli/commands/proxy/client-install.ts:139` — [security] Windows installer path has no signature check, and its own checksum guard silently no-ops on a missing hash — CR-006
- `src/cli/commands/proxy/client-install.ts:202` — [infra] codex-desktop has no entry in windowsApplicationDirs, so the Store-only error fires even when ChatGPT is already installed — CR-007
- `src/cli/commands/proxy/client-install-step.ts:131` — [infra] VS Code CLI path joined from a file path, not the install dir — breaks the Claude Code extension install on Windows — CR-001
- `src/cli/commands/proxy/client-install-step.ts:133` — [infra] `.cmd` shim exec'd without `shell:true` — same extension-install step fails even once CR-001 is fixed — CR-002
- `src/cli/commands/proxy/client-install.ts:139` — [infra] installer-type filter accepts non-executable winget installer types (only excludes `msix`) — CR-005

## Also flagged

- `src/cli/commands/proxy/client-install.ts:129` — [infra] winget version-directory sort has no numeric-name filter, a non-version entry can corrupt it — CR-004
- `src/cli/commands/proxy/client-install.ts:372` — [infra] installer exit 0 isn't checked against the predicted install path actually existing — CR-008
- `src/cli/commands/proxy/client-install.ts:1` — [other] module header doc still describes a macOS-only trust model — CR-003

## Checked and clean

commit-format ✓
