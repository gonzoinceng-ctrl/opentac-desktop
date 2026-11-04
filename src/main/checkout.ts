import { existsSync } from 'node:fs';
import { mkdir, readdir, lstat, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Channel } from '../shared/types.js';
import { GitError, redactGitText, redactRemoteUrl } from './git.js';
import type { GitResult, GitRunner } from './git.js';
import type { Logger } from './logger.js';

export { GitError, redactRemoteUrl };
export type { GitErrorCode } from './git.js';

const CLONE_TIMEOUT_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 5 * 60_000;
const LS_REMOTE_TIMEOUT_MS = 30_000;
const DEFAULT_LOG_MAX = 200;
const COMMIT_LOG_FORMAT = '--format=%H%x00%h%x00%s%x00%an%x00%cI';

/** Phase names reported by `git clone --progress`. */
export type CloneProgressPhase =
  'counting' | 'compressing' | 'receiving' | 'resolving' | 'updating';

const PROGRESS_PHASES: ReadonlyArray<readonly [string, CloneProgressPhase]> = [
  ['Counting objects', 'counting'],
  ['Compressing objects', 'compressing'],
  ['Receiving objects', 'receiving'],
  ['Resolving deltas', 'resolving'],
  ['Updating files', 'updating'],
];

/**
 * Parses one stderr progress line such as `Receiving objects:  45% (1234/2718)`.
 * Returns null for anything that is not a percentage progress line.
 */
export function parseCloneProgress(
  line: string,
): { phase: CloneProgressPhase; pct: number } | null {
  const text = line.replace(/^remote:\s*/, '').trim();
  const match = /^([A-Za-z ]+?):\s+(\d{1,3})%/.exec(text);
  if (match === null) return null;
  const name = match[1];
  const pct = Number(match[2]);
  if (name === undefined || pct > 100) return null;
  const phase = PROGRESS_PHASES.find(([prefix]) => prefix === name)?.[1];
  return phase === undefined ? null : { phase, pct };
}

/** Working-tree state relative to HEAD; ignored files never count. */
export interface DirtyReport {
  dirty: boolean;
  modified: string[];
  untracked: string[];
  raw: string;
}

function unquotePath(path: string): string {
  if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"')) return path;
  return path.slice(1, -1).replace(/\\(["\\tn]|[0-7]{3})/g, (_m, esc: string) => {
    if (esc === 't') return '\t';
    if (esc === 'n') return '\n';
    if (esc.length === 3) return String.fromCharCode(parseInt(esc, 8));
    return esc;
  });
}

/**
 * Parses `git status --porcelain=v1 --untracked-files=all --ignored=no` output. Any tracked-file
 * change (including deletions and staged changes) is `modified`; `??` entries are `untracked`.
 */
export function parseDirtyReport(porcelain: string): DirtyReport {
  const modified: string[] = [];
  const untracked: string[] = [];
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.length < 4) continue;
    const xy = line.slice(0, 2);
    if (xy === '!!') continue;
    let path = line.slice(3);
    const arrow = path.indexOf(' -> ');
    if ((xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') && arrow !== -1) {
      path = path.slice(arrow + 4);
    }
    path = unquotePath(path);
    if (xy === '??') untracked.push(path);
    else modified.push(path);
  }
  return {
    dirty: modified.length > 0 || untracked.length > 0,
    modified,
    untracked,
    raw: porcelain,
  };
}

/** One commit as shown in update disclosure. */
export interface CommitInfo {
  sha: string;
  short: string;
  subject: string;
  author: string;
  date: string;
}

/** Parses `git log --format=%H%x00%h%x00%s%x00%an%x00%cI` output; malformed lines are skipped. */
export function parseCommitLog(out: string): CommitInfo[] {
  const commits: CommitInfo[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (line === '') continue;
    const [sha, short, subject, author, date] = line.split('\0');
    if (
      sha === undefined ||
      short === undefined ||
      subject === undefined ||
      author === undefined ||
      date === undefined ||
      sha === ''
    ) {
      continue;
    }
    commits.push({ sha, short, subject, author, date });
  }
  return commits;
}

/** A ref resolved to a commit, with the tags that point at it. */
export interface ResolvedTarget {
  channel: Channel;
  ref: string;
  commit: string;
  upstreamTag: string | null;
  stableTag: string | null;
}

/** HEAD versus a resolved target. */
export interface CheckoutStatus {
  head: string;
  target: ResolvedTarget;
  behind: number;
  ahead: number;
  isAncestor: boolean;
  dirty: DirtyReport;
}

/** An annotated tag message with its `Key: value` lines parsed out. */
export interface TagAnnotation {
  tag: string;
  message: string;
  fields: Record<string, string>;
}

/** Git operations on the engine checkout (03-ARCHITECTURE.md section 4.1, staged-update refs). */
export interface CheckoutManager {
  /** True when checkoutDir/.git exists and `git rev-parse --git-dir` succeeds. */
  exists(): Promise<boolean>;
  /** `git clone --no-checkout --progress`; removes the half-clone on failure. Default timeout 30 min. */
  clone(
    remoteUrl: string,
    onProgress: (p: { phase: string; pct: number }) => void,
    opts?: { timeoutMs?: number },
  ): Promise<void>;
  /**
   * `git fetch --prune --tags origin` without force; default timeout 5 min. With `remoteUrl`
   * (a one-run OPENTAC_ENGINE_REMOTE) it fetches from that URL into the same remote-tracking
   * refs without rewriting the persistent origin.
   */
  fetch(opts?: { timeoutMs?: number; remoteUrl?: string }): Promise<void>;
  /** Resolves a channel (or an OPENTAC_ENGINE_REF-style override) to a commit and its tags. */
  resolveTarget(channel: Channel, override?: string): Promise<ResolvedTarget>;
  /** Full sha of HEAD. */
  head(): Promise<string>;
  /** Behind/ahead counts, ancestry and dirty state of HEAD against `target`. */
  status(target: ResolvedTarget): Promise<CheckoutStatus>;
  /** Tracked modifications and non-ignored untracked files. */
  dirtyReport(): Promise<DirtyReport>;
  /** `git checkout --detach <commit>`. */
  checkoutDetached(commit: string): Promise<void>;
  /** `git reset --hard <commit>` then `git clean -fd`; ignored files survive. */
  resetToTarget(commit: string): Promise<void>;
  /** Commits in `from..to`, newest first, capped at `max` (default 200). */
  commitLog(
    from: string,
    to: string,
    max?: number,
  ): Promise<{ commits: CommitInfo[]; truncated: boolean }>;
  /** True number of commits in `from..to` (`git rev-list --count`), not capped. */
  countCommits(from: string, to: string): Promise<number>;
  /** `git diff --shortstat from..to`, trimmed. */
  diffStat(from: string, to: string): Promise<string>;
  /** True when package-lock.json differs between the two commits. */
  lockfileChanged(from: string, to: string): Promise<boolean>;
  /** Parsed annotation of an annotated tag; null when the tag is missing or lightweight. */
  tagAnnotation(tag: string): Promise<TagAnnotation | null>;
  /** The origin URL exactly as configured (may carry credentials; redact before display). */
  remoteUrl(): Promise<string>;
  /** Points origin at a new URL. */
  setRemoteUrl(url: string): Promise<void>;
  /** `git ls-remote <url> <refs...>` as a ref-to-sha map, without touching the checkout. */
  lsRemote(
    remoteUrl: string,
    refs: string[],
    opts?: { timeoutMs?: number },
  ): Promise<Record<string, string>>;
  /** Size of the .git directory in bytes (fs walk, no git call). */
  repoSizeBytes(): Promise<number>;
}

/** Construction options for {@link createCheckoutManager}. */
export interface CheckoutManagerOptions {
  checkoutDir: string;
  git: GitRunner;
  log: Logger;
}

const NETWORK_PATTERNS: readonly RegExp[] = [
  /could not resolve host/i,
  /unable to access/i,
  /failed to connect/i,
  /connection (?:timed out|refused|reset)/i,
  /network is unreachable/i,
  /temporary failure in name resolution/i,
  /early eof/i,
  /rpc failed/i,
  /\b(?:ssl|tls)\b/i,
  /hung up unexpectedly/i,
  /operation timed out/i,
  /unexpected disconnect/i,
];

function isNetworkText(text: string): boolean {
  return NETWORK_PATTERNS.some((re) => re.test(text));
}

function isBadRefText(text: string): boolean {
  return /unknown revision|bad revision|invalid revision|not a valid object name|ambiguous argument|bad object|invalid reference|not a commit/i.test(
    text,
  );
}

const SAFE_TAG = /^[A-Za-z0-9._/+-]+$/;

function rejectOptionLike(value: string, what: string): void {
  if (value === '' || value.startsWith('-')) {
    throw new GitError('BAD_REF', `${what} is not a valid reference.`, redactRemoteUrl(value));
  }
}

async function dirSize(root: string): Promise<number> {
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    if (dir === undefined) break;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else {
        try {
          total += (await lstat(full)).size;
        } catch {
          // File vanished mid-walk (gc, lock file); ignore.
        }
      }
    }
  }
  return total;
}

/** Creates the checkout manager for `checkoutDir`, running every git call through `git`. */
export function createCheckoutManager(opts: CheckoutManagerOptions): CheckoutManager {
  const { checkoutDir, git, log: rootLog } = opts;
  const log = rootLog.scope('checkout');

  /**
   * Stops git's upward repository discovery at the checkout's parent, so a checkout without its
   * own .git can never resolve to an enclosing work tree (a dotfiles repo, the project repo).
   */
  const confinedEnv = { GIT_CEILING_DIRECTORIES: dirname(checkoutDir) };

  /** Runs git in the checkout and maps generic failures to NOT_A_REPO / BAD_REF. */
  async function run(
    args: string[],
    runOpts: { timeoutMs?: number; expectZero?: boolean } = {},
  ): Promise<GitResult> {
    if (!existsSync(join(checkoutDir, '.git'))) {
      throw new GitError(
        'NOT_A_REPO',
        'The engine checkout is missing or is not a git repository.',
        checkoutDir,
      );
    }
    try {
      return await git.run(args, checkoutDir, { ...runOpts, env: confinedEnv });
    } catch (error) {
      throw classify(error);
    }
  }

  function classify(error: unknown): unknown {
    if (!(error instanceof GitError) || error.code !== 'GIT_FAILED') return error;
    const detail = error.detail ?? '';
    if (
      /not a git repository/i.test(detail) ||
      (/ENOENT/.test(detail) && !existsSync(checkoutDir))
    ) {
      return new GitError(
        'NOT_A_REPO',
        'The engine checkout is missing or is not a git repository.',
        detail,
      );
    }
    if (isBadRefText(detail)) {
      return new GitError('BAD_REF', 'A git reference could not be found in the checkout.', detail);
    }
    return error;
  }

  function unexpected(args: string[], res: GitResult): GitError {
    const detail = redactGitText((res.stderr.trim() || res.stdout.trim()).slice(-4000));
    return new GitError(
      'GIT_FAILED',
      `Git exited with code ${res.code}.`,
      `git ${args[0] ?? ''}: ${detail}`,
    );
  }

  async function revParseCommit(spec: string): Promise<string | null> {
    const res = await run(['rev-parse', '--verify', '--quiet', `${spec}^{commit}`], {
      expectZero: false,
    });
    const sha = res.stdout.trim();
    return res.code === 0 && sha !== '' ? sha : null;
  }

  async function countRange(range: string): Promise<number> {
    const res = await run(['rev-list', '--count', range]);
    const n = Number(res.stdout.trim());
    if (!Number.isInteger(n)) throw unexpected(['rev-list'], res);
    return n;
  }

  async function dirtyReport(): Promise<DirtyReport> {
    const res = await run([
      '--no-optional-locks',
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--ignored=no',
    ]);
    const report = parseDirtyReport(res.stdout);
    if (report.dirty) {
      log.warn(
        `checkout is dirty: ${report.modified.length} modified, ${report.untracked.length} untracked ` +
          `(${[...report.modified, ...report.untracked].slice(0, 20).join(', ')})`,
      );
    }
    return report;
  }

  async function head(): Promise<string> {
    const res = await run(['rev-parse', 'HEAD']);
    return res.stdout.trim();
  }

  return {
    async exists() {
      if (!existsSync(join(checkoutDir, '.git'))) return false;
      try {
        const res = await git.run(['rev-parse', '--show-toplevel'], checkoutDir, {
          expectZero: false,
          timeoutMs: 30_000,
          env: confinedEnv,
        });
        if (res.code !== 0) return false;
        const [top, own] = await Promise.all([realpath(res.stdout.trim()), realpath(checkoutDir)]);
        return top === own;
      } catch {
        return false;
      }
    },

    async clone(remoteUrl, onProgress, cloneOpts = {}) {
      rejectOptionLike(remoteUrl, 'The remote URL');
      const parent = dirname(checkoutDir);
      await mkdir(parent, { recursive: true });
      if (existsSync(checkoutDir)) {
        const entries = await readdir(checkoutDir).catch(() => ['?']);
        if (entries.length > 0) {
          // A non-empty folder that is not a repository is a damaged checkout, not a failed download:
          // NOT_A_REPO maps to the "download again" recovery (a Retry could never succeed).
          throw new GitError(
            'NOT_A_REPO',
            'The engine checkout folder already exists and is not empty.',
            checkoutDir,
          );
        }
      }
      let lastKey = '';
      try {
        await git.run(
          ['clone', '--no-checkout', '--progress', '--', remoteUrl, checkoutDir],
          parent,
          {
            timeoutMs: cloneOpts.timeoutMs ?? CLONE_TIMEOUT_MS,
            onStderrLine: (line) => {
              const p = parseCloneProgress(line);
              if (p === null) return;
              const key = `${p.phase}:${p.pct}`;
              if (key === lastKey) return;
              lastKey = key;
              onProgress(p);
            },
          },
        );
      } catch (error) {
        await rm(checkoutDir, { recursive: true, force: true }).catch(() => undefined);
        if (error instanceof GitError && error.code === 'GIT_FAILED') {
          const detail = error.detail ?? '';
          if (isNetworkText(detail)) {
            throw new GitError('NETWORK', 'Could not reach the engine repository.', detail);
          }
          throw new GitError('CLONE_FAILED', 'Cloning the engine repository failed.', detail);
        }
        throw error;
      }
    },

    async fetch(fetchOpts = {}) {
      if (!existsSync(join(checkoutDir, '.git'))) {
        throw new GitError(
          'NOT_A_REPO',
          'The engine checkout is missing or is not a git repository.',
          checkoutDir,
        );
      }
      try {
        const from = fetchOpts.remoteUrl;
        if (from !== undefined) rejectOptionLike(from, 'The remote');
        const args =
          from === undefined
            ? ['fetch', '--prune', '--tags', 'origin']
            : ['fetch', '--prune', '--tags', from, '+refs/heads/*:refs/remotes/origin/*'];
        await git.run(args, checkoutDir, {
          timeoutMs: fetchOpts.timeoutMs ?? FETCH_TIMEOUT_MS,
          env: confinedEnv,
        });
      } catch (error) {
        const mapped = classify(error);
        if (mapped instanceof GitError && mapped.code === 'GIT_FAILED') {
          const detail = mapped.detail ?? '';
          if (/would clobber existing tag/i.test(detail)) {
            throw new GitError(
              'TAG_DRIFT',
              'A release tag on the remote now points somewhere different from the local copy.',
              detail,
            );
          }
          if (isNetworkText(detail)) {
            throw new GitError('NETWORK', 'Could not reach the engine repository.', detail);
          }
        }
        throw mapped;
      }
    },

    async resolveTarget(channel, override) {
      let ref: string;
      if (override !== undefined && override !== '') {
        rejectOptionLike(override, 'The engine ref override');
        ref = override;
      } else if (channel === 'stable') {
        ref = 'refs/remotes/origin/stable';
      } else if (channel === 'candidate') {
        ref = 'refs/remotes/origin/candidate';
      } else {
        ref = 'refs/remotes/origin/upstream-main';
      }
      const commit = await revParseCommit(ref);
      if (commit === null) {
        throw new GitError(
          'BAD_REF',
          `The engine reference ${ref} was not found in the checkout.`,
          'Fetch the repository first, or check the configured reference.',
        );
      }
      const described = await run(
        ['describe', '--tags', '--exact-match', '--match', 'v*', commit],
        { expectZero: false },
      );
      const upstreamTag =
        described.code === 0 && described.stdout.trim() !== '' ? described.stdout.trim() : null;
      const stable = await run(
        ['tag', '--list', 'stable-*', '--points-at', commit, '--sort=-creatordate'],
        { expectZero: false },
      );
      const stableTag =
        stable.code === 0
          ? (stable.stdout
              .split(/\r?\n/)
              .find((l) => l.trim() !== '')
              ?.trim() ?? null)
          : null;
      return { channel, ref, commit, upstreamTag, stableTag };
    },

    head,

    async status(target) {
      const headSha = await head();
      const behind = await countRange(`${headSha}..${target.commit}`);
      const ahead = await countRange(`${target.commit}..${headSha}`);
      const anc = await run(['merge-base', '--is-ancestor', headSha, target.commit], {
        expectZero: false,
      });
      if (anc.code !== 0 && anc.code !== 1) throw unexpected(['merge-base'], anc);
      const dirty = await dirtyReport();
      return { head: headSha, target, behind, ahead, isAncestor: anc.code === 0, dirty };
    },

    dirtyReport,

    async checkoutDetached(commit) {
      rejectOptionLike(commit, 'The commit');
      await run(['checkout', '--quiet', '--detach', commit, '--'], { timeoutMs: FETCH_TIMEOUT_MS });
    },

    async resetToTarget(commit) {
      rejectOptionLike(commit, 'The commit');
      await run(['reset', '--hard', '--quiet', commit, '--'], { timeoutMs: FETCH_TIMEOUT_MS });
      await run(['clean', '-fd', '--quiet'], { timeoutMs: FETCH_TIMEOUT_MS });
    },

    async commitLog(from, to, max = DEFAULT_LOG_MAX) {
      rejectOptionLike(from, 'The start commit');
      rejectOptionLike(to, 'The end commit');
      const limit = Math.max(1, Math.floor(max));
      const res = await run([
        'log',
        COMMIT_LOG_FORMAT,
        '-n',
        String(limit + 1),
        `${from}..${to}`,
        '--',
      ]);
      const all = parseCommitLog(res.stdout);
      return { commits: all.slice(0, limit), truncated: all.length > limit };
    },

    async countCommits(from, to) {
      rejectOptionLike(from, 'The start commit');
      rejectOptionLike(to, 'The end commit');
      return countRange(`${from}..${to}`);
    },

    async diffStat(from, to) {
      rejectOptionLike(from, 'The start commit');
      rejectOptionLike(to, 'The end commit');
      const res = await run(['diff', '--shortstat', `${from}..${to}`, '--']);
      return res.stdout.trim();
    },

    async lockfileChanged(from, to) {
      rejectOptionLike(from, 'The start commit');
      rejectOptionLike(to, 'The end commit');
      const res = await run(['diff', '--quiet', from, to, '--', 'package-lock.json'], {
        expectZero: false,
      });
      if (res.code === 0) return false;
      if (res.code === 1) return true;
      throw classify(unexpected(['diff'], res));
    },

    async tagAnnotation(tag) {
      if (!SAFE_TAG.test(tag) || tag.startsWith('-')) {
        throw new GitError('BAD_REF', 'The tag name is not valid.', tag);
      }
      const res = await run([
        'for-each-ref',
        `refs/tags/${tag}`,
        '--format=%(objecttype)%00%(contents)',
      ]);
      const out = res.stdout.replace(/\r\n/g, '\n');
      const nul = out.indexOf('\0');
      if (nul === -1) return null;
      if (out.slice(0, nul) !== 'tag') return null;
      const message = out.slice(nul + 1).trim();
      const fields: Record<string, string> = {};
      for (const line of message.split('\n')) {
        const m = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
        if (m?.[1] !== undefined) fields[m[1]] = (m[2] ?? '').trim();
      }
      return { tag, message, fields };
    },

    async remoteUrl() {
      const res = await run(['remote', 'get-url', 'origin']);
      return res.stdout.trim();
    },

    async setRemoteUrl(url) {
      rejectOptionLike(url, 'The remote URL');
      await run(['remote', 'set-url', 'origin', url]);
    },

    async lsRemote(remoteUrl, refs, lsOpts = {}) {
      rejectOptionLike(remoteUrl, 'The remote URL');
      let res: GitResult;
      try {
        res = await git.run(['ls-remote', '--', remoteUrl, ...refs], tmpdir(), {
          timeoutMs: lsOpts.timeoutMs ?? LS_REMOTE_TIMEOUT_MS,
        });
      } catch (error) {
        if (
          error instanceof GitError &&
          error.code === 'GIT_FAILED' &&
          isNetworkText(error.detail ?? '')
        ) {
          throw new GitError('NETWORK', 'Could not reach the engine repository.', error.detail);
        }
        throw error;
      }
      const out: Record<string, string> = {};
      for (const line of res.stdout.split(/\r?\n/)) {
        const m = /^([0-9a-f]{40,64})\t(.+)$/.exec(line);
        if (m?.[1] !== undefined && m[2] !== undefined) out[m[2]] = m[1];
      }
      return out;
    },

    async repoSizeBytes() {
      return dirSize(join(checkoutDir, '.git'));
    },
  };
}
