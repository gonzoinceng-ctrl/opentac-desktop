import type { ChildProcess } from 'node:child_process';
import { exec } from 'dugite';
import treeKill from 'tree-kill';
import { redact } from '../shared/redact.js';
import type { Logger } from './logger.js';

/** Default per-invocation timeout. */
const DEFAULT_TIMEOUT_MS = 120_000;
/** Largest stdout/stderr git may produce before the process is terminated. */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
/** Time a killed process gets to exit after SIGTERM (and again after SIGKILL). */
const DEFAULT_KILL_GRACE_MS = 2_000;
/** PATH handed to git: system tools only, nothing from the user's shell. */
const MINIMAL_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
/** Longest stderr excerpt kept as {@link GitError.detail}. */
const MAX_DETAIL_CHARS = 4_000;

/** Stable error codes thrown by the git runner and the checkout manager. */
export type GitErrorCode =
  | 'GIT_FAILED'
  | 'GIT_TIMEOUT'
  | 'CLONE_FAILED'
  | 'NETWORK'
  | 'TAG_DRIFT'
  | 'NOT_A_REPO'
  | 'BAD_REF';

/** Error thrown by every git operation; `message` is a plain sentence, `detail` redacted stderr. */
export class GitError extends Error {
  readonly code: GitErrorCode;
  readonly detail?: string;

  /** Creates an error with a stable `code`, a plain-sentence `message` and optional redacted `detail`. */
  constructor(code: GitErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'GitError';
    this.code = code;
    if (detail !== undefined && detail !== '') this.detail = detail;
  }
}

/**
 * Removes credentials from a remote URL before it is printed: userinfo becomes `***` and the
 * query string and fragment are dropped whole. Non-URLs (scp-style `git@host:x`, local paths) are
 * returned unchanged. Mirrors `redactRemoteUrl` in upstream's scripts/pinokio-update.mjs.
 */
export function redactRemoteUrl(url: string): string {
  if (url.length === 0) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const hadUserinfo = parsed.username !== '' || parsed.password !== '';
  const hadQuery = parsed.search !== '' || parsed.hash !== '';
  if (!hadUserinfo && !hadQuery) return url;
  parsed.password = '';
  if (hadUserinfo) parsed.username = '***';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

/** Matches `scheme://...` runs inside free text, stopping at whitespace and quotes. */
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi;
/** Sentence punctuation that may trail a URL in git's messages but is not part of it. */
const TRAILING_PUNCTUATION = /[.,;:)\]]+$/;

/**
 * Redacts credentials from free text such as git stderr: every embedded URL goes through
 * {@link redactRemoteUrl}, then the general secret redaction runs.
 */
export function redactGitText(text: string): string {
  const urlsClean = text.replace(URL_IN_TEXT, (match) => {
    const trailing = TRAILING_PUNCTUATION.exec(match)?.[0] ?? '';
    const core = trailing === '' ? match : match.slice(0, match.length - trailing.length);
    return redactRemoteUrl(core) + trailing;
  });
  return redact(urlsClean);
}

/** Result of one git invocation. */
export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** Per-invocation options. */
export interface GitRunOptions {
  /** Kill git and throw GIT_TIMEOUT after this long; default 120 000 ms. */
  timeoutMs?: number;
  /** Extra environment variables, applied after the runner's own. */
  env?: Record<string, string>;
  /** Called for each stderr line as it arrives (git progress uses carriage returns). */
  onStderrLine?: (line: string) => void;
  /** Default true: a non-zero exit throws GitError GIT_FAILED with redacted stderr as detail. */
  expectZero?: boolean;
}

/** Runs git (dugite's embedded binary) with a fixed, non-interactive environment. */
export interface GitRunner {
  /** Runs `git <args>` in `cwd`; see {@link GitRunOptions}. */
  run(args: string[], cwd: string, opts?: GitRunOptions): Promise<GitResult>;
}

/** Construction options for {@link createGitRunner}. */
export interface GitRunnerOptions {
  /** Directory of dugite's git tree (Paths.gitDir); exported as LOCAL_GIT_DIRECTORY. */
  gitDir: string;
  log: Logger;
  /** Extra environment for every call (HOME and identity overrides in tests). */
  baseEnv?: Record<string, string>;
  /** Replacement for dugite's exec, for tests. */
  execImpl?: typeof exec;
  /** How long a killed process may take to exit before SIGKILL / giving up; default 2000 ms. */
  killGraceMs?: number;
}

/** Environment variables that would redirect git away from the checkout; always removed. */
const SCRUBBED_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_EXEC_PATH',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_PROXY_COMMAND',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG',
] as const;

/** Prefix of every git control variable; any inherited one not set by the runner is removed. */
const GIT_VAR_PREFIX = 'GIT_';

function buildEnv(
  gitDir: string,
  baseEnv: Record<string, string> | undefined,
  callEnv: Record<string, string> | undefined,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const name of SCRUBBED_ENV) env[name] = undefined;
  // dugite merges all of process.env beneath the supplied env; blank every inherited GIT_*
  // variable (including GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n) so none can steer git.
  for (const name of Object.keys(process.env)) {
    if (name.startsWith(GIT_VAR_PREFIX)) env[name] = undefined;
  }
  env['HOME'] = baseEnv?.['HOME'] ?? process.env['HOME'] ?? '';
  env['PATH'] = MINIMAL_PATH;
  Object.assign(env, baseEnv);
  Object.assign(env, {
    LOCAL_GIT_DIRECTORY: gitDir,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    LC_ALL: 'C',
    GIT_ALLOW_PROTOCOL: 'file:https:http:ssh:git',
    // Config injected through the environment: no credential helpers, no background gc/fsmonitor
    // processes that could outlive the call, readable paths in porcelain output.
    GIT_CONFIG_COUNT: '4',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'gc.auto',
    GIT_CONFIG_VALUE_1: '0',
    GIT_CONFIG_KEY_2: 'maintenance.auto',
    GIT_CONFIG_VALUE_2: 'false',
    GIT_CONFIG_KEY_3: 'core.quotePath',
    GIT_CONFIG_VALUE_3: 'false',
  });
  if (callEnv !== undefined) Object.assign(env, callEnv);
  return env;
}

/** Splits streamed text into lines on `\r` and `\n`, buffering the unfinished tail. */
function createLineSplitter(onLine: (line: string) => void): {
  push(chunk: string): void;
  flush(): void;
} {
  let tail = '';
  const emit = (line: string): void => {
    if (line === '') return;
    try {
      onLine(line);
    } catch {
      // A throwing listener must not break the git call.
    }
  };
  return {
    push(chunk) {
      const parts = (tail + chunk).split(/[\r\n]/);
      tail = parts.pop() ?? '';
      for (const part of parts) emit(part);
    },
    flush() {
      const rest = tail;
      tail = '';
      emit(rest);
    },
  };
}

/** Resolves true when `settled` completes within `ms`, false otherwise; never leaves a timer. */
async function settlesWithin(settled: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([settled.then(() => true as const), expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Signals the git process and its descendants (git-remote-https, index-pack): a plain kill of the
 * parent leaves them holding the stdio pipes, so the call would not settle. Test doubles without
 * a pid get a plain `kill`.
 */
function safeKill(child: ChildProcess | undefined, signal: NodeJS.Signals): void {
  if (child === undefined) return;
  try {
    if (typeof child.pid === 'number') treeKill(child.pid, signal, () => undefined);
    else child.kill(signal);
  } catch {
    // Already gone.
  }
}

/** Progress meter lines such as `Receiving objects:  45% (1234/2718)` (also `remote:` ones). */
const PROGRESS_LINE = /^\s*(?:remote:\s*)?[A-Za-z][A-Za-z ]*:\s+\d+%/;

/**
 * Reduces stderr to what explains a failure: carriage-return progress redraws and percentage
 * lines are dropped, so the trailing `fatal:` line survives the later tail truncation.
 */
function failureText(stderr: string): string {
  return stderr
    .split(/[\r\n]+/)
    .filter((line) => line.trim() !== '' && !PROGRESS_LINE.test(line))
    .join('\n')
    .trim();
}

type Outcome =
  { ok: true; stdout: string; stderr: string; code: number } | { ok: false; error: unknown };

/** Creates a runner over dugite's `exec` with the non-interactive environment described above. */
export function createGitRunner(opts: GitRunnerOptions): GitRunner {
  const execImpl = opts.execImpl ?? exec;
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const { log } = opts;

  return {
    async run(args, cwd, runOpts = {}) {
      const timeoutMs = runOpts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const expectZero = runOpts.expectZero ?? true;
      const label = `git ${args.map((a) => redactRemoteUrl(a)).join(' ')}`;
      const env = buildEnv(opts.gitDir, opts.baseEnv, runOpts.env);
      const startedAt = performance.now();
      const stopTimer = log.time(label);
      log.info(`${label} starting (timeout ${timeoutMs}ms)`);

      let child: ChildProcess | undefined;
      const splitter =
        runOpts.onStderrLine === undefined ? undefined : createLineSplitter(runOpts.onStderrLine);

      const settled: Promise<Outcome> = (async (): Promise<Outcome> => {
        try {
          const res = await execImpl(args, cwd, {
            env,
            maxBuffer: MAX_BUFFER_BYTES,
            processCallback: (cp) => {
              child = cp;
              if (splitter !== undefined) {
                cp.stderr?.on('data', (chunk: Buffer | string) => splitter.push(chunk.toString()));
              }
            },
          });
          return {
            ok: true,
            stdout: res.stdout.toString(),
            stderr: res.stderr.toString(),
            code: res.exitCode,
          };
        } catch (error) {
          return { ok: false, error };
        }
      })();

      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      const first = await Promise.race([settled, timeout]);
      if (timer !== undefined) clearTimeout(timer);

      if (first === 'timeout') {
        safeKill(child, 'SIGTERM');
        if (!(await settlesWithin(settled, killGraceMs))) {
          safeKill(child, 'SIGKILL');
          await settlesWithin(settled, killGraceMs);
        }
        splitter?.flush();
        stopTimer();
        log.warn(`${label} timed out after ${timeoutMs}ms`);
        throw new GitError(
          'GIT_TIMEOUT',
          `Git did not finish within ${Math.round(timeoutMs / 1000)} seconds and was stopped.`,
          redactGitText(label),
        );
      }

      splitter?.flush();
      stopTimer();
      const durationMs = Math.round(performance.now() - startedAt);
      if (!first.ok) {
        const message = first.error instanceof Error ? first.error.message : String(first.error);
        log.warn(`${label} could not run: ${message}`);
        throw new GitError(
          'GIT_FAILED',
          'Git could not be started.',
          redactGitText(message).slice(0, MAX_DETAIL_CHARS),
        );
      }

      if (first.code !== 0 && expectZero) {
        const raw = failureText(first.stderr) || first.stdout.trim();
        log.warn(`${label} exited with code ${first.code} after ${durationMs}ms`);
        throw new GitError(
          'GIT_FAILED',
          `Git exited with code ${first.code}.`,
          redactGitText(raw.slice(-MAX_DETAIL_CHARS)),
        );
      }
      return { code: first.code, stdout: first.stdout, stderr: first.stderr, durationMs };
    },
  };
}
