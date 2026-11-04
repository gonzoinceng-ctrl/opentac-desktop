import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { redact } from '../shared/redact.js';
import type { ShellState } from '../shared/types.js';
import type { Logger } from './logger.js';
import type { Paths } from './paths.js';
import { createRingBuffer } from './ringBuffer.js';

/** Default wall-clock budget for one `npm ci` attempt. */
const DEFAULT_INSTALL_TIMEOUT_MS = 20 * 60 * 1000;
/** Wall-clock budget for the upstream setup doctor. */
const DOCTOR_TIMEOUT_MS = 60 * 1000;
/** Wall-clock budget for `node --version`. */
const VERSION_TIMEOUT_MS = 10 * 1000;
/** Delay before the single automatic retry of a network-class failure. */
const DEFAULT_RETRY_DELAY_MS = 3000;
/** Time a killed child gets to exit after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 2000;
/** Number of trailing output lines kept for failure classification and detail. */
const TAIL_LINES = 200;
/** Number of trailing output lines quoted in an error's detail. */
const DETAIL_LINES = 12;
/** Cap on doctor output returned to callers. */
const DOCTOR_OUTPUT_MAX = 256 * 1024;

/** Stable codes for {@link InstallError}. */
export type InstallErrorCode =
  'NPM_FAILED' | 'NETWORK' | 'DISK_FULL' | 'TIMEOUT' | 'ABORTED' | 'NO_LOCKFILE';

/** Failure raised by the install manager; `message` is a plain sentence, `detail` the raw tail. */
export class InstallError extends Error {
  readonly code: InstallErrorCode;
  readonly detail?: string;

  /** Creates an error with a stable `code` and an optional raw `detail` (output tail, errno). */
  constructor(code: InstallErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'InstallError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/** One line of npm output. */
export interface InstallProgress {
  line: string;
  stream: 'stdout' | 'stderr';
}

/** Outcome of a successful install. */
export interface InstallResult {
  durationMs: number;
  /** sha256 hex of package-lock.json after the install. */
  lockHash: string;
  /** Bundled Node version (no leading 'v') that ran npm. */
  nodeVersion: string;
  /** Number of npm runs (1, or 2 after a network retry). */
  attempts: number;
}

/** Whether `npm ci` must run, and why (or why not). */
export interface NeedsInstall {
  needed: boolean;
  reason: 'no-node-modules' | 'lock-changed' | 'node-changed' | 'never-installed' | 'up-to-date';
}

/** Installs the checkout's dependencies with the bundled Node and npm. */
export interface InstallManager {
  /** sha256 hex of `<checkoutDir>/package-lock.json`, or null when the file is missing. */
  lockHash(): Promise<string | null>;
  /** Version of the bundled Node without the leading 'v'; run once and cached. */
  bundledNodeVersion(): Promise<string>;
  /** Decides whether `npm ci` must run given the recorded install state. */
  needsInstall(
    state: Pick<ShellState, 'installedLockHash' | 'installedNodeVersion' | 'installedCommit'>,
  ): Promise<NeedsInstall>;
  /** Runs `npm ci`, streaming every output line; retries once on network-class failures. */
  install(
    onProgress: (p: InstallProgress) => void,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<InstallResult>;
  /** Runs upstream's setup doctor; never throws on a non-zero exit. */
  runDoctor(): Promise<{ output: string; ready: boolean; exitCode: number }>;
}

/** Options for {@link createInstallManager}. */
export interface InstallManagerOptions {
  paths: Pick<Paths, 'checkoutDir' | 'nodeBin' | 'npmCli' | 'npmCacheDir' | 'nodeModulesDir'>;
  log: Logger;
  /** Extra environment applied over the clean base (HOME, TMPDIR, test hooks); npm_config_* ignored. */
  env?: Record<string, string>;
  /** Proxy variables (HTTPS_PROXY, HTTP_PROXY, NO_PROXY) read on every npm run; nothing else. */
  proxyEnv?: () => Record<string, string>;
  /** Delay before the network retry; default 3000 ms (tests shorten it). */
  retryDelayMs?: number;
}

/** Classifies npm output as a network failure, a full disk, or anything else. */
export function classifyNpmFailure(output: string): 'network' | 'disk' | 'other' {
  if (/\bENOSPC\b/.test(output)) return 'disk';
  if (
    /\b(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b/.test(output) ||
    /npm (ERR!|error) network/i.test(output) ||
    /request to https:\/\/registry/i.test(output)
  ) {
    return 'network';
  }
  return 'other';
}

/**
 * Builds the clean environment npm runs under. Nothing is inherited from the parent
 * process, in particular no `npm_config_*` variables.
 */
export function buildNpmEnv(opts: {
  nodeBinDir: string;
  home: string;
  tmpdir: string;
  npmCacheDir: string;
}): Record<string, string> {
  return {
    PATH: `${opts.nodeBinDir}:/usr/bin:/bin`,
    HOME: opts.home,
    TMPDIR: opts.tmpdir,
    LANG: 'en_US.UTF-8',
    PUPPETEER_SKIP_DOWNLOAD: '1',
    CI: '1',
    npm_config_cache: opts.npmCacheDir,
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    NO_COLOR: '1',
  };
}

const PROXY_VARS: readonly string[] = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'];

function pickProxyEnv(proxy: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (proxy === undefined) return out;
  for (const name of PROXY_VARS) {
    const v = proxy[name];
    if (v !== undefined && v !== '') out[name] = v;
  }
  return out;
}

interface RunOptions {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  onLine: (line: string, stream: 'stdout' | 'stderr') => void;
}

interface RunOutcome {
  exitCode: number | null;
  signalName: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  spawnError: Error | null;
}

/** Splits a byte stream into lines (LF, CRLF or lone CR) and flushes the remainder at end. */
function lineSplitter(emit: (line: string) => void): { write(chunk: string): void; end(): void } {
  let pending = '';
  return {
    write(chunk) {
      pending += chunk;
      const parts = pending.split(/\r\n|\n|\r/);
      pending = parts.pop() ?? '';
      for (const part of parts) emit(part);
    },
    end() {
      if (pending !== '') emit(pending);
      pending = '';
    },
  };
}

/** Sends `sig` to the child's process group, falling back to the child alone. */
function killTree(pid: number | undefined, sig: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      // Already gone.
    }
  }
}

/**
 * Runs a child in its own process group with piped stdio, a timeout and an optional abort
 * signal. Resolves after the child has exited and its output is drained; never rejects.
 */
function runChild(opts: RunOptions): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const outcome: RunOutcome = {
      exitCode: null,
      signalName: null,
      timedOut: false,
      aborted: false,
      spawnError: null,
    };
    if (opts.signal?.aborted === true) {
      outcome.aborted = true;
      resolve(outcome);
      return;
    }
    const child = spawn(opts.cmd, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const out = lineSplitter((l) => opts.onLine(l, 'stdout'));
    const err = lineSplitter((l) => opts.onLine(l, 'stderr'));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => out.write(c));
    child.stderr.on('data', (c: string) => err.write(c));

    let killTimer: NodeJS.Timeout | undefined;
    const terminate = (): void => {
      killTree(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => killTree(child.pid, 'SIGKILL'), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      outcome.timedOut = true;
      terminate();
    }, opts.timeoutMs);
    const onAbort = (): void => {
      outcome.aborted = true;
      // An abort means the app is quitting: a grace timer would die with the process and leave npm
      // running as an orphan, so kill the whole group now. The install is restartable
      // (installedLockHash is cleared when it starts, so the next launch repairs it).
      killTree(child.pid, 'SIGKILL');
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      // Anything left in the group (grandchildren) must not outlive the run.
      if (outcome.timedOut || outcome.aborted) killTree(child.pid, 'SIGKILL');
      out.end();
      err.end();
      resolve(outcome);
    };
    child.once('error', (e) => {
      outcome.spawnError = e;
      finish();
    });
    child.once('close', (code, sig) => {
      outcome.exitCode = code;
      outcome.signalName = sig;
      finish();
    });
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Creates the install manager for one checkout using the bundled Node and npm. */
export function createInstallManager(opts: InstallManagerOptions): InstallManager {
  const { paths } = opts;
  const log = opts.log.scope('install');
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let cachedVersion: Promise<string> | null = null;

  function childEnv(): Record<string, string> {
    const extra: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      if (!/^npm_config_/i.test(k)) extra[k] = v;
    }
    return {
      ...buildNpmEnv({
        nodeBinDir: dirname(paths.nodeBin),
        home: extra['HOME'] ?? homedir(),
        tmpdir: extra['TMPDIR'] ?? tmpdir(),
        npmCacheDir: paths.npmCacheDir,
      }),
      ...extra,
      ...pickProxyEnv(opts.proxyEnv?.()),
    };
  }

  const lockFile = join(paths.checkoutDir, 'package-lock.json');

  async function lockHash(): Promise<string | null> {
    try {
      return createHash('sha256')
        .update(await readFile(lockFile))
        .digest('hex');
    } catch {
      return null;
    }
  }

  function bundledNodeVersion(): Promise<string> {
    if (cachedVersion === null) {
      const pending = (async (): Promise<string> => {
        const stop = log.time('node --version');
        log.info(`Running ${paths.nodeBin} --version`);
        const lines: string[] = [];
        const outcome = await runChild({
          cmd: paths.nodeBin,
          args: ['--version'],
          cwd: paths.checkoutDir,
          env: childEnv(),
          timeoutMs: VERSION_TIMEOUT_MS,
          onLine: (l) => lines.push(l),
        });
        stop();
        const version = (lines[0] ?? '').trim().replace(/^v/, '');
        if (outcome.exitCode !== 0 || version === '') {
          throw new InstallError(
            'NPM_FAILED',
            'The bundled Node runtime could not report its version.',
            outcome.spawnError?.message ?? `exit ${String(outcome.exitCode)}`,
          );
        }
        return version;
      })();
      cachedVersion = pending;
      pending.catch(() => {
        if (cachedVersion === pending) cachedVersion = null;
      });
    }
    return cachedVersion;
  }

  async function needsInstall(
    state: Pick<ShellState, 'installedLockHash' | 'installedNodeVersion' | 'installedCommit'>,
  ): Promise<NeedsInstall> {
    if (state.installedLockHash === null || state.installedNodeVersion === null) {
      return { needed: true, reason: 'never-installed' };
    }
    if (!(await isDirectory(paths.nodeModulesDir))) {
      return { needed: true, reason: 'no-node-modules' };
    }
    if ((await lockHash()) !== state.installedLockHash) {
      return { needed: true, reason: 'lock-changed' };
    }
    if ((await bundledNodeVersion()) !== state.installedNodeVersion) {
      return { needed: true, reason: 'node-changed' };
    }
    return { needed: false, reason: 'up-to-date' };
  }

  async function preflight(): Promise<void> {
    if (!(await exists(paths.nodeBin))) {
      throw new InstallError(
        'NPM_FAILED',
        'The bundled Node runtime is missing, so dependencies cannot be installed.',
        `Missing file: ${paths.nodeBin}`,
      );
    }
    if (!(await exists(paths.npmCli))) {
      throw new InstallError(
        'NPM_FAILED',
        'The bundled npm is missing, so dependencies cannot be installed.',
        `Missing file: ${paths.npmCli}`,
      );
    }
    if (!(await exists(lockFile))) {
      throw new InstallError(
        'NO_LOCKFILE',
        'The downloaded engine has no package-lock.json, so dependencies cannot be installed.',
        `Missing file: ${lockFile}`,
      );
    }
  }

  /** Runs `npm ci` once; returns the exit status and the output tail. */
  async function runNpmCi(
    onProgress: (p: InstallProgress) => void,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<{ outcome: RunOutcome; tail: string[] }> {
    const ring = createRingBuffer(TAIL_LINES);
    const outcome = await runChild({
      cmd: paths.nodeBin,
      args: [paths.npmCli, 'ci', '--no-audit', '--no-fund', '--loglevel=notice'],
      cwd: paths.checkoutDir,
      env: childEnv(),
      timeoutMs,
      signal,
      onLine: (line, stream) => {
        const safe = redact(line);
        ring.push(safe);
        log.debug(`npm ${stream}: ${safe}`);
        try {
          onProgress({ line: safe, stream });
        } catch (e) {
          log.warn(`Progress listener threw: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    });
    return { outcome, tail: ring.lines() };
  }

  async function install(
    onProgress: (p: InstallProgress) => void,
    callOpts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<InstallResult> {
    const startedAt = performance.now();
    const timeoutMs = callOpts.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
    const signal = callOpts.signal;
    if (signal?.aborted === true) {
      throw new InstallError('ABORTED', 'The install was cancelled.');
    }
    await preflight();
    const nodeVersion = await bundledNodeVersion();

    let attempts = 0;
    for (;;) {
      attempts += 1;
      const stop = log.time(`npm ci (attempt ${attempts})`);
      log.info(
        `Starting npm ci in ${paths.checkoutDir} (timeout ${Math.round(timeoutMs / 1000)}s)`,
      );
      const { outcome, tail } = await runNpmCi(onProgress, timeoutMs, signal);
      stop();

      if (outcome.aborted) {
        throw new InstallError('ABORTED', 'The install was cancelled.');
      }
      if (outcome.timedOut) {
        throw new InstallError(
          'TIMEOUT',
          `The install did not finish within ${Math.round(timeoutMs / 1000)} seconds.`,
          tail.slice(-DETAIL_LINES).join('\n'),
        );
      }
      if (outcome.spawnError !== null) {
        throw new InstallError(
          'NPM_FAILED',
          'The bundled Node runtime could not be started.',
          outcome.spawnError.message,
        );
      }
      if (outcome.exitCode === 0) {
        const hash = await lockHash();
        if (hash === null) {
          throw new InstallError(
            'NO_LOCKFILE',
            'The package-lock.json disappeared while dependencies were installing.',
          );
        }
        const durationMs = Math.round(performance.now() - startedAt);
        log.info(`Install finished in ${durationMs}ms after ${attempts} attempt(s)`);
        return { durationMs, lockHash: hash, nodeVersion, attempts };
      }

      const detail = [
        outcome.signalName !== null
          ? `npm was stopped by ${outcome.signalName}`
          : `npm exited with code ${String(outcome.exitCode)}`,
        ...tail.slice(-DETAIL_LINES),
      ].join('\n');
      const kind = classifyNpmFailure(tail.join('\n'));
      log.warn(`npm ci failed (${kind}): ${detail.split('\n')[0] ?? ''}`);
      if (kind === 'disk') {
        throw new InstallError(
          'DISK_FULL',
          'There is not enough free disk space to install.',
          detail,
        );
      }
      if (kind === 'network') {
        if (attempts >= 2) {
          throw new InstallError(
            'NETWORK',
            'The install could not reach the npm registry. Check your connection and try again.',
            detail,
          );
        }
        log.info(`Network failure; retrying in ${retryDelayMs}ms`);
        await sleep(retryDelayMs, signal);
        if (isAborted(signal)) {
          throw new InstallError('ABORTED', 'The install was cancelled.');
        }
        continue;
      }
      throw new InstallError('NPM_FAILED', 'Installing dependencies failed.', detail);
    }
  }

  async function runDoctor(): Promise<{ output: string; ready: boolean; exitCode: number }> {
    const script = join(paths.checkoutDir, 'scripts', 'setup-doctor.mjs');
    if (!(await exists(script))) {
      log.info('No setup-doctor.mjs in the checkout; skipping');
      return { ready: true, output: 'no doctor script', exitCode: 0 };
    }
    const stop = log.time('setup-doctor');
    log.info(`Running ${script}`);
    const lines: string[] = [];
    let size = 0;
    const outcome = await runChild({
      cmd: paths.nodeBin,
      args: [script],
      cwd: paths.checkoutDir,
      env: childEnv(),
      timeoutMs: DOCTOR_TIMEOUT_MS,
      onLine: (line) => {
        if (size > DOCTOR_OUTPUT_MAX) return;
        const safe = redact(line);
        size += safe.length + 1;
        lines.push(safe);
      },
    });
    stop();
    let output = lines.join('\n');
    let exitCode = outcome.exitCode ?? -1;
    if (outcome.timedOut) {
      output += `${output === '' ? '' : '\n'}The setup doctor timed out after 60 seconds.`;
    } else if (outcome.spawnError !== null) {
      output += `${output === '' ? '' : '\n'}The setup doctor could not be started: ${outcome.spawnError.message}`;
      exitCode = -1;
    }
    const ready = exitCode === 0 && !outcome.timedOut;
    log.info(`Setup doctor finished: ready=${ready} exit=${exitCode}`);
    return { output, ready, exitCode };
  }

  return { lockHash, bundledNodeVersion, needsInstall, install, runDoctor };
}
