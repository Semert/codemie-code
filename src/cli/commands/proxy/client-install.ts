/**
 * Installs a client app (Claude Desktop, VS Code, the ChatGPT app that ships
 * Codex) for the current user, so `proxy connect` can then configure it. Runs
 * on macOS and Windows; on Windows only Claude Desktop and VS Code are
 * installable from here (ChatGPT is Store-only there, see client-install-step.ts).
 *
 * Nothing is bundled: each app comes from its vendor when asked for.
 *
 * On macOS, every downloaded bundle must carry an intact signature from the
 * vendor's Developer ID team before it is copied (verifyBundle), and VS Code's
 * published SHA-256 is also checked when the feed provides one. Apps go into
 * ~/Applications, so no administrator password is ever needed.
 *
 * On Windows there is no equivalent signature check: installers are verified
 * by SHA-256 checksum only (VS Code's own feed for VS Code, the community
 * winget-pkgs manifest for Claude Desktop), and the per-user installer is run
 * silently into Program Files/LocalAppData, again with no administrator
 * password needed.
 */
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { CodeMieError } from '@/utils/errors.js';
import { exec } from '@/utils/exec.js';
import { logger } from '@/utils/logger.js';

export type ClientApp = 'claude-desktop' | 'vscode' | 'codex-desktop';

export interface ClientDownload {
  url: string;
  /** Published SHA-256 (hex), when the vendor has one. */
  sha256?: string;
  /** Download size in bytes, when the server reports it. */
  size?: number;
}

export interface ClientSpec {
  app: ClientApp;
  /** Name shown to the user. */
  label: string;
  /** Bundle name inside the package and in ~/Applications. */
  bundle: string;
  /** Apple Developer ID team that must have signed the bundle. */
  teamId: string;
  kind: 'zip' | 'dmg' | 'exe';
  /** Executable name checked for on Windows, where apps are files, not .app bundles. */
  winBundle?: string;
  /** Args that make the Windows installer run silently, per-user, with no UAC prompt. */
  winSilentArgs?: string[];
  /** Vendor page the user can download the app from themselves. */
  downloadPage: string;
  resolve: (fetchImpl: typeof fetch) => Promise<ClientDownload>;
}

/** A failed install, with the page the user can get the app from instead. */
export class ClientInstallError extends CodeMieError {
  constructor(message: string, public readonly downloadPage: string) {
    super(message);
    this.name = 'ClientInstallError';
  }
}

const VSCODE_LATEST = 'https://update.code.visualstudio.com/api/update/darwin-universal/stable/latest';
const WINDOWS_VSCODE_LATEST = 'https://update.code.visualstudio.com/api/update/win32-x64-user/stable/latest';
const CLAUDE_RELEASES = 'https://downloads.claude.ai/releases/darwin/universal/RELEASES.json';
const CODEX_DMG = 'https://persistent.oaistatic.com/codex-app-prod/Codex.dmg';
const WINGET_CLAUDE_DIR = 'https://api.github.com/repos/microsoft/winget-pkgs/contents/manifests/a/Anthropic/Claude';

/** Bound on each helper process (unpack, mount, verify, copy). */
const STEP_TIMEOUT_MS = 5 * 60_000;
/** A download that delivers no bytes for this long is given up. */
const STALL_TIMEOUT_MS = 60_000;
/** Bound on the small feed and size requests. */
const REQUEST_TIMEOUT_MS = 30_000;

async function getJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function headSize(fetchImpl: typeof fetch, url: string): Promise<number | undefined> {
  try {
    const res = await fetchImpl(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const len = Number(res.headers.get('content-length'));
    return res.ok && len > 0 ? len : undefined;
  } catch {
    return undefined;
  }
}

/** The VS Code zip URL and its SHA-256 from the update API. */
export function parseVsCodeLatest(json: unknown): { url: string; sha256: string } {
  const j = json as { url?: unknown; sha256hash?: unknown };
  if (typeof j?.url !== 'string' || !j.url || typeof j.sha256hash !== 'string' || !j.sha256hash) {
    throw new Error('VS Code update info has no download URL or checksum');
  }
  return { url: j.url, sha256: j.sha256hash };
}

/** The current Claude Desktop zip URL from its update feed. */
export function parseClaudeReleases(json: unknown): string {
  const j = json as {
    currentRelease?: string;
    releases?: Array<{ version?: string; updateTo?: { url?: string } }>;
  };
  const releases = j?.releases ?? [];
  const current = releases.find((r) => r.version === j?.currentRelease) ?? releases[0];
  const url = current?.updateTo?.url;
  if (typeof url !== 'string' || !url) {
    throw new Error('Claude Desktop update feed has no download URL');
  }
  return url;
}

/** Ascending numeric compare of dot-separated version strings (e.g. "0.14.9" < "0.14.10"). */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The current per-user, non-MSIX Claude Desktop installer for Windows, read
 * from the community-maintained winget-pkgs manifest (Claude Desktop publishes
 * no update feed of its own for Windows, unlike its macOS RELEASES.json).
 */
export async function resolveClaudeDesktopWindows(fetchImpl: typeof fetch): Promise<ClientDownload> {
  const dirs = (await getJson(fetchImpl, WINGET_CLAUDE_DIR)) as Array<{ name: string }>;
  const latest = dirs.map((d) => d.name).sort(compareVersions).at(-1);
  if (!latest) throw new Error('No Anthropic.Claude version found in winget-pkgs');
  const res = await fetchImpl(
    `https://raw.githubusercontent.com/microsoft/winget-pkgs/master/manifests/a/Anthropic/Claude/${latest}/Anthropic.Claude.installer.yaml`,
    { redirect: 'follow', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} for Anthropic.Claude.installer.yaml`);
  const manifest = parseYaml(await res.text()) as {
    Installers: Array<{ Scope?: string; InstallerType?: string; InstallerUrl: string; InstallerSha256: string }>;
  };
  const picked = manifest.Installers.find((i) => i.Scope === 'user' && i.InstallerType !== 'msix');
  if (!picked) throw new Error('No per-user, non-MSIX Claude Desktop installer in the manifest');
  return { url: picked.InstallerUrl, sha256: picked.InstallerSha256 };
}

export const CLIENT_SPECS: Record<ClientApp, ClientSpec> = {
  'vscode': {
    app: 'vscode',
    label: 'VS Code',
    bundle: 'Visual Studio Code.app',
    teamId: 'UBF8T346G9',
    kind: process.platform === 'win32' ? 'exe' : 'zip',
    winBundle: 'Code.exe',
    winSilentArgs: ['/VERYSILENT', '/NORESTART', '/MERGETASKS=!runcode'],
    downloadPage: 'https://code.visualstudio.com/download',
    resolve: async (fetchImpl) => {
      const feedUrl = process.platform === 'win32' ? WINDOWS_VSCODE_LATEST : VSCODE_LATEST;
      const { url, sha256 } = parseVsCodeLatest(await getJson(fetchImpl, feedUrl));
      return { url, sha256, size: await headSize(fetchImpl, url) };
    },
  },
  'claude-desktop': {
    app: 'claude-desktop',
    label: 'Claude Desktop',
    bundle: 'Claude.app',
    teamId: 'Q6L2SF6YDW',
    kind: process.platform === 'win32' ? 'exe' : 'zip',
    // Best-effort: the squirrel-style installer's own root-level launcher shim.
    // Not yet confirmed against a real install (not installed on the machine
    // this was written on); a one-line fix here if the real folder/exe differs.
    winBundle: 'claude.exe',
    winSilentArgs: ['--silent'],
    downloadPage: 'https://claude.com/download',
    resolve: async (fetchImpl) => {
      if (process.platform === 'win32') {
        const download = await resolveClaudeDesktopWindows(fetchImpl);
        return { ...download, size: await headSize(fetchImpl, download.url) };
      }
      const url = parseClaudeReleases(await getJson(fetchImpl, CLAUDE_RELEASES));
      return { url, size: await headSize(fetchImpl, url) };
    },
  },
  'codex-desktop': {
    app: 'codex-desktop',
    label: 'ChatGPT (Codex)',
    bundle: 'ChatGPT.app',
    teamId: '2DC432GLL2',
    kind: 'dmg',
    downloadPage: 'https://chatgpt.com/download',
    resolve: async (fetchImpl) => ({ url: CODEX_DMG, size: await headSize(fetchImpl, CODEX_DMG) }),
  },
};

/** Folders an app counts as installed in: the system one, then the user's. */
export function applicationDirs(home: string = homedir()): string[] {
  return ['/Applications', join(home, 'Applications')];
}

/**
 * Windows candidate install dirs, per app: both the machine-wide and per-user
 * locations the ticket's "per-user or machine-wide" wording covers, matching
 * where each vendor's own installer places itself.
 */
export function windowsApplicationDirs(app: ClientApp, home: string = homedir()): string[] {
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
  if (app === 'vscode') {
    return [
      join(programFiles, 'Microsoft VS Code'),
      join(programFilesX86, 'Microsoft VS Code'),
      join(localAppData, 'Programs', 'Microsoft VS Code'),
    ];
  }
  if (app === 'claude-desktop') {
    return [join(localAppData, 'AnthropicClaude')];
  }
  return [];
}

/** Where the app is installed, or null. Same places CodeMie Connect checks. */
export function findInstalledClient(
  spec: ClientSpec,
  dirs: string[] = process.platform === 'win32' ? windowsApplicationDirs(spec.app) : applicationDirs()
): string | null {
  const bundle = process.platform === 'win32' ? (spec.winBundle ?? spec.bundle) : spec.bundle;
  return dirs.map((d) => join(d, bundle)).find((p) => existsSync(p)) ?? null;
}

/** The `TeamIdentifier=` value from `codesign -dv` output. */
export function parseTeamIdentifier(codesignOutput: string): string | null {
  const line = codesignOutput.split('\n').find((l) => l.startsWith('TeamIdentifier='));
  return line ? line.slice('TeamIdentifier='.length).trim() : null;
}

/**
 * Streams `url` to `dest` and checks the SHA-256 when one is given. A stall
 * longer than STALL_TIMEOUT_MS aborts the download.
 */
export async function downloadToFile(
  url: string,
  dest: string,
  sha256: string | undefined,
  fetchImpl: typeof fetch = fetch,
  stallMs: number = STALL_TIMEOUT_MS,
): Promise<void> {
  const ctrl = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let stalled = false;
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      // Abort the request and the body read: a cancelled read ends the loop.
      stalled = true;
      ctrl.abort();
      void reader?.cancel().catch(() => undefined);
    }, stallMs);
  };
  const out = createWriteStream(dest);
  let writeError: Error | undefined;
  out.on('error', (e) => {
    // Disk full or no permission: stop the download and report it.
    writeError = e;
    ctrl.abort();
    void reader?.cancel().catch(() => undefined);
  });
  const hash = createHash('sha256');
  try {
    arm();
    const res = await fetchImpl(url, { redirect: 'follow', signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm();
      hash.update(value);
      if (!out.write(value)) await once(out, 'drain');
    }
    if (stalled) throw new Error('the download stalled');
    if (writeError) throw writeError;
  } catch (e) {
    throw writeError ?? (stalled ? new Error('the download stalled') : e);
  } finally {
    clearTimeout(timer);
    if (!out.destroyed) {
      out.end();
      await once(out, 'close').catch(() => undefined);
    }
  }
  if (writeError) throw writeError;
  if (sha256 && hash.digest('hex').toLowerCase() !== sha256.toLowerCase()) {
    throw new Error('checksum mismatch');
  }
}

async function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return exec(cmd, args, { timeout: STEP_TIMEOUT_MS });
}

/** Intact signature (`--deep --strict` covers nested helpers) from `teamId`. */
export async function verifyBundle(bundlePath: string, teamId: string): Promise<void> {
  const verify = await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundlePath]);
  if (verify.code !== 0) {
    throw new Error(`signature check failed: ${verify.stderr || verify.stdout}`);
  }
  const info = await run('/usr/bin/codesign', ['-dv', bundlePath]);
  const team = parseTeamIdentifier(`${info.stderr}\n${info.stdout}`);
  if (team !== teamId) {
    throw new Error(`signed by ${team ?? 'nobody'}, expected ${teamId}`);
  }
}

async function bundleVersion(bundlePath: string): Promise<string> {
  const r = await run('/usr/bin/plutil', [
    '-extract', 'CFBundleShortVersionString', 'raw', join(bundlePath, 'Contents', 'Info.plist'),
  ]);
  return r.code === 0 ? r.stdout.trim() : '';
}

export interface InstallClientOptions {
  /** Install destination, default ~/Applications. */
  destDir?: string;
  /** Scratch folder, created and removed by the install. Default: a fresh temp dir. */
  workDir?: string;
  fetchImpl?: typeof fetch;
  /** Receives one line per finished step. */
  log?: (line: string) => void;
  /** Download already resolved by the caller (e.g. after asking about its size). */
  download?: ClientDownload;
}

/**
 * Downloads, checks and silently runs the Windows installer for `spec`. The
 * installer places the app itself (there is no bundle directory to stage and
 * rename), so this skips the macOS unpack/verify/copy pipeline entirely: once
 * the checksum has matched, the installer is run and its own per-user,
 * no-UAC install location (Task 2's winBundle/windowsApplicationDirs
 * constants) is returned.
 */
async function installClientWindows(
  spec: ClientSpec,
  opts: { fetchImpl: typeof fetch; log: (line: string) => void; workDir?: string; download?: ClientDownload; destDir?: string }
): Promise<string> {
  const fail = (msg: string) => new ClientInstallError(msg, spec.downloadPage);
  const bundle = spec.winBundle ?? spec.bundle;
  const destDir = opts.destDir ?? windowsApplicationDirs(spec.app).at(-1) ?? homedir();
  const dest = join(destDir, bundle);
  if (existsSync(dest)) {
    throw fail(`${spec.label} is already installed at ${dest}.`);
  }

  let work = opts.workDir ?? '';
  try {
    work = opts.workDir ?? (await mkdtemp(join(tmpdir(), 'codemie-client-')));
    await mkdir(work, { recursive: true });
    const pkg = join(work, 'installer.exe');
    let download = opts.download;
    try {
      download ??= await spec.resolve(opts.fetchImpl);
      await downloadToFile(download.url, pkg, download.sha256, opts.fetchImpl);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      const code = (e as NodeJS.ErrnoException)?.code;
      throw fail(reason === 'checksum mismatch'
        ? `The ${spec.label} download didn't match its published checksum, so it was not installed.`
        : code === 'ENOSPC' || code === 'EACCES' || code === 'EPERM'
          ? `Couldn't save the ${spec.label} download (${reason}). Free up disk space and try again.`
          : `Couldn't download ${spec.label} (${reason}). Check your connection and try again.`);
    }
    opts.log(`✓ Downloaded ${spec.label}`);

    const r = await run(pkg, spec.winSilentArgs ?? []);
    if (r.code !== 0) {
      throw fail(`Installing ${spec.label} failed (exit ${r.code}): ${r.stderr || r.stdout}`);
    }
    opts.log('✓ Installed for your account');
    return dest;
  } catch (e) {
    if (e instanceof ClientInstallError) throw e;
    throw fail(`Installing ${spec.label} failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    if (work) await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Downloads, checks and installs `spec` into ~/Applications. Throws
 * ClientInstallError on any failure, after removing the download and any
 * partly copied app. Never touches an app that is already at the destination.
 */
export async function installClient(spec: ClientSpec, opts: InstallClientOptions = {}): Promise<string> {
  const fail = (msg: string) => new ClientInstallError(msg, spec.downloadPage);
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    throw fail(`Installing ${spec.label} from the CLI is only supported on macOS and Windows for now.`);
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log ?? ((line: string) => console.log(line));

  if (process.platform === 'win32') {
    return installClientWindows(spec, { fetchImpl, log, workDir: opts.workDir, download: opts.download, destDir: opts.destDir });
  }

  const destDir = opts.destDir ?? join(homedir(), 'Applications');
  const dest = join(destDir, spec.bundle);
  if (existsSync(dest)) {
    throw fail(`${spec.label} is already installed at ${dest}.`);
  }

  // The app is copied under a hidden name and renamed when complete, so a copy
  // cut short (killed, timed out) never looks like an installed app.
  const staging = join(destDir, `.${spec.bundle}.codemie-partial`);
  let work = opts.workDir ?? '';
  let mounted = false;
  let mnt = '';
  try {
    work = opts.workDir ?? (await mkdtemp(join(tmpdir(), 'codemie-client-')));
    await mkdir(work, { recursive: true });
    const pkg = join(work, spec.kind === 'zip' ? 'download.zip' : 'download.dmg');
    mnt = join(work, 'mnt');
    let download = opts.download;
    try {
      download ??= await spec.resolve(fetchImpl);
      await downloadToFile(download.url, pkg, download.sha256, fetchImpl);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      const code = (e as NodeJS.ErrnoException)?.code;
      throw fail(reason === 'checksum mismatch'
        ? `The ${spec.label} download didn't match its published checksum, so it was not installed.`
        : code === 'ENOSPC' || code === 'EACCES' || code === 'EPERM'
          ? `Couldn't save the ${spec.label} download (${reason}). Free up disk space and try again.`
          : `Couldn't download ${spec.label} (${reason}). Check your connection and try again.`);
    }

    let root = join(work, 'unpacked');
    if (spec.kind === 'zip') {
      await mkdir(root, { recursive: true });
      const r = await run('/usr/bin/ditto', ['-x', '-k', pkg, root]);
      if (r.code !== 0) throw fail(`Couldn't unpack the ${spec.label} download: ${r.stderr}`);
    } else {
      await mkdir(mnt, { recursive: true });
      mounted = true; // set before attach: a timed-out attach can still mount
      const r = await run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mnt, pkg]);
      if (r.code !== 0) throw fail(`Couldn't open the ${spec.label} disk image: ${r.stderr}`);
      root = mnt;
    }
    const src = join(root, spec.bundle);
    if (!existsSync(src)) throw fail(`The ${spec.label} download has no ${spec.bundle} in it.`);
    log(`✓ Downloaded ${spec.label} ${await bundleVersion(src)}`.trimEnd());

    try {
      await verifyBundle(src, spec.teamId);
    } catch (e) {
      logger.debug('[client-install] verify failed', { app: spec.app, error: String(e) });
      throw fail(`The ${spec.label} download isn't signed by its vendor, so it was not installed.`);
    }
    log('✓ Checked the download is genuine');

    try {
      await mkdir(destDir, { recursive: true });
    } catch {
      throw fail(`macOS didn't allow creating ${destDir}. Your IT policy may block installing apps here.`);
    }
    await rm(staging, { recursive: true, force: true });
    const cp = await run('/usr/bin/ditto', [src, staging]);
    if (cp.code !== 0) {
      throw fail(`macOS didn't allow installing ${spec.label} into ${destDir}. Your IT policy may block it. (${cp.stderr})`);
    }
    await rename(staging, dest);
    log('✓ Installed for your account');
    return dest;
  } catch (e) {
    if (e instanceof ClientInstallError) throw e;
    // A helper that timed out or could not start.
    throw fail(`Installing ${spec.label} failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (mounted) await run('/usr/bin/hdiutil', ['detach', mnt, '-force']).catch(() => undefined);
    if (work) await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}
