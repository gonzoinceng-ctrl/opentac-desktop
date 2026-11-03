import { describe, expect, it } from 'vitest';
import { GitError } from '../../src/main/git.js';
import {
  buildDisclosure,
  compareUrlFor,
  createUpdateManager,
  isShellTooOld,
  labelFor,
  remoteRefFor,
  type UpdateManager,
} from '../../src/main/update.js';
import type { CommitInfo } from '../../src/main/checkout.js';
import type { Channel } from '../../src/shared/types.js';
import { FakeCheckout, FakeInstall, SHA_A, SHA_B, SHA_C, testLogger } from '../helpers/core-fakes.js';

function commit(n: number): CommitInfo {
  const sha = String(n).padStart(40, '0');
  return { sha, short: sha.slice(0, 7), subject: `commit ${n}`, author: 'Ann', date: '2026-11-01T10:00:00Z' };
}

interface Setup {
  co: FakeCheckout;
  mgr: UpdateManager;
}

function setup(
  opts: { appVersion?: string; remote?: string; channel?: Channel; refOverride?: string } = {},
): Setup {
  const co = new FakeCheckout();
  const channel = opts.channel ?? 'stable';
  const mgr = createUpdateManager({
    checkout: co,
    install: new FakeInstall(),
    log: testLogger().log,
    appVersion: opts.appVersion ?? '0.1.0',
    remoteUrl: () => opts.remote ?? 'https://github.com/o/r.git',
    channel: () => channel,
    refOverride: opts.refOverride,
  });
  return { co, mgr };
}

describe('labelFor', () => {
  it('uses the upstream tag, the short sha, and the stable tag in brackets', () => {
    expect(labelFor({ commit: SHA_A, upstreamTag: 'v0.1.0', stableTag: 'stable-2026.11.01' })).toBe(
      'v0.1.0 (stable-2026.11.01)',
    );
    expect(labelFor({ commit: SHA_A, upstreamTag: 'v0.1.0', stableTag: null })).toBe('v0.1.0');
    expect(labelFor({ commit: SHA_A, upstreamTag: null, stableTag: 'stable-1' })).toBe('aaaaaaa (stable-1)');
    expect(labelFor({ commit: SHA_A, upstreamTag: null, stableTag: null })).toBe('aaaaaaa');
  });
});

describe('compareUrlFor', () => {
  it('derives a compare link from GitHub remotes only', () => {
    const want = 'https://github.com/o/r/compare/a1...b2';
    expect(compareUrlFor('https://github.com/o/r.git', 'a1', 'b2')).toBe(want);
    expect(compareUrlFor('https://github.com/o/r', 'a1', 'b2')).toBe(want);
    expect(compareUrlFor('https://github.com/o/r/', 'a1', 'b2')).toBe(want);
    expect(compareUrlFor('https://user:tok@github.com/o/r.git', 'a1', 'b2')).toBe(want);
    expect(compareUrlFor('git@github.com:o/r.git', 'a1', 'b2')).toBe(want);
    expect(compareUrlFor('ssh://git@github.com/o/r.git', 'a1', 'b2')).toBe(want);
  });

  it('returns null for other hosts, local paths and odd input', () => {
    expect(compareUrlFor('https://gitlab.com/o/r.git', 'a', 'b')).toBeNull();
    expect(compareUrlFor('https://github.com.evil.example/o/r.git', 'a', 'b')).toBeNull();
    expect(compareUrlFor('file:///tmp/mirror.git', 'a', 'b')).toBeNull();
    expect(compareUrlFor('/tmp/mirror.git', 'a', 'b')).toBeNull();
    expect(compareUrlFor('https://github.com/o', 'a', 'b')).toBeNull();
    expect(compareUrlFor('https://github.com/o/r.git', 'a b', 'b')).toBeNull();
  });
});

describe('remoteRefFor', () => {
  it('maps channels to remote branches and honours an override', () => {
    expect(remoteRefFor('stable')).toBe('refs/heads/stable');
    expect(remoteRefFor('candidate')).toBe('refs/heads/candidate');
    expect(remoteRefFor('upstream')).toBe('refs/heads/upstream-main');
    expect(remoteRefFor('stable', 'refs/heads/foo')).toBe('refs/heads/foo');
  });
});

describe('isShellTooOld', () => {
  it('compares with semver and ignores invalid input', () => {
    expect(isShellTooOld('0.2.0', '0.1.0')).toBe(true);
    expect(isShellTooOld('0.1.0', '0.1.0')).toBe(false);
    expect(isShellTooOld('0.1.0', '0.10.0')).toBe(false);
    expect(isShellTooOld(null, '0.1.0')).toBe(false);
    expect(isShellTooOld('banana', '0.1.0')).toBe(false);
  });
});

describe('buildDisclosure', () => {
  const base = {
    remoteUrl: 'https://tok:secret@github.com/o/r.git',
    channel: 'stable' as Channel,
    from: { commit: SHA_A, label: 'v0.1.0' },
    to: { commit: SHA_B, label: 'bbbbbbb' },
    status: { behind: 2, isAncestor: true, dirty: { modified: ['a.js'], untracked: ['b.txt'] } },
    log: { commits: [commit(2), commit(1)], truncated: false },
    diffStat: '3 files changed',
    lockfileChanged: false,
    annotation: null,
    appVersion: '0.1.0',
  };

  it('fills every field and redacts the remote', () => {
    const d = buildDisclosure(base);
    expect(d.remote).not.toContain('secret');
    expect(d).toMatchObject({
      channel: 'stable',
      fromCommit: SHA_A,
      toCommit: SHA_B,
      fromLabel: 'v0.1.0',
      toLabel: 'bbbbbbb',
      commitCount: 2,
      truncated: false,
      diffStat: '3 files changed',
      lockfileChanged: false,
      needsReset: false,
      untested: false,
      gate: null,
      minShell: null,
      severity: 'normal',
      blockedByShell: false,
    });
    expect(d.commits.map((c) => c.subject)).toEqual(['commit 2', 'commit 1']);
    expect(d.dirty).toEqual({ modified: ['a.js'], untracked: ['b.txt'] });
    expect(d.compareUrl).toBe(`https://github.com/o/r/compare/${SHA_A}...${SHA_B}`);
  });

  it('reads gate fields, minShell and severity from the annotation', () => {
    const d = buildDisclosure({
      ...base,
      annotation: {
        tag: 'stable-1',
        message: '',
        fields: { gateRun: 'https://x/run/1', canaryDays: '3', minShell: '0.1.0', severity: 'security', testedOn: 'macos-15' },
      },
    });
    expect(d.gate).toEqual({ gateRun: 'https://x/run/1', canaryDays: '3', testedOn: 'macos-15' });
    expect(d.minShell).toBe('0.1.0');
    expect(d.severity).toBe('security');
    expect(d.blockedByShell).toBe(false);
  });

  it('flags untested for non-stable channels and needsReset for non-ancestors', () => {
    const d = buildDisclosure({ ...base, channel: 'candidate', status: { ...base.status, isAncestor: false } });
    expect(d.untested).toBe(true);
    expect(d.needsReset).toBe(true);
  });

  it('flags blockedByShell when minShell is newer than the app and drops invalid minShell', () => {
    const annotation = { tag: 't', message: '', fields: { minShell: '2.0.0' } };
    expect(buildDisclosure({ ...base, annotation }).blockedByShell).toBe(true);
    const bad = buildDisclosure({ ...base, annotation: { tag: 't', message: '', fields: { minShell: 'soon' } } });
    expect(bad.minShell).toBeNull();
    expect(bad.blockedByShell).toBe(false);
  });
});

describe('check: cheap path', () => {
  it('is up to date when the remote sha equals HEAD, without fetching', async () => {
    const { co, mgr } = setup();
    co.headSha = SHA_B;
    co.lsRemoteResult = { 'refs/heads/stable': SHA_B };
    co.resolveTags[SHA_B] = { upstreamTag: 'v0.1.0', stableTag: 'stable-2026.11.01' };
    const r = await mgr.check({ interactive: false });
    expect(r).toEqual({ kind: 'up-to-date', label: 'v0.1.0 (stable-2026.11.01)' });
    expect(co.count('fetch')).toBe(0);
    expect(co.count('status')).toBe(0);
    expect(co.count('lsRemote')).toBe(1);
  });

  it('falls back to the short sha for the label when HEAD cannot be described', async () => {
    const { co, mgr } = setup();
    co.headSha = SHA_B;
    co.lsRemoteResult = { 'refs/heads/stable': SHA_B };
    co.resolveTarget = () => Promise.reject(new GitError('BAD_REF', 'nope'));
    expect(await mgr.check({ interactive: true })).toEqual({ kind: 'up-to-date', label: 'bbbbbbb' });
  });

  it('asks about the branch of the selected channel', async () => {
    const { co, mgr } = setup({ channel: 'candidate' });
    co.lsRemoteResult = { 'refs/heads/candidate': SHA_A };
    await mgr.check({ interactive: false });
    expect(co.lsRemoteRefs).toEqual([['refs/heads/candidate']]);
  });

  it('uses the ref override', async () => {
    const { co, mgr } = setup({ refOverride: 'refs/heads/special' });
    co.lsRemoteResult = { 'refs/heads/special': SHA_A };
    co.headSha = SHA_A;
    expect((await mgr.check({ interactive: false })).kind).toBe('up-to-date');
    expect(co.lsRemoteRefs).toEqual([['refs/heads/special']]);
  });

  it('NETWORK from ls-remote means offline and never fetches', async () => {
    const { co, mgr } = setup();
    co.lsRemoteResult = new GitError('NETWORK', 'down');
    expect(await mgr.check({ interactive: true })).toEqual({ kind: 'offline' });
    expect(co.count('fetch')).toBe(0);
  });

  it('a non-network ls-remote failure falls through to fetch', async () => {
    const { co, mgr } = setup();
    co.lsRemoteResult = new GitError('GIT_FAILED', 'weird');
    await mgr.check({ interactive: false });
    expect(co.count('fetch')).toBe(1);
  });

  it('a remote that lacks the ref falls through to fetch', async () => {
    const { co, mgr } = setup();
    co.lsRemoteResult = {};
    await mgr.check({ interactive: false });
    expect(co.count('fetch')).toBe(1);
  });
});

describe('check: behind', () => {
  it('fetches and builds the full disclosure', async () => {
    const { co, mgr } = setup();
    co.headSha = SHA_A;
    co.targetSha = SHA_B;
    co.targetExtra = { upstreamTag: 'v0.2.0', stableTag: 'stable-2026.11.08' };
    co.resolveTags[SHA_A] = { upstreamTag: 'v0.1.0', stableTag: null };
    co.behind = 2;
    co.log = { commits: [commit(2), commit(1)], truncated: false };
    co.stat = '4 files changed, 10 insertions(+)';
    co.annotation = {
      tag: 'stable-2026.11.08',
      message: '',
      fields: { gateRun: 'https://x/run/2', canaryDays: '3', minShell: '0.1.0', severity: 'normal' },
    };
    const r = await mgr.check({ interactive: false });
    expect(co.count('fetch')).toBe(1);
    expect(r.kind).toBe('available');
    if (r.kind !== 'available') return;
    expect(r.target.commit).toBe(SHA_B);
    const d = r.disclosure;
    expect(d.fromLabel).toBe('v0.1.0');
    expect(d.toLabel).toBe('v0.2.0 (stable-2026.11.08)');
    expect(d.commitCount).toBe(2);
    expect(d.commits).toHaveLength(2);
    expect(d.diffStat).toBe('4 files changed, 10 insertions(+)');
    expect(d.gate).toEqual({ gateRun: 'https://x/run/2', canaryDays: '3', testedOn: null });
    expect(d.compareUrl).toBe(`https://github.com/o/r/compare/${SHA_A}...${SHA_B}`);
    expect(d.untested).toBe(false);
    expect(d.needsReset).toBe(false);
    expect(d.dirty).toEqual({ modified: [], untracked: [] });
  });

  it('only reads the stable tag annotation when the target has a stable tag', async () => {
    const { co, mgr } = setup();
    await mgr.check({ interactive: false });
    expect(co.count('tagAnnotation')).toBe(0);
  });

  it('passes the truncated flag through', async () => {
    const { co, mgr } = setup();
    co.behind = 450;
    co.log = { commits: Array.from({ length: 200 }, (_, i) => commit(i + 1)), truncated: true };
    const r = await mgr.check({ interactive: false });
    if (r.kind !== 'available') throw new Error('expected available');
    expect(r.disclosure.truncated).toBe(true);
    expect(r.disclosure.commits).toHaveLength(200);
    expect(r.disclosure.commitCount).toBe(450);
  });

  it('reports lockfileChanged', async () => {
    const { co, mgr } = setup();
    co.lockChanged = true;
    const r = await mgr.check({ interactive: false });
    if (r.kind !== 'available') throw new Error('expected available');
    expect(r.disclosure.lockfileChanged).toBe(true);
  });

  it('reports a dirty tree', async () => {
    const { co, mgr } = setup();
    co.dirty = { dirty: true, modified: ['server/x.js'], untracked: ['notes.txt'], raw: '' };
    const r = await mgr.check({ interactive: false });
    if (r.kind !== 'available') throw new Error('expected available');
    expect(r.disclosure.dirty).toEqual({ modified: ['server/x.js'], untracked: ['notes.txt'] });
  });

  it('flags needsReset for a backwards move even with nothing to pull', async () => {
    const { co, mgr } = setup();
    co.headSha = SHA_C;
    co.targetSha = SHA_B;
    co.behind = 0;
    co.isAncestor = false;
    co.log = { commits: [], truncated: false };
    const r = await mgr.check({ interactive: true });
    if (r.kind !== 'available') throw new Error('expected available');
    expect(r.disclosure.needsReset).toBe(true);
    expect(r.disclosure.commitCount).toBe(0);
  });

  it('gates on minShell: blocked-by-shell carries the disclosure', async () => {
    const { co, mgr } = setup({ appVersion: '0.1.0' });
    co.targetExtra = { stableTag: 'stable-2026.11.08' };
    co.annotation = { tag: 'stable-2026.11.08', message: '', fields: { minShell: '0.2.0' } };
    const r = await mgr.check({ interactive: false });
    expect(r.kind).toBe('blocked-by-shell');
    if (r.kind !== 'blocked-by-shell') return;
    expect(r.disclosure.blockedByShell).toBe(true);
    expect(r.disclosure.minShell).toBe('0.2.0');
  });

  it('does not gate when the app is new enough', async () => {
    const { co, mgr } = setup({ appVersion: '0.3.0' });
    co.targetExtra = { stableTag: 'stable-x' };
    co.annotation = { tag: 'stable-x', message: '', fields: { minShell: '0.2.0' } };
    expect((await mgr.check({ interactive: false })).kind).toBe('available');
  });

  it('marks non-stable channels untested', async () => {
    const { mgr } = setup({ channel: 'candidate' });
    const r = await mgr.check({ interactive: false });
    if (r.kind !== 'available') throw new Error('expected available');
    expect(r.disclosure.untested).toBe(true);
  });

  it('non-GitHub remotes get no compare URL', async () => {
    const { mgr } = setup({ remote: 'file:///tmp/mirror.git' });
    const r = await mgr.check({ interactive: false });
    if (r.kind !== 'available') throw new Error('expected available');
    expect(r.disclosure.compareUrl).toBeNull();
  });

  it('is up to date when the fetched target equals HEAD', async () => {
    const { co, mgr } = setup();
    co.headSha = SHA_B;
    co.targetSha = SHA_B;
    co.lsRemoteResult = {};
    const r = await mgr.check({ interactive: false });
    expect(r.kind).toBe('up-to-date');
    expect(co.count('commitLog')).toBe(0);
  });
});

describe('check: failures', () => {
  it('NETWORK from fetch means offline', async () => {
    const { co, mgr } = setup();
    co.fetchError = new GitError('NETWORK', 'down');
    expect(await mgr.check({ interactive: true })).toEqual({ kind: 'offline' });
  });

  it('TAG_DRIFT from fetch is reported with its detail', async () => {
    const { co, mgr } = setup();
    co.fetchError = new GitError('TAG_DRIFT', 'drift', 'would clobber existing tag stable-1');
    expect(await mgr.check({ interactive: false })).toEqual({
      kind: 'tag-drift',
      detail: 'would clobber existing tag stable-1',
    });
    expect(co.count('resolveTarget')).toBe(0);
  });

  it('other fetch errors propagate', async () => {
    const { co, mgr } = setup();
    co.fetchError = new GitError('GIT_FAILED', 'boom');
    await expect(mgr.check({ interactive: false })).rejects.toThrow('boom');
  });
});
