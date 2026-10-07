# Technical Research

**Task**: proxy client-install windows macos cli
**Generated**: 2026-10-06T00:00:00Z
**Research path**: filesystem

---

## 1. Original Context

Ticket EPMCDME-15627: Add a Windows client-install flag for `codemie proxy connect`, mirroring
the macOS `--install-client` flag added in EPMCDME-15626 (branch
semert/EPMCDME-15626_install-client-macos, already merged into this branch's history as of
commits b44e2985..1af4961c).

Those commits added:
- feat(proxy): add client install step for proxy connect
- feat(proxy): add --install-client and --yes to proxy connect
- docs(proxy): document --install-client for proxy connect
- fix(proxy): handle disk errors and timeouts in client install
- fix(proxy): never leave a half-copied client app behind

Key files from that work: src/cli/commands/proxy/client-install.ts,
src/cli/commands/proxy/client-install-step.ts, src/cli/commands/proxy/connect-orchestrator.ts,
src/cli/commands/proxy/connectors/codex-desktop.ts, src/cli/commands/proxy/index.ts,
docs/COMMANDS.md, README.md, plus the test files under
src/cli/commands/proxy/__tests__/client-install*.test.ts and connect-orchestrator/connect-wiring
tests.

Research task: understand exactly how the macOS --install-client implementation works end to
end (CLI flag wiring, client-install step/orchestrator logic, how it detects/copies the macOS
client app, error handling for disk/timeout issues, connector integration e.g.
codex-desktop.ts), so that a Windows equivalent can be planned. Identify what is macOS-specific
(paths, app-bundle copy mechanics, OS detection branches) versus what's already
platform-generic and reusable. Note any existing Windows-specific code elsewhere in the repo
(installer scripts, windows-installer-shell-detection work) that the Windows client-install flag
should align with or reuse.

---

## 2. Codebase Findings

### Existing Implementations

**`src/cli/commands/proxy/client-install.ts`** — the macOS install engine.
- `ClientApp = 'claude-desktop' | 'vscode' | 'codex-desktop'`, each described by a `ClientSpec`:
  `{ app, label, bundle, teamId, kind: 'zip'|'dmg', downloadPage, resolve }`.
- `CLIENT_SPECS` record hardcodes one macOS download URL per app (VS Code update API, Claude
  Desktop `RELEASES.json` feed, a static Codex `.dmg` URL) and a macOS code-signing `teamId` for
  each (Apple Developer Team ID, checked via `codesign`).
- `applicationDirs(home)` returns `['/Applications', join(home, 'Applications')]` — hardcoded
  macOS bundle install locations.
- `findInstalledClient(spec, dirs)` — existence check for `<dir>/<spec.bundle>` (an `.app`
  bundle directory), platform-agnostic in shape but fed macOS-only `dirs`/`bundle` values today.
- `downloadToFile(url, dest, sha256, fetchImpl, stallMs)` — streams to disk via `fs` streams,
  hashes with `node:crypto`, aborts on stall or write error (ENOSPC/EACCES/EPERM). **Fully
  platform-generic** — no macOS API calls.
- `verifyBundle(bundlePath, teamId)` — runs `/usr/bin/codesign --verify --deep --strict` then
  `/usr/bin/codesign -dv`, parses `TeamIdentifier=` line. **macOS-only** (Gatekeeper/codesign is
  not available on Windows; Windows uses Authenticode / `signtool`/`Get-AuthenticodeSignature`).
- `bundleVersion(bundlePath)` — runs `/usr/bin/plutil -extract CFBundleShortVersionString raw
  <bundle>/Contents/Info.plist`. **macOS-only** (reads a `.app` bundle's `Info.plist`; Windows
  apps don't have this structure — version would come from the installer/EXE's file version
  resource or a post-install check).
- `installClient(spec, opts)` — the orchestration:
  1. Hard-gates on `process.platform !== 'darwin'` and throws `ClientInstallError` immediately —
     **this is the single platform gate for the whole module.**
  2. Resolves download via `spec.resolve(fetchImpl)`, streams to a temp `work` dir
     (`mkdtemp(tmpdir())`).
  3. Unpacks: `kind === 'zip'` → `/usr/bin/ditto -x -k pkg root`; `kind === 'dmg'` →
     `/usr/bin/hdiutil attach -nobrowse -readonly -noautoopen -mountpoint mnt pkg`. **Both
     macOS-only system tools.**
  4. Verifies signature (`verifyBundle`), logs version (`bundleVersion`).
  5. Copies atomically: `ditto src staging` into a hidden `.{bundle}.codemie-partial` name
     inside `destDir`, then `rename(staging, dest)` — this rename-after-copy pattern is the fix
     from commit `1af4961c` ("never leave a half-copied client app behind") and is
     **platform-generic** (works with `fs.rename` on Windows too, modulo cross-volume rename
     caveats).
  6. `finally`: removes `staging`, detaches the dmg mount (`hdiutil detach ... -force`), removes
     `work`. The detach step is macOS-only; cleanup of `staging`/`work` is generic.
  7. Error mapping distinguishes checksum mismatch, disk/perm errors (`ENOSPC`/`EACCES`/`EPERM`),
     download failures, and OS-refused copy (`cp.code !== 0` → "IT policy" message) — this error
     taxonomy is reusable as-is.
- `InstallClientOptions` (`destDir`, `workDir`, `fetchImpl`, `log`, `download`) is a clean
  dependency-injection surface already used by every test; a Windows path would plug into the
  same options shape.

**`src/cli/commands/proxy/client-install-step.ts`** — the connect-time orchestration step.
- `assertInstallClientSupported(opts, platform)` — **the second (CLI-facing) platform gate**:
  throws `ConfigurationError('--install-client is only supported on macOS.')` for any
  `platform !== 'darwin'`, and separately rejects `--insiders` (VS Code Insiders isn't
  installed by the CLI). Called by `connect-orchestrator.ts` before any network work.
- `neededApps(targets)` — maps `ConnectTargets` (`claudeDesktop`, `codexDesktop`,
  `vscode`/`vscodeClaudeCode`) to the `ClientApp` set. Platform-agnostic.
- `resolveDownload(spec)` — wraps `spec.resolve(fetch)` failures into `ClientInstallError`.
  Platform-agnostic.
- `confirmInstall(spec, download)` — dynamic `import('inquirer')` confirm prompt showing size in
  MB. Platform-agnostic.
- `ensureClientsInstalled(targets, opts)` — for each needed app: skip if
  `findInstalledClient` finds it; else require TTY or `--yes`; else prompt (unless `--yes`);
  then `installClient`. After all installs, if VS Code was installed, `mkdir`s
  `getVsCodeProductDir(false)` (already cross-platform, see below) and, for
  `vscodeClaudeCode`, runs `<vscodePath>/Contents/Resources/app/bin/code --install-extension
  anthropic.claude-code` — **the VS Code CLI path (`Contents/Resources/app/bin/code`) is a
  macOS `.app` bundle layout and would need a Windows equivalent** (Windows VS Code ships
  `Code.exe`/`bin\code.cmd` directly under the install dir, no `Contents/Resources/app`).

**`src/cli/commands/proxy/connect-orchestrator.ts`** — top-level wiring.
- `ConnectOptions.installClient?: boolean` and `.yes?: boolean` fields; doc comment says
  "(macOS only)".
- In `connectTargets()`: `if (opts.installClient) assertInstallClientSupported({ yes, insiders
  })` runs first (platform gate), then later `if (opts.installClient && (await
  ensureClientsInstalled(...)) === 'cancelled') return;` runs after SSO/profile resolution but
  before the daemon is ensured.
- `printProxyError` has a dedicated branch for `ClientInstallError` that also prints
  `error.downloadPage` — reused by both macOS and (presumably) Windows failures.
- `TARGET_LIST` (printed on bare `connect`) documents `--install-client` as "(macOS)" and
  `--yes` only in that context.

**`src/cli/commands/proxy/connectors/codex-desktop.ts`** — connector consuming client-install.
- `getCodexDesktopAppCandidates()` **already branches on `process.platform`**: `darwin` →
  `/Applications/ChatGPT.app`, `~/Applications/ChatGPT.app`; `win32` →
  `%LOCALAPPDATA%\Programs\ChatGPT`, `%ProgramFiles%\ChatGPT`; anything else → `[]`. This is the
  one connector in the chain that is **already Windows-aware** for detection (not install).
- `findCodexDesktopApp(candidates)` — platform-agnostic existence check reused by
  `connect-orchestrator.ts`'s `runCodexDesktop` to decide whether to error ("not supported on
  <platform> (macOS and Windows only)" when `candidates.length === 0`, i.e. Linux) or hint
  "re-run with --install-client on macOS" when candidates exist but none is found — this hint
  string is the one place in the connector that is explicitly macOS-only and would need
  updating for a Windows install path.
- Everything else in this file (config.toml splice/backup/restore via `@iarna/toml`, model
  discovery/selection, atomic write via `connectors/vscode.ts#writeAtomically`) is fully
  platform-generic.

**`src/cli/commands/proxy/index.ts`** — Commander wiring.
- `connect.option('--install-client', 'Download and install the app if missing (macOS)')` and
  `-y, --yes` are declared once on the parent `connect` command and forwarded verbatim into
  `connectTargets({... installClient: Boolean(opts.installClient), yes: Boolean(opts.yes) })`.
  No platform branching lives in this file; the gate happens downstream in
  `assertInstallClientSupported`.

### Architecture and Layers Affected

- **CLI/command layer** (`src/cli/commands/proxy/index.ts`) — flag declaration/parsing only, no
  platform logic.
- **Orchestration layer** (`connect-orchestrator.ts`, `client-install-step.ts`) — sequencing,
  confirmation UX, platform gate (`assertInstallClientSupported`), target-to-app mapping.
- **Install-mechanics layer** (`client-install.ts`) — download, verify, unpack, atomic copy;
  this is where essentially all macOS-specific OS-tool invocation (`ditto`, `hdiutil`,
  `codesign`, `plutil`) lives, behind the single `installClient()` entry point.
- **Connector layer** (`connectors/codex-desktop.ts`, `connectors/vscode.ts`,
  `connectors/desktop.ts`) — already cross-platform for config writing and (for Codex) app
  *detection*; only the "where do I suggest installing from" messaging is macOS-specific.
- **Shared utils** (`src/utils/exec.ts`, `src/utils/windows-path.ts`, `src/utils/paths.ts`,
  `src/utils/native-installer.ts`) — generic process execution and Windows PATH/registry
  helpers used by an unrelated feature (native CLI agent installers), not currently imported by
  `client-install.ts`.

### Integration Points

- `client-install.ts` → `node:crypto`, `node:fs`, `node:fs/promises`, `node:os`, `node:path`,
  `@/utils/exec.js` (process spawning with timeout), `@/utils/errors.js` (`CodeMieError` base for
  `ClientInstallError`), `@/utils/logger.js`.
- `client-install-step.ts` → `client-install.js`, `connectors/vscode.js#getVsCodeProductDir`,
  `connect-orchestrator.js#ConnectTargets` (type only), `@/utils/errors.js`, `@/utils/exec.js`,
  dynamic `inquirer` import.
- `connect-orchestrator.ts` → `client-install.js#ClientInstallError`,
  `client-install-step.js#{assertInstallClientSupported, ensureClientsInstalled}`.
- External services touched by the macOS path: VS Code update API
  (`update.code.visualstudio.com`), Claude Desktop release feed (`downloads.claude.ai`), a
  static ChatGPT desktop `.dmg` URL (`persistent.oaistatic.com`). None of these URLs are
  platform-templated today — each `resolve()` is hand-written per app and currently assumes a
  macOS artifact (`darwin-universal` zip, `.dmg`).
- `src/utils/exec.ts#exec()` is already cross-platform: on `win32` it resolves full paths to
  avoid `shell: true` deprecation warnings and sets `windowsHide: true`; `client-install.ts`'s
  own `run()` helper wraps this `exec` with a 5-minute timeout and is reused unmodified by any
  Windows helper-process calls (e.g. an MSI/EXE silent install, Authenticode check) if added.

### Patterns and Conventions

- **Download → verify → atomic install** is the core pattern: never touch the destination until
  the source is downloaded, hash/signature-checked, and copied under a hidden
  `.{name}.codemie-partial` staging name, then `rename()`'d into place. Any Windows
  implementation should keep this shape (stage under a temp/hidden name, `rename` at the end) to
  preserve the "never leave a half-copied app" guarantee from commit `1af4961c`.
  - MSI/EXE installers that run silently to a fixed install path do not fit a "stage then
    rename" copy model the same way `ditto`/`hdiutil` do — note (not an assertion of design)
    for later planning.
- **Single platform gate pattern** — `installClient()` and `assertInstallClientSupported()`
  both gate on `process.platform` at the top of the function and throw a typed error
  (`ClientInstallError` / `ConfigurationError`) immediately, before any side effect. Any new
  platform support extends these same two gates rather than adding gates elsewhere.
- **`ClientSpec.resolve(fetchImpl)` as the per-app, per-platform download resolver** — each app
  already encapsulates its own feed-parsing logic (`parseVsCodeLatest`, `parseClaudeReleases`,
  static URL for Codex). A Windows artifact would most naturally be a platform branch inside the
  same `resolve()` (e.g. VS Code's update API already supports a `win32-x64` channel param), not
  a parallel spec table — **this is design, see Section 6**.
- **Platform-conditional path builders already exist elsewhere in this codebase** for the
  *config* side of these same three apps:
  - `connectors/vscode.ts#getVsCodeProductDir(insiders)` — `darwin` →
    `~/Library/Application Support/<Code|Code - Insiders>`; `win32` → `%APPDATA%\<Code|Code -
    Insiders>`; `linux` → `$XDG_CONFIG_HOME/<Code|Code - Insiders>`. This function is already
    used by `client-install-step.ts` after a VS Code install and needs no change for Windows.
  - `connectors/desktop.ts#getDesktopBaseDir()` → delegates to `getClaudeDesktopBaseDir()`,
    documented as macOS `~/Library/Application Support/Claude-3p`, Windows
    `%LOCALAPPDATA%\Claude-3p`, Linux `$XDG_CONFIG_HOME/Claude-3p`.
  - `connectors/codex-desktop.ts#getCodexDesktopAppCandidates()` — already has the `win32`
    branch for *detecting* ChatGPT.app-equivalent on Windows (see above).
  - None of these three write the *installed app itself* — they only locate/write the app's
    *config*. The gap is specifically the download+install step in `client-install.ts`.
- **Windows-specific utility code exists but is for a different feature.**
  `src/utils/native-installer.ts` and `src/utils/windows-path.ts` implement Windows support for
  installing CLI *agents* (e.g. Claude Code's own `claude` binary) via a curl-piped installer
  script, with PATH/registry fixups (`setx`, `reg query HKCU\Environment`) and PowerShell
  execution-policy auto-fix. This is a sibling problem (CLI tool installation) solved
  independently of `client-install.ts` (desktop *app* installation into `~/Applications`), and
  shares no code with it today. The recent commit `971d459a` ("fix(utils): detect Windows shell
  type for correct installer selection", on branch
  `origin/fix/windows-installer-shell-detection`, not yet in this branch's history) adds a
  `detectWindowsShell()` helper to `native-installer.ts` to distinguish PowerShell / Git
  Bash/MSYS2 / CMD at runtime and pick between a PowerShell-flavoured and a CMD-flavoured
  installer URL. That shell-detection helper is the one piece of *reusable precedent* for "which
  shell am I actually running under on Windows" that a Windows client-install implementation
  (if it needs to invoke `msiexec`, `Expand-Archive`, Authenticode checks, etc. via PowerShell)
  should look at before writing new shell-detection logic from scratch.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/` exists (`architecture/`, `development/`, `integration/`, `security/`,
  `standards/`, `testing/`, `usage/`, `project.md`, `quality-gates.md`) but a direct search of
  `.ai-run/` for `install-client` / `client-install` returned no matches — the guides do not yet
  document this feature's design. `.ai-run/guides/integration/external-integrations.md` covers
  provider plugins generically; it was not read in full here since the task's own named files
  are the primary source for this feature.
- `docs/COMMANDS.md` documents the macOS flag in two places: the proxy command summary
  (`codemie proxy connect --claude-desktop --install-client [--yes]  # Install the app first if
  missing (macOS only)`) and the Codex section (`codemie proxy connect --codex-desktop
  --install-client --yes   # macOS: install the app first if missing`), plus a composed-flags
  paragraph: "on macOS `--install-client` (download and install a missing app first) with
  `--yes` (skip its confirmation)."
- `README.md` contains one matching line (not fully read; grep context shows a one-line mention
  near other proxy examples) — same macOS-only framing.

### Architectural Decisions

- Inline comments in `client-install.ts` record two deliberate decisions directly relevant to a
  Windows port: (1) "Nothing is bundled: each app comes from its vendor when asked for" — no
  app binaries are shipped inside this package; (2) apps go into `~/Applications` specifically
  "so no administrator password is ever needed" — a Windows equivalent will need its own
  no-admin-required install location decision (e.g. per-user `%LOCALAPPDATA%\Programs\...`,
  which is exactly where `getCodexDesktopAppCandidates()` already expects ChatGPT to land on
  Windows, and where VS Code's own per-user installer places itself).
- The staged-copy-then-rename pattern is explicitly commented as a fix for "a copy cut short
  (killed, timed out) never looks like an installed app" (commit `1af4961c`).
- `codex-desktop.ts` records a decision to deliberately avoid `getCodexHomePath()` (the
  CODEX_HOME redirect used for the Codex *CLI* child process) because "the desktop app never
  reads that home" — a reminder that desktop-app config paths and CLI-agent config paths are
  intentionally kept separate in this codebase.

### Derived Conventions

- Every new platform branch in this codebase keys off `process.platform` directly (no central
  "platform" enum/service beyond `src/utils/platform.ts#getPathModule`, which only abstracts
  `path.win32`/`path.posix` for path math, not OS detection).
- Error classes are specific (`ClientInstallError extends CodeMieError`, carrying
  `downloadPage`) rather than generic `Error`, consistent with `AGENTS.md`'s "throwing generic
  Error" pitfall.
- All destructive/filesystem side effects in this module go through `try/finally` cleanup
  blocks that remove temp/staging artifacts even on failure — a convention to preserve for any
  Windows unpack/copy step.

---

## 4. Testing Landscape

### Existing Coverage

- `src/cli/commands/proxy/__tests__/client-install.test.ts` — unit tests for the
  platform-generic pieces (`parseVsCodeLatest`, `parseClaudeReleases`, `parseTeamIdentifier`,
  `findInstalledClient`, `downloadToFile`) run unconditionally; the `installClient` (macOS)
  describe block uses `describe.skipIf(!isMac)` and drives **real** `ditto`/`hdiutil`/`codesign`
  against a locally built "Stand In.app" fixture (ad-hoc self-signed). A separate
  `describe('installClient off macOS', ...)` test overrides `process.platform` to `'win32'` and
  asserts `installClient()` rejects with `'only supported on macOS'` — **this is the one
  existing test that directly encodes today's Windows behavior (reject) and will need to change
  shape once Windows is supported**, not merely be deleted.
- `src/cli/commands/proxy/__tests__/client-install-copy.test.ts` — macOS-only
  (`describe.skipIf(process.platform !== 'darwin')`), mocks `exec` to simulate a `ditto` copy
  that writes half the app then fails, asserting nothing partial is left behind.
- `src/cli/commands/proxy/__tests__/client-install-step.test.ts` — fully mocks
  `client-install.js`, `exec.js`, `node:fs/promises`, `connectors/vscode.js`, and `inquirer`, so
  it runs on any platform; includes an `assertInstallClientSupported` describe block that is
  `it.each(['win32', 'linux'])('rejects %s', ...)` — **this will need a Windows-passes case
  added/changed** once Windows is a supported platform.
- `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts` — mocks
  `client-install-step.js` wholesale; covers the orchestration sequencing (`installClient` runs
  before daemon start, `'cancelled'` short-circuits, `ClientInstallError` surfaces via
  `printProxyError`, the step is skipped entirely when `installClient` is falsy, and an
  "unsupported platform" case exits before SSO verification). None of these assert on
  `process.platform` directly — they drive behavior through the mocked
  `assertInstallClientSupported`/`ensureClientsInstalled`, so they are platform-agnostic as
  written.
- `src/cli/commands/proxy/__tests__/connect-wiring.test.ts` — asserts the Commander wiring
  passes `--install-client`/`--yes` through to `connectTargets()`; platform-agnostic.

### Testing Framework and Patterns

- Vitest (`vitest.config.ts`, `@group unit` doc comments). Dynamic `import()` after
  `vi.mock(...)` calls is the established mocking pattern for ESM modules (per
  `AGENTS.md`/testing guide), used throughout `client-install-step.test.ts` and
  `connect-orchestrator.test.ts`.
- `tests/helpers/temp-workspace.ts` (`TempWorkspace`) provides isolated temp directories with
  `cleanup()` for filesystem-touching tests (`client-install.test.ts`,
  `client-install-copy.test.ts`).
- `process.platform` is overridden in tests via `Object.defineProperty(process, 'platform',
  { value: ..., configurable: true })` rather than a mocking library — the established pattern
  for exercising cross-platform branches without an actual OS switch.
- `describe.skipIf(...)` is the convention for OS-dependent integration-style tests that shell
  out to real system binaries (`ditto`, `hdiutil`, `codesign`) rather than mocking them —
  implying a Windows equivalent exercising real `msiexec`/PowerShell/Expand-Archive would likely
  follow the same `describe.skipIf(process.platform !== 'win32')` convention, run only in CI on
  Windows runners.

### Coverage Gaps

- No test anywhere exercises a Windows *install* code path (only the "rejects on win32" guard
  tests exist) — this is expected since the feature does not exist yet, not a gap in existing
  coverage.
- No test fixture exists for a `.exe`/`.msi`/`.msix` artifact equivalent to the macOS "Stand In"
  `.app` fixture-building helpers (`standIn()`, `pack()` in `client-install.test.ts`) — a
  Windows implementation would need an analogous fixture-building strategy to test unpack/verify
  without network access.
- `getCodexDesktopAppCandidates()`'s `win32` branch (detection paths) has no visible dedicated
  unit test in the files read; it is exercised only indirectly through
  `connect-orchestrator.test.ts`'s `runCodexDesktop` tests, which were not individually
  enumerated here — worth re-checking before extending that function's Windows literal paths.

---

## 5. Configuration and Environment

### Environment Variables

- `APPDATA` — read by `connectors/vscode.ts#getVsCodeProductDir` on `win32` (falls back to
  `<home>\AppData\Roaming` if unset).
- `LOCALAPPDATA` — read by `connectors/codex-desktop.ts#getCodexDesktopAppCandidates` on `win32`
  (falls back to `<home>\AppData\Local`).
- `ProgramFiles` — read by the same function (falls back to `C:\Program Files`).
- `CODEX_HOME` — read by `getCodexDesktopConfigPath()` (cross-platform override of
  `~/.codex`), unrelated to install mechanics.
- `CODEMIE_HOME` — read by `src/utils/paths.ts#getCodemieHome()` for the general CodeMie data
  dir override; `getCodexDesktopStatePath()` builds on this.
- `SystemRoot` — read by `src/utils/windows-path.ts#getWindowsSystem32` (unrelated
  native-installer feature, not currently wired into client-install).
- None of `client-install.ts`'s own code reads any env var today — `homedir()`/`tmpdir()` are
  used directly, with no Windows-specific env var consulted yet (e.g. no `%LOCALAPPDATA%` use
  for a Windows install destination).

### Configuration Files

- No dedicated config file governs this feature; all install behavior is driven by CLI flags
  (`--install-client`, `--yes`, `--insiders`) parsed in `src/cli/commands/proxy/index.ts` and
  passed straight through as `ConnectOptions` fields.
- `getCodexDesktopStatePath()` → `getCodemiePath('proxy', 'codex-desktop-state.json')` records
  ownership of the Codex config splice, unrelated to the client *app* install step (which keeps
  no persistent state file of its own — idempotency is just "is the bundle already present").

### Feature Flags and Deployment Concerns

- No feature flags; `--install-client` is implemented as a plain Commander boolean option.
- No CI/CD or Dockerfile reference to `install-client`/`client-install` was found via the
  task-named-file search in this pass; this functionality is a desktop/user-machine CLI feature,
  not something exercised by this repo's own build/deploy pipeline. (Not exhaustively verified
  against `.github/workflows/`; out of scope for the files this research pass targeted.)
- Secrets: none handled by this module directly — downloads are unauthenticated public vendor
  URLs; the only credential in the broader `connect` flow (`gatewayKey`) is handled downstream
  by the daemon/connector layer, not by `client-install.ts`.

---

## 6. Risk Indicators

- **No code reuse path is obvious for the heaviest macOS-specific logic.** `verifyBundle`
  (codesign) and `bundleVersion` (plutil + `.app`/Info.plist) have no Windows analogue in this
  codebase; a Windows implementation needs new verification (Authenticode signature check,
  likely via PowerShell `Get-AuthenticodeSignature`, or trusting HTTPS-only + vendor-published
  checksums where available) and version discovery (file version resource or post-install
  query) with no existing helper to extend.
- **Unpack/install mechanics differ by installer kind.** macOS unpacks a `.zip`/`.dmg` and
  copies a self-contained `.app` bundle. Windows installers are typically `.exe`/`.msi`
  installers that run their own privileged or per-user install logic rather than exposing a
  "copy this directory" step — the stage-then-`rename()` atomicity pattern that fixed
  `1af4961c` may not directly transfer to an EXE/MSI silent-install flow. *Speculative: this is
  the single biggest open design question and should be resolved in the spec/plan stage, not
  assumed here.*
- **Two separate "Windows path" code bases already exist with no shared vocabulary.**
  `native-installer.ts`/`windows-path.ts` solve a different problem (CLI agent binary install +
  PATH management) with their own `process.platform === 'win32'` checks, `setx`/`reg.exe`
  calls, and now (on an unmerged branch) a `detectWindowsShell()` helper. A Windows
  client-install implementation risks either duplicating shell-detection logic or needing to
  import from a module whose stated purpose ("Claude Code native installation management") does
  not obviously cover desktop-app installs — worth an explicit decision on whether/how to share.
- **One existing test explicitly pins "Windows rejects" behavior.**
  `client-install.test.ts`'s `describe('installClient off macOS', ...)` and
  `client-install-step.test.ts`'s `it.each(['win32', 'linux'])('rejects %s', ...)` both assert
  the current reject-on-Windows behavior; both will need deliberate updates (not blind deletion)
  so Linux continues to be rejected while Windows is accepted.
- **`ensureClientsInstalled`'s post-install VS Code extension step assumes a macOS `.app`
  layout** (`<vscodePath>/Contents/Resources/app/bin/code`). This is a concrete, named bug risk
  if the Windows branch is added without updating this path — Windows VS Code's CLI lives
  directly under the install root (e.g. `bin\code.cmd`), not under `Contents/Resources/app`.
- **Download source URLs are macOS-hardcoded today.** `VSCODE_LATEST` points at
  `darwin-universal`, `CODEX_DMG` is a `.dmg` URL, and Claude's `RELEASES.json` feed is fetched
  from a `darwin` path. Each would need a platform-appropriate counterpart (VS Code's update
  API already supports `win32-x64`/`win32-arm64` channel segments per its own API shape, which
  is a fact about the external API, not an assertion about this codebase).
- **No Windows fixture-building test helper exists** analogous to the macOS `standIn()`/`pack()`
  helpers, so Windows-targeted unit tests will need new fixture scaffolding before they can
  exercise unpack/verify without live network/vendor binaries.

---

## 7. Summary for Complexity Assessment

The macOS `--install-client` feature spans four files in a clean, layered shape: CLI flag
parsing (`index.ts`, no platform logic), orchestration/UX sequencing
(`connect-orchestrator.ts`, `client-install-step.ts`, mostly platform-agnostic besides two
explicit `process.platform !== 'darwin'` gates), and the install mechanics themselves
(`client-install.ts`, where essentially all macOS-only system-tool invocation — `ditto`,
`hdiutil`, `codesign`, `plutil` — is concentrated behind one `installClient()` entry point). A
sibling connector, `connectors/codex-desktop.ts`, already has a working `win32` branch for app
*detection* (and `connectors/vscode.ts`/`connectors/desktop.ts` already handle Windows *config*
paths), so the gap is specifically the download-verify-copy step, not the whole connect flow.

The two platform gates (`installClient()`'s internal check, `assertInstallClientSupported()`)
are the only places that currently need to change to let Windows through; everything downstream
of them (`ClientSpec`, `InstallClientOptions`, the error taxonomy, the stage-then-rename
atomicity pattern) is written in a platform-agnostic shape that a Windows branch can plug into
without restructuring. The genuine novelty is the Windows-side mechanics with no existing
precedent in this codebase: signature verification (no Authenticode-check helper exists),
version discovery (no `.app`/Info.plist equivalent), and unpack/install semantics for whatever
artifact kind each vendor ships for Windows (zip vs. EXE/MSI installer, which may not expose a
simple "copy this directory" step the way `.app` bundles do). A separate, unrelated Windows
installer subsystem (`native-installer.ts`, `windows-path.ts`, plus an unmerged
`detectWindowsShell()` helper on `origin/fix/windows-installer-shell-detection`) exists for CLI
*agent* installation and shares no code today — worth a deliberate reuse-or-not decision rather
than silent duplication.

Test coverage for the macOS path is thorough (real-tool integration tests gated by
`describe.skipIf`, plus fully-mocked unit tests for the orchestration layer), giving a clear
template to mirror for Windows. Two existing tests explicitly assert today's "Windows rejects"
behavior and will need deliberate, not incidental, updates. No test fixture-building helper for
Windows artifacts exists yet. Overall this reads as medium-to-high complexity: the file surface
is small and the integration points are mostly already platform-aware, but the core
download/verify/install mechanics for Windows have zero code precedent in this repository and
raise an open design question (EXE/MSI installer semantics vs. the zip/dmg-copy model) that the
spec and plan stages need to resolve explicitly rather than infer from the macOS implementation.

---

## 8. External References

The task's "Key files from that work" and "existing Windows-specific code elsewhere in the
repo" pointers all resolve to paths inside this repository, not to an external source of truth
outside it, so none required the external-sourcing procedure in Step 0. All were read directly
and are cited by path throughout Sections 2–6:

- `src/cli/commands/proxy/client-install.ts` — resolved, read in full.
- `src/cli/commands/proxy/client-install-step.ts` — resolved, read in full.
- `src/cli/commands/proxy/connect-orchestrator.ts` — resolved, read in full.
- `src/cli/commands/proxy/connectors/codex-desktop.ts` — resolved, read in full.
- `src/cli/commands/proxy/index.ts` — resolved, read in full.
- `docs/COMMANDS.md`, `README.md` — resolved, relevant `--install-client` sections located and
  quoted above.
- `src/cli/commands/proxy/__tests__/client-install.test.ts`,
  `client-install-step.test.ts`, `client-install-copy.test.ts`,
  `connect-orchestrator.test.ts`, `connect-wiring.test.ts` — resolved, read in full.
- "windows-installer-shell-detection work" — resolved to the unmerged branch
  `origin/fix/windows-installer-shell-detection` (commit `971d459a`, "fix(utils): detect
  Windows shell type for correct installer selection"), touching `src/utils/native-installer.ts`,
  `src/agents/core/types.ts`, `src/agents/plugins/claude/claude.plugin.ts`. Not yet merged into
  this branch's history; findings above are from `git show`/`git log` against the remote ref,
  not a full checkout.

None named by the task point outside this repository.
