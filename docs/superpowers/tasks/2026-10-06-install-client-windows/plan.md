# Windows `--install-client` Implementation Plan (EPMCDME-15627)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `codemie proxy connect --install-client` work on Windows x64 for VS Code and
Claude Desktop (download, SHA-256 verify, silent per-user install, then connect), and make it
correctly refuse to touch Codex/ChatGPT on Windows (Store-only, no download/prompt).

**Architecture:** Widen the two existing macOS-only platform gates
(`client-install.ts#installClient`, `client-install-step.ts#assertInstallClientSupported`) to
accept `win32`. Add a Windows branch per app inside the existing `ClientSpec.resolve()` /
`installClient()` pipeline rather than a parallel code path — `downloadToFile`'s existing SHA-256
check already satisfies "verify genuine" for Windows, so no new signature-verification helper is
needed. Windows artifacts are installers, not bundles to unpack: skip the ditto/hdiutil/codesign
steps for `kind: 'exe'` and run the installer silently instead.

**Tech Stack:** TypeScript/ES modules/Vitest, existing `@/utils/exec.js` `run()` wrapper, the
already-installed `yaml` package (no new dependency).

**Spec:** No `spec.md` exists for this task; the requirements of record are ticket EPMCDME-15627
(quoted in Acceptance Criteria below) plus
`docs/superpowers/tasks/2026-10-06-install-client-windows/technical-analysis.md`, which traces the
existing macOS implementation this plan extends.

## Global Constraints

- No admin/UAC prompt for any Windows install — only user-scope installer URLs/switches.
- Do NOT use the Claude Desktop MSIX manifest entry (needs admin).
- Do NOT download, verify, or prompt for Codex/ChatGPT on Windows — Store-install only.
- A download that fails SHA-256 verification is never installed; nothing is left behind.
- An already-installed app (per-user or machine-wide) is never reinstalled.
- Windows ARM and macOS behavior changes are out of scope; the only macOS-touching edits are the
  two platform-gate widenings.
- `sanitizeLogArgs()` on any logged path/URL; no `any`; no placeholder TODOs.

Commit per task using the repository's existing convention.

---

## Acceptance criteria (ticket EPMCDME-15627, verbatim)

- [ ] VS Code and Claude Desktop: when missing, command names the app, states its download size,
      and waits for confirmation.
- [ ] VS Code and Claude Desktop: after confirmation, installs for the current user without an
      admin/UAC prompt, and connection succeeds.
- [ ] Codex: command prints the download page and exits non-zero; after the user installs ChatGPT
      themselves, `--codex-desktop` finds it and connects.
- [ ] A download that fails verification is not installed, and nothing is left behind.
- [ ] An app that is already installed is never reinstalled.

## Negative constraints → enforcing task

| Constraint | Honored by |
|---|---|
| No MSIX Claude Desktop variant | Task 1 — picks the `Scope: user`, non-`msix` manifest entry |
| No download/prompt for Codex on Windows | Task 4 — throws before `resolveDownload`/`confirmInstall` |
| No admin/UAC prompt | Task 1 (user-scope URLs) + Task 3 (silent per-user installer args) |
| Never reinstall an installed app | Task 2 feeds the existing skip-if-found check (`client-install-step.ts:88-92`, unchanged) |
| Nothing left behind on failed verification | Task 3 — installer runs only after the existing SHA-256 check (`client-install.ts:284-295`, unchanged) passes |
| Windows ARM / macOS out of scope | Task 1 uses only `win32-x64*` URLs; no other macOS code is touched |

## Context for the implementer

`client-install.ts` concentrates all macOS-only tool invocation behind `installClient()`;
`assertInstallClientSupported()` in `client-install-step.ts` is the CLI-facing twin gate. Both
reject anything but `darwin` today. Everything downstream (`ClientSpec`, `InstallClientOptions`,
the error taxonomy, `downloadToFile`'s SHA-256 check) is already platform-agnostic — see the
technical analysis sections 2 and 6 for the full trace.

---

## Task 1 — Windows download sources for VS Code and Claude Desktop

**Files:** Modify `src/cli/commands/proxy/client-install.ts:39` (`ClientSpec.kind`), `:53-55`
(URL constants), `:104-138` (`CLIENT_SPECS`). Test: `__tests__/client-install.test.ts`.

**Produces:** `resolveClaudeDesktopWindows(fetchImpl: typeof fetch): Promise<ClientDownload>`,
`kind: 'zip' | 'dmg' | 'exe'` on `ClientSpec`.

- Extend `kind` to `'zip' | 'dmg' | 'exe'`.
- Add `WINDOWS_VSCODE_LATEST = 'https://update.code.visualstudio.com/api/update/win32-x64-user/stable/latest'`.
  In `vscode.resolve`, branch on `process.platform`: `win32` fetches this URL and reuses the
  already-generic `parseVsCodeLatest` (`:81-87`) unchanged.
- Add `resolveClaudeDesktopWindows`: list `manifests/a/Anthropic/Claude` via the GitHub contents
  API, take the highest version folder, fetch its `Anthropic.Claude.installer.yaml`, parse with
  the already-installed `yaml` package, and pick the entry with `Scope: user` and
  `InstallerType` other than `msix` (never MSIX — that one needs admin).

```ts
async function resolveClaudeDesktopWindows(fetchImpl: typeof fetch): Promise<ClientDownload> {
  const dirs = (await getJson(fetchImpl,
    'https://api.github.com/repos/microsoft/winget-pkgs/contents/manifests/a/Anthropic/Claude'
  )) as Array<{ name: string }>;
  const latest = dirs.map((d) => d.name).sort(compareVersions).at(-1);
  if (!latest) throw new Error('No Anthropic.Claude version found in winget-pkgs');
  const yamlText = await fetchImpl(
    `https://raw.githubusercontent.com/microsoft/winget-pkgs/master/manifests/a/Anthropic/Claude/${latest}/Anthropic.Claude.installer.yaml`
  ).then((r) => r.text());
  const manifest = YAML.parse(yamlText) as {
    Installers: Array<{ Scope?: string; InstallerType?: string; InstallerUrl: string; InstallerSha256: string }>;
  };
  const picked = manifest.Installers.find((i) => i.Scope === 'user' && i.InstallerType !== 'msix');
  if (!picked) throw new Error('No per-user, non-MSIX Claude Desktop installer in the manifest');
  return { url: picked.InstallerUrl, sha256: picked.InstallerSha256 };
}
```

(`compareVersions` is a two-line string sort, written inline — no new dependency.)

**Test-first: yes** — failing test: "resolveClaudeDesktopWindows picks the user-scope, non-MSIX
installer URL and SHA-256 from a fixture winget manifest YAML (one `msix` entry, one `user`/`exe`
entry inline in the test, no network)."

## Task 2 — Windows install-location detection

**Files:** Modify `client-install.ts:141-148` (`applicationDirs`, `findInstalledClient`). Test:
`__tests__/client-install.test.ts`.

**Consumes:** `ClientSpec` from Task 1. **Produces:** `ClientSpec.winBundle: string`.

- Add per-app Windows candidate dirs + bundle file names (Windows apps are files, not `.app`
  dirs): VS Code → `Code.exe` under `%ProgramFiles%\Microsoft VS Code`,
  `%ProgramFiles(x86)%\Microsoft VS Code`, `%LOCALAPPDATA%\Programs\Microsoft VS Code` (both
  machine-wide and per-user, per the ticket's "per-user or machine-wide" wording); Claude Desktop
  → `claude.exe` under `%LOCALAPPDATA%\AnthropicClaude`.
- Add `winBundle` to `ClientSpec`; branch the dirs/bundle passed to `findInstalledClient` on
  `process.platform`.
- The Claude Desktop folder name is a best-effort constant pending a quick empirical check against
  a real install — a one-line fix if wrong, isolated to this constant.

**Test-first: yes** — failing test: "findInstalledClient reports vscode installed when `Code.exe`
exists under the per-user `Programs\Microsoft VS Code` dir on win32."

## Task 3 — Windows branch in `installClient`

**Files:** Modify `client-install.ts:259-343`. Test: `__tests__/client-install.test.ts`
(rework the `describe('installClient off macOS', ...)` block at `:257-262`).

**Consumes:** `ClientSpec.kind`/`winBundle` from Tasks 1–2. **Produces:**
`ClientSpec.winSilentArgs: string[]`.

- Widen the gate at `:261-263` from `process.platform !== 'darwin'` to reject only platforms that
  are neither `darwin` nor `win32`.
- For `spec.kind === 'exe'`: after the existing download+SHA-256 check (`:284-295`, unchanged —
  this is where "fails verification → never installed" already happens), skip the
  ditto/hdiutil unpack block (`:297-308`) and codesign/plutil calls (`:313-319`). Run the
  downloaded `.exe` via the existing `run()` helper with `spec.winSilentArgs` (VS Code:
  `['/VERYSILENT', '/NORESTART', '/MERGETASKS=!runcode']`; Claude Desktop: `['--silent']`, per the
  ticket). Skip the staging/rename copy (`:326-331`) too — the installer places the app itself;
  the returned path is the Windows location Task 2's constants point at, not a copy destination
  this code controls.
- No bespoke rollback for a Windows install that fails partway: nothing runs the installer unless
  the hash already matched, so the "half-copied app" risk the staging/rename pattern guards
  against on macOS doesn't apply here.

**Test-first: yes** — failing test: "installClient on win32 runs the downloaded exe with its
`winSilentArgs` and never calls ditto/hdiutil/codesign; a checksum mismatch runs no installer."
Mock `run`/`exec` the same way `client-install-copy.test.ts` already mocks `ditto` — no new
fixture-building helper needed, since Windows verification is a plain hash compare. Rename the
existing `describe('installClient off macOS', ...)` to `describe('installClient on unsupported
platforms', ...)`, keep a Linux-rejects case, and add the win32 case here instead of leaving it
asserting rejection.

## Task 4 — Codex is never offered on Windows

**Files:** Modify `client-install-step.ts:86-104` (per-app loop in `ensureClientsInstalled`).
Test: `__tests__/client-install-step.test.ts`.

**Consumes:** `ClientInstallError`, `CLIENT_SPECS['codex-desktop'].downloadPage` (existing).

- Before `findInstalledClient`/confirm/download for each app: if `app === 'codex-desktop' &&
  process.platform === 'win32'`, throw `new ClientInstallError('ChatGPT must be installed from
  the Microsoft Store.', CLIENT_SPECS['codex-desktop'].downloadPage)` immediately — no
  `resolveDownload` call, no `confirmInstall` prompt. The existing `ClientInstallError` branch in
  `printProxyError` already prints the `✗` line, `Download page: <url>`, and exits non-zero.

**Test-first: yes** — failing test: "ensureClientsInstalled on win32 for codex-desktop throws
without calling resolveDownload or confirmInstall."

## Task 5 — Accept win32 in the CLI-facing platform gate

**Files:** Modify `client-install-step.ts:32-42` (`assertInstallClientSupported`). Test:
`__tests__/client-install-step.test.ts:247-249`.

- Change `if (platform !== 'darwin')` to `if (platform !== 'darwin' && platform !== 'win32')`;
  update the message to `'--install-client is only supported on macOS and Windows.'`.

**Test-first: yes** — change `it.each(['win32', 'linux'])('rejects %s', ...)` to a plain
`it('rejects linux', ...)`, and add `it('accepts win32', () =>
expect(() => step.assertInstallClientSupported({}, 'win32')).not.toThrow())`.

## Task 6 — Windows VS Code extension-install path

**Files:** Modify `client-install-step.ts:121-133`. Test: `__tests__/client-install-step.test.ts`.

**Consumes:** `vscodePath` (existing, from `installClient`'s return value).

- The `%APPDATA%\Code` mkdir at `:111-118` already uses the cross-platform
  `getVsCodeProductDir(false)` and needs no change — `writeAtomically`'s own recursive mkdir
  creates the nested `User` subfolder when the settings file is written later, same as on macOS.
- At `:121-133`, the extension-install CLI path `${vscodePath}/Contents/Resources/app/bin/code`
  is a macOS `.app` layout. Branch on `process.platform`: keep it for `darwin`; for `win32` use
  `${vscodePath}\bin\code.cmd` (VS Code's per-install-root CLI shim).

**Test-first: yes** — failing test: "ensureClientsInstalled runs `bin\\code.cmd
--install-extension anthropic.claude-code` on win32 for a vscodeClaudeCode install."

## Task 7 — Point the Codex "not found" hint at the Store on Windows

**Files:** Modify `connect-orchestrator.ts:608-624` (`runCodexDesktop`). Test:
`__tests__/connect-orchestrator.test.ts`.

- The hint at `:622` ("Install it (or re-run with --install-client on macOS)...") is wrong on
  Windows once Task 4 makes `--install-client` never fetch Codex there. Branch the hint on
  `process.platform`: macOS keeps today's wording; `win32` says to install ChatGPT from the
  Microsoft Store instead.

**Test-first: yes** — failing test: "runCodexDesktop's not-found hint on win32 mentions the
Microsoft Store, not --install-client."

## Task 8 — Update CLI help text and docs

**Files:** Modify `src/cli/commands/proxy/index.ts:315`, `connect-orchestrator.ts:82-83,299-300`,
`docs/COMMANDS.md`, `README.md`.

- Change the `(macOS)`/"macOS only" copy to note Windows support, and add the Codex exception
  (Store-installed, not by this flag) next to each existing macOS `--install-client` mention.

**Test-first: no** — doc/help-string copy only, single step, no behavior to assert.

---

## Self-review

- **Acceptance-criteria coverage:** confirmation+size → Task 1 (resolve returns size, reused
  unchanged `confirmInstall`); no-UAC install → Tasks 1+3; Codex Store message/exit → Task 4;
  nothing-left-behind → Task 3 (reuses existing `:284-295` check); never-reinstall → Task 2 feeds
  the existing, unchanged skip-if-found check.
- **Placeholder scan:** no TBD/TODO; the one open fact (Claude Desktop's exact folder name) is
  called out explicitly in Task 2 as a named, isolated constant, not a placeholder.
- **Type consistency:** `ClientSpec.winBundle` (Task 2) and `ClientSpec.winSilentArgs` (Task 3)
  are both read, not redefined, by every later task that touches them.
