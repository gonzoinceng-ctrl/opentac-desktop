/**
 * Engine update checks (docs/SHELL-DESIGN.md section 3, steps 1-4). This module only decides
 * and describes; it never changes the checkout. Applying an update is the controller's job.
 * Nothing here concerns the Electron shell's own updater (shellUpdate.ts): keep them separate.
 */
import semver from 'semver';
import type { Disclosure, DisclosureCommit } from '../shared/ipc.js';
import type { Channel } from '../shared/types.js';
import type {
  CheckoutManager,
  CheckoutStatus,
  CommitInfo,
  ResolvedTarget,
  TagAnnotation,
} from './checkout.js';
import { GitError, redactRemoteUrl } from './git.js';
import type { InstallManager } from './install.js';
import type { Logger } from './logger.js';

/** Maximum commits listed in a disclosure. */
export const DISCLOSURE_COMMIT_LIMIT = 200;

/** Outcome of one update check. */
export type UpdateCheck =
  | { kind: 'up-to-date'; label: string }
  | { kind: 'available'; target: ResolvedTarget; disclosure: Disclosure }
  | { kind: 'offline' }
  | { kind: 'tag-drift'; detail: string }
  | { kind: 'blocked-by-shell'; disclosure: Disclosure };

/** Dependencies of {@link createUpdateManager}. */
export interface UpdateManagerDeps {
  checkout: CheckoutManager;
  /** Reserved for install-aware decisions; the lockfile flag itself comes from the checkout. */
  install: InstallManager;
  log: Logger;
  /** The shell's own version (`app.getVersion()`), compared with the annotation's `minShell`. */
  appVersion: string;
  /** Remote the checkout follows right now (state value or the CI override). */
  remoteUrl: () => string;
  channel: () => Channel;
  /** OPENTAC_ENGINE_REF-style override of the channel resolution. */
  refOverride?: string | undefined;
}

/** Checks the remote for a newer engine commit and builds the disclosure. */
export interface UpdateManager {
  check(opts: { interactive: boolean }): Promise<UpdateCheck>;
}

/** The ref on the remote that a channel follows (what `git ls-remote` is asked about). */
export function remoteRefFor(channel: Channel, refOverride?: string): string {
  if (refOverride !== undefined && refOverride !== '') return refOverride;
  if (channel === 'stable') return 'refs/heads/stable';
  if (channel === 'candidate') return 'refs/heads/candidate';
  return 'refs/heads/upstream-main';
}

/** First seven characters of a commit id. */
export function shortSha(commit: string): string {
  return commit.slice(0, 7);
}

/**
 * Human label of a resolved commit: the upstream release tag when known, else the short sha,
 * followed by the `stable-*` promotion tag in brackets when there is one.
 */
export function labelFor(
  target: Pick<ResolvedTarget, 'commit' | 'upstreamTag' | 'stableTag'>,
): string {
  const base = target.upstreamTag ?? shortSha(target.commit);
  return target.stableTag !== null ? `${base} (${target.stableTag})` : base;
}

const GITHUB_HTTPS = /^https?:\/\/(?:[^@/\s]+@)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s?#]+?)(?:\.git)?\/?(?:[?#].*)?$/i;
const GITHUB_SCP = /^(?:[^@/\s]+@)?github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;
const GITHUB_SSH = /^(?:ssh|git):\/\/(?:[^@/\s]+@)?github\.com(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;
const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/**
 * `https://github.com/<owner>/<repo>/compare/<from>...<to>` for GitHub remotes (https, ssh or
 * scp-style); null for any other host, for local paths and for `file://` mirrors.
 */
export function compareUrlFor(remoteUrl: string, from: string, to: string): string | null {
  const url = remoteUrl.trim();
  const m = GITHUB_HTTPS.exec(url) ?? GITHUB_SSH.exec(url) ?? GITHUB_SCP.exec(url);
  const owner = m?.[1];
  const repo = m?.[2];
  if (owner === undefined || repo === undefined) return null;
  if (!SAFE_SEGMENT.test(owner) || !SAFE_SEGMENT.test(repo)) return null;
  if (!/^[A-Za-z0-9._/+-]+$/.test(from) || !/^[A-Za-z0-9._/+-]+$/.test(to)) return null;
  return `https://github.com/${owner}/${repo}/compare/${from}...${to}`;
}

/** Everything {@link buildDisclosure} needs, already gathered from the checkout. */
export interface DisclosureInput {
  remoteUrl: string;
  channel: Channel;
  from: { commit: string; label: string };
  to: { commit: string; label: string };
  status: Pick<CheckoutStatus, 'behind' | 'isAncestor'> & {
    dirty: Pick<CheckoutStatus['dirty'], 'modified' | 'untracked'>;
  };
  log: { commits: CommitInfo[]; truncated: boolean };
  diffStat: string;
  lockfileChanged: boolean;
  /** Annotation of the target's `stable-*` tag, when it has one. */
  annotation: TagAnnotation | null;
  appVersion: string;
}

function nonEmpty(v: string | undefined): string | null {
  return v !== undefined && v.trim() !== '' ? v.trim() : null;
}

/** True when `minShell` is a valid version greater than the running app's version. */
export function isShellTooOld(minShell: string | null, appVersion: string): boolean {
  if (minShell === null) return false;
  if (semver.valid(minShell) === null || semver.valid(appVersion) === null) return false;
  return semver.gt(minShell, appVersion);
}

/** Pure disclosure builder (docs/SHELL-DESIGN.md section 3, step 3). */
export function buildDisclosure(input: DisclosureInput): Disclosure {
  const fields = input.annotation?.fields ?? {};
  const minShellRaw = nonEmpty(fields['minShell']);
  const minShell = minShellRaw !== null && semver.valid(minShellRaw) !== null ? minShellRaw : null;
  const commits: DisclosureCommit[] = input.log.commits.map((c) => ({
    sha: c.sha,
    short: c.short,
    subject: c.subject,
    author: c.author,
    date: c.date,
  }));
  return {
    remote: redactRemoteUrl(input.remoteUrl),
    channel: input.channel,
    fromCommit: input.from.commit,
    toCommit: input.to.commit,
    fromLabel: input.from.label,
    toLabel: input.to.label,
    commitCount: input.status.behind,
    truncated: input.log.truncated,
    commits,
    diffStat: input.diffStat,
    lockfileChanged: input.lockfileChanged,
    compareUrl: compareUrlFor(input.remoteUrl, input.from.commit, input.to.commit),
    dirty: {
      modified: [...input.status.dirty.modified],
      untracked: [...input.status.dirty.untracked],
    },
    needsReset: !input.status.isAncestor,
    untested: input.channel !== 'stable',
    gate:
      input.annotation === null
        ? null
        : {
            gateRun: nonEmpty(fields['gateRun']),
            canaryDays: nonEmpty(fields['canaryDays']),
            testedOn: nonEmpty(fields['testedOn']),
          },
    minShell,
    severity: fields['severity'] === 'security' ? 'security' : 'normal',
    blockedByShell: isShellTooOld(minShell, input.appVersion),
  };
}

function isNetwork(err: unknown): boolean {
  return err instanceof GitError && err.code === 'NETWORK';
}

/** Creates the update manager. */
export function createUpdateManager(deps: UpdateManagerDeps): UpdateManager {
  const { checkout, appVersion } = deps;
  const log = deps.log.scope('update');

  async function labelOfHead(headSha: string): Promise<string> {
    try {
      const t = await checkout.resolveTarget(deps.channel(), headSha);
      return labelFor(t);
    } catch (err) {
      log.debug(`could not label HEAD ${shortSha(headSha)}: ${err instanceof Error ? err.message : String(err)}`);
      return shortSha(headSha);
    }
  }

  /** Label for "you are on X": the resolved target when it is HEAD, else the short sha. */
  async function upToDateLabel(headSha: string): Promise<string> {
    return labelOfHead(headSha);
  }

  /** Step 1, cheap path: true = definitely up to date, false = unknown or different. */
  async function remoteEqualsHead(
    headSha: string,
  ): Promise<{ equal: boolean } | { offline: true }> {
    const ref = remoteRefFor(deps.channel(), deps.refOverride);
    const stop = log.time(`ls-remote ${ref}`);
    try {
      const refs = await checkout.lsRemote(deps.remoteUrl(), [ref]);
      const sha = refs[ref] ?? (deps.refOverride !== undefined ? Object.values(refs)[0] : undefined);
      return { equal: sha !== undefined && sha === headSha };
    } catch (err) {
      if (isNetwork(err)) return { offline: true };
      log.warn(`ls-remote failed, falling back to a full fetch: ${err instanceof Error ? err.message : String(err)}`);
      return { equal: false };
    } finally {
      stop();
    }
  }

  async function check(opts: { interactive: boolean }): Promise<UpdateCheck> {
    log.info(`checking for engine updates (interactive=${String(opts.interactive)}, channel=${deps.channel()})`);
    const headSha = await checkout.head();

    const cheap = await remoteEqualsHead(headSha);
    if ('offline' in cheap) return { kind: 'offline' };
    if (cheap.equal) {
      log.info('remote ref equals HEAD; up to date (no fetch)');
      return { kind: 'up-to-date', label: await upToDateLabel(headSha) };
    }

    const stopFetch = log.time('fetch');
    try {
      await checkout.fetch();
    } catch (err) {
      if (isNetwork(err)) return { kind: 'offline' };
      if (err instanceof GitError && err.code === 'TAG_DRIFT') {
        return { kind: 'tag-drift', detail: err.detail ?? err.message };
      }
      throw err;
    } finally {
      stopFetch();
    }

    const target = await checkout.resolveTarget(deps.channel(), deps.refOverride);
    const status = await checkout.status(target);
    if (status.head === target.commit) {
      return { kind: 'up-to-date', label: labelFor(target) };
    }

    const [fromLabel, commitLog, diffStat, lockfileChanged, annotation] = await Promise.all([
      labelOfHead(status.head),
      checkout.commitLog(status.head, target.commit, DISCLOSURE_COMMIT_LIMIT),
      checkout.diffStat(status.head, target.commit),
      checkout.lockfileChanged(status.head, target.commit),
      target.stableTag !== null ? checkout.tagAnnotation(target.stableTag) : Promise.resolve(null),
    ]);

    const disclosure = buildDisclosure({
      remoteUrl: deps.remoteUrl(),
      channel: deps.channel(),
      from: { commit: status.head, label: fromLabel },
      to: { commit: target.commit, label: labelFor(target) },
      status,
      log: commitLog,
      diffStat,
      lockfileChanged,
      annotation,
      appVersion,
    });

    if (disclosure.blockedByShell) {
      log.warn(
        `engine ${disclosure.toLabel} needs OpenTac ${disclosure.minShell ?? '?'} or newer; running ${appVersion}`,
      );
      return { kind: 'blocked-by-shell', disclosure };
    }
    log.info(
      `update available: ${disclosure.fromLabel} -> ${disclosure.toLabel} (${disclosure.commitCount} commits, lockfileChanged=${String(disclosure.lockfileChanged)}, needsReset=${String(disclosure.needsReset)})`,
    );
    return { kind: 'available', target, disclosure };
  }

  return { check };
}
