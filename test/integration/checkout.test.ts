import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCheckoutManager, GitError } from '../../src/main/checkout.js';
import type { CheckoutManager } from '../../src/main/checkout.js';
import { createCheckoutFixture } from '../helpers/checkout-fixture.js';
import type { CheckoutFixture } from '../helpers/checkout-fixture.js';

let fx: CheckoutFixture;
let mgr: CheckoutManager;
const servers: Server[] = [];
const sockets = new Set<Socket>();

beforeEach(async () => {
  fx = await createCheckoutFixture();
  mgr = createCheckoutManager({ checkoutDir: fx.checkoutDir, git: fx.git, log: fx.log });
});

afterEach(async () => {
  for (const s of sockets) s.destroy();
  sockets.clear();
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
  await fx.cleanup();
});

/** Clones the fixture mirror and checks out `commit` (default: stable at c2). */
async function cloneAndCheckout(commit?: string): Promise<void> {
  await mgr.clone(fx.mirrorUrl, () => undefined);
  await mgr.checkoutDetached(commit ?? fx.commits.c2);
}

/** Local HTTP server that accepts connections and never answers. */
async function startHangingServer(): Promise<string> {
  const server = createServer(() => undefined);
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/hang.git`;
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    if (error instanceof GitError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
}

describe('clone', () => {
  it('reports progress, leaves a usable repo, and exists() flips to true', async () => {
    expect(await mgr.exists()).toBe(false);
    const seen: Array<{ phase: string; pct: number }> = [];
    await mgr.clone(fx.mirrorUrl, (p) => seen.push(p));
    expect(await mgr.exists()).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    for (const p of seen) {
      expect(p.pct).toBeGreaterThanOrEqual(0);
      expect(p.pct).toBeLessThanOrEqual(100);
    }
    expect(seen.some((p) => p.phase === 'receiving' || p.phase === 'resolving')).toBe(true);
    expect(await mgr.repoSizeBytes()).toBeGreaterThan(0);
    expect(await mgr.remoteUrl()).toBe(fx.mirrorUrl);
  });

  it('removes the half-clone and throws CLONE_FAILED for a missing repository', async () => {
    const err = await mgr
      .clone('file://' + join(fx.root, 'no-such.git'), () => undefined)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).code).toBe('CLONE_FAILED');
    expect(existsSync(fx.checkoutDir)).toBe(false);
    expect(await mgr.exists()).toBe(false);
  });

  it('throws NETWORK when the host refuses the connection', async () => {
    const code = await codeOf(mgr.clone('http://127.0.0.1:1/x.git', () => undefined));
    expect(code).toBe('NETWORK');
    expect(existsSync(fx.checkoutDir)).toBe(false);
  });

  it('refuses to clone into a non-empty folder and leaves it alone', async () => {
    await mkdir(fx.checkoutDir, { recursive: true });
    await writeFile(join(fx.checkoutDir, 'precious.txt'), 'keep');
    expect(await codeOf(mgr.clone(fx.mirrorUrl, () => undefined))).toBe('NOT_A_REPO');
    expect(await readFile(join(fx.checkoutDir, 'precious.txt'), 'utf8')).toBe('keep');
  });

  it('times out a stalled clone with GIT_TIMEOUT and cleans up', async () => {
    const url = await startHangingServer();
    const code = await codeOf(mgr.clone(url, () => undefined, { timeoutMs: 600 }));
    expect(code).toBe('GIT_TIMEOUT');
    expect(existsSync(fx.checkoutDir)).toBe(false);
  });

  it('rejects an option-looking URL', async () => {
    expect(await codeOf(mgr.clone('--upload-pack=touch /tmp/x', () => undefined))).toBe('BAD_REF');
  });
});

describe('resolveTarget', () => {
  beforeEach(async () => {
    await cloneAndCheckout();
  });

  it('resolves stable with its upstream and stable tags', async () => {
    const t = await mgr.resolveTarget('stable');
    expect(t).toEqual({
      channel: 'stable',
      ref: 'refs/remotes/origin/stable',
      commit: fx.commits.c2,
      upstreamTag: 'v0.1.0',
      stableTag: 'stable-2026.11.01',
    });
  });

  it('resolves candidate and upstream with no tags', async () => {
    const cand = await mgr.resolveTarget('candidate');
    expect(cand).toMatchObject({
      ref: 'refs/remotes/origin/candidate',
      commit: fx.commits.c3,
      upstreamTag: null,
      stableTag: null,
    });
    const up = await mgr.resolveTarget('upstream');
    expect(up).toMatchObject({
      ref: 'refs/remotes/origin/upstream-main',
      commit: fx.commits.c4,
      upstreamTag: null,
      stableTag: null,
    });
  });

  it('honours an override sha, tag or ref, keeping the requested channel', async () => {
    const bySha = await mgr.resolveTarget('stable', fx.commits.c1);
    expect(bySha).toMatchObject({ channel: 'stable', ref: fx.commits.c1, commit: fx.commits.c1 });
    expect(bySha.upstreamTag).toBeNull();
    const byTag = await mgr.resolveTarget('upstream', 'v0.1.0');
    expect(byTag).toMatchObject({ commit: fx.commits.c2, upstreamTag: 'v0.1.0' });
    const byBranch = await mgr.resolveTarget('stable', 'origin/candidate');
    expect(byBranch.commit).toBe(fx.commits.c3);
  });

  it('throws BAD_REF for unknown or option-like overrides', async () => {
    expect(await codeOf(mgr.resolveTarget('stable', 'does-not-exist'))).toBe('BAD_REF');
    expect(await codeOf(mgr.resolveTarget('stable', '--all'))).toBe('BAD_REF');
  });

  it('throws BAD_REF for a channel ref that was never fetched', async () => {
    await fx.git.run(['update-ref', '-d', 'refs/remotes/origin/candidate'], fx.checkoutDir);
    expect(await codeOf(mgr.resolveTarget('candidate'))).toBe('BAD_REF');
  });
});

describe('status and fetch', () => {
  it('tracks behind/ahead across a fetch', async () => {
    await cloneAndCheckout();
    expect(await mgr.head()).toBe(fx.commits.c2);

    const before = await mgr.resolveTarget('stable');
    const s0 = await mgr.status(before);
    expect(s0).toMatchObject({ head: fx.commits.c2, behind: 0, ahead: 0, isAncestor: true });
    expect(s0.dirty.dirty).toBe(false);

    // Mirror promotes stable to c3 and upstream gains c5; nothing changes locally until fetch.
    await fx.moveStable(fx.commits.c3);
    const c5 = await fx.addCommit('src/five.txt', 'five\n');
    expect((await mgr.status(await mgr.resolveTarget('stable'))).behind).toBe(0);

    await mgr.fetch();
    const stable = await mgr.resolveTarget('stable');
    expect(stable.commit).toBe(fx.commits.c3);
    const s1 = await mgr.status(stable);
    expect(s1).toMatchObject({ behind: 1, ahead: 0, isAncestor: true });
    const up = await mgr.resolveTarget('upstream');
    expect(up.commit).toBe(c5);
    expect(await mgr.status(up)).toMatchObject({ behind: 3, ahead: 0, isAncestor: true });

    await mgr.checkoutDetached(stable.commit);
    expect(await mgr.head()).toBe(fx.commits.c3);
    expect(await mgr.status(stable)).toMatchObject({ behind: 0, ahead: 0, isAncestor: true });
  });

  it('fetches from a one-run remote without rewriting origin, and counts commits uncapped (FD-12, NEW-2)', async () => {
    await cloneAndCheckout();
    const originBefore = await mgr.remoteUrl();
    await fx.moveStable(fx.commits.c3);
    // Point origin at a dead address: the one-run URL must be what is fetched from.
    await mgr.setRemoteUrl('/nonexistent/dead.git');
    await mgr.fetch({ remoteUrl: fx.mirrorUrl });
    expect(await mgr.remoteUrl()).toBe('/nonexistent/dead.git');
    expect((await mgr.resolveTarget('stable')).commit).toBe(fx.commits.c3);
    await mgr.setRemoteUrl(originBefore);
    expect(await mgr.countCommits(fx.commits.c1, fx.commits.c4)).toBe(3);
    expect(await mgr.countCommits(fx.commits.c3, fx.commits.c3)).toBe(0);
    expect(await codeOf(mgr.countCommits('-x', fx.commits.c3))).toBe('BAD_REF');
  });

  it('detects a non-ancestor target when stable is moved backwards', async () => {
    await fx.moveStable(fx.commits.c3);
    await cloneAndCheckout(fx.commits.c3);
    await fx.moveStable(fx.commits.c1);
    await mgr.fetch();
    const t = await mgr.resolveTarget('stable');
    expect(t.commit).toBe(fx.commits.c1);
    const s = await mgr.status(t);
    expect(s.isAncestor).toBe(false);
    expect(s.behind).toBe(0);
    expect(s.ahead).toBe(2);
  });

  it('throws TAG_DRIFT, once, when the mirror force-retags a tag', async () => {
    await cloneAndCheckout();
    await fx.forceRetag('v0.1.0', fx.commits.c3);
    const startsBefore = fx.logLines.filter(
      (l) => l.includes('git fetch') && l.includes('starting'),
    ).length;
    const err = await mgr.fetch().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).code).toBe('TAG_DRIFT');
    expect((err as GitError).detail).toMatch(/clobber/);
    const startsAfter = fx.logLines.filter(
      (l) => l.includes('git fetch') && l.includes('starting'),
    ).length;
    expect(startsAfter - startsBefore).toBe(1);
    // The local tag was not overwritten.
    const t = await mgr.resolveTarget('stable', 'v0.1.0');
    expect(t.commit).toBe(fx.commits.c2);
  });

  it('throws NETWORK when the remote is unreachable', async () => {
    await cloneAndCheckout();
    await mgr.setRemoteUrl('http://127.0.0.1:1/x.git');
    expect(await mgr.remoteUrl()).toBe('http://127.0.0.1:1/x.git');
    expect(await codeOf(mgr.fetch())).toBe('NETWORK');
  });

  it('times out a stalled fetch with GIT_TIMEOUT', async () => {
    await cloneAndCheckout();
    await mgr.setRemoteUrl(await startHangingServer());
    expect(await codeOf(mgr.fetch({ timeoutMs: 600 }))).toBe('GIT_TIMEOUT');
  });

  it('throws NOT_A_REPO when the checkout is missing', async () => {
    expect(await codeOf(mgr.head())).toBe('NOT_A_REPO');
  });
});

describe('dirty tracking and reset', () => {
  beforeEach(async () => {
    await cloneAndCheckout();
  });

  it('is clean right after checkout', async () => {
    const r = await mgr.dirtyReport();
    expect(r).toMatchObject({ dirty: false, modified: [], untracked: [] });
    expect(await readFile(join(fx.checkoutDir, 'src/app.txt'), 'utf8')).toBe('app v2\n');
    expect(existsSync(join(fx.checkoutDir, 'src/more.txt'))).toBe(false);
  });

  it('reports an edited tracked file, then an untracked one', async () => {
    await writeFile(join(fx.checkoutDir, 'src/app.txt'), 'edited\n');
    const r1 = await mgr.dirtyReport();
    expect(r1.dirty).toBe(true);
    expect(r1.modified).toEqual(['src/app.txt']);
    expect(r1.untracked).toEqual([]);

    await writeFile(join(fx.checkoutDir, 'stray file.txt'), 'x');
    const r2 = await mgr.dirtyReport();
    expect(r2.untracked).toEqual(['stray file.txt']);
    expect((await mgr.status(await mgr.resolveTarget('stable'))).dirty.dirty).toBe(true);
  });

  it('ignores .env and .gev-cache', async () => {
    await writeFile(join(fx.checkoutDir, '.env'), 'OPENAI_API_KEY=sk-test\n');
    await mkdir(join(fx.checkoutDir, '.gev-cache'), { recursive: true });
    await writeFile(join(fx.checkoutDir, '.gev-cache', 'x'), 'cache');
    expect((await mgr.dirtyReport()).dirty).toBe(false);
  });

  it('resetToTarget removes edits and untracked files but keeps ignored ones', async () => {
    await writeFile(join(fx.checkoutDir, 'src/app.txt'), 'edited\n');
    await mkdir(join(fx.checkoutDir, 'newdir'), { recursive: true });
    await writeFile(join(fx.checkoutDir, 'newdir', 'stray.txt'), 'x');
    await writeFile(join(fx.checkoutDir, '.env'), 'SECRET=1\n');
    await mkdir(join(fx.checkoutDir, '.gev-cache'), { recursive: true });
    await writeFile(join(fx.checkoutDir, '.gev-cache', 'x'), 'cache');

    await mgr.resetToTarget(fx.commits.c2);

    expect((await mgr.dirtyReport()).dirty).toBe(false);
    expect(await readFile(join(fx.checkoutDir, 'src/app.txt'), 'utf8')).toBe('app v2\n');
    expect(existsSync(join(fx.checkoutDir, 'newdir'))).toBe(false);
    expect(await readFile(join(fx.checkoutDir, '.env'), 'utf8')).toBe('SECRET=1\n');
    expect((await stat(join(fx.checkoutDir, '.gev-cache', 'x'))).isFile()).toBe(true);
    expect(await mgr.head()).toBe(fx.commits.c2);
  });

  it('resetToTarget can also move HEAD to another commit', async () => {
    await mgr.resetToTarget(fx.commits.c4);
    expect(await mgr.head()).toBe(fx.commits.c4);
    expect(existsSync(join(fx.checkoutDir, 'src/more.txt'))).toBe(true);
  });
});

describe('history helpers', () => {
  beforeEach(async () => {
    await cloneAndCheckout();
  });

  it('lists commits newest first with the right fields', async () => {
    const one = await mgr.commitLog(fx.commits.c2, fx.commits.c3);
    expect(one.truncated).toBe(false);
    expect(one.commits).toHaveLength(1);
    expect(one.commits[0]).toMatchObject({
      sha: fx.commits.c3,
      short: fx.commits.c3.slice(0, 7),
      subject: 'c3: bump dependency',
      author: 'Fixture Author',
    });
    expect(one.commits[0]?.date).toMatch(/^2026-11-01T/);

    const all = await mgr.commitLog(fx.commits.c1, fx.commits.c4);
    expect(all.commits.map((c) => c.sha)).toEqual([fx.commits.c4, fx.commits.c3, fx.commits.c2]);
  });

  it('caps the list and flags truncation', async () => {
    const capped = await mgr.commitLog(fx.commits.c1, fx.commits.c4, 2);
    expect(capped.commits.map((c) => c.sha)).toEqual([fx.commits.c4, fx.commits.c3]);
    expect(capped.truncated).toBe(true);
    const exact = await mgr.commitLog(fx.commits.c1, fx.commits.c4, 3);
    expect(exact.truncated).toBe(false);
  });

  it('returns an empty list when there is nothing between the commits', async () => {
    const none = await mgr.commitLog(fx.commits.c3, fx.commits.c3);
    expect(none).toEqual({ commits: [], truncated: false });
  });

  it('summarises the diff and notices lockfile changes', async () => {
    expect(await mgr.diffStat(fx.commits.c2, fx.commits.c3)).toMatch(/1 file changed/);
    expect(await mgr.diffStat(fx.commits.c3, fx.commits.c3)).toBe('');
    expect(await mgr.lockfileChanged(fx.commits.c2, fx.commits.c3)).toBe(true);
    expect(await mgr.lockfileChanged(fx.commits.c3, fx.commits.c4)).toBe(false);
    expect(await mgr.lockfileChanged(fx.commits.c1, fx.commits.c2)).toBe(false);
  });

  it('throws BAD_REF for unknown commits', async () => {
    expect(await codeOf(mgr.commitLog('deadbeef'.repeat(5), fx.commits.c3))).toBe('BAD_REF');
    expect(await codeOf(mgr.lockfileChanged('deadbeef'.repeat(5), fx.commits.c3))).toBe('BAD_REF');
  });
});

describe('tagAnnotation', () => {
  beforeEach(async () => {
    await cloneAndCheckout();
  });

  it('parses Key: value lines from a promotion tag', async () => {
    const a = await mgr.tagAnnotation('stable-2026.11.01');
    expect(a).not.toBeNull();
    expect(a?.tag).toBe('stable-2026.11.01');
    expect(a?.message).toContain('Stable 2026.11.01');
    expect(a?.fields).toEqual({
      upstreamTag: 'v0.1.0',
      gateRun: 'https://example/run/1',
      canaryDays: '3',
      minShell: '0.1.0',
      severity: 'normal',
    });
  });

  it('returns empty fields for a plain annotated tag, null for missing or lightweight tags', async () => {
    const plain = await mgr.tagAnnotation('v0.1.0');
    expect(plain).toMatchObject({ tag: 'v0.1.0', message: 'Release v0.1.0', fields: {} });
    expect(await mgr.tagAnnotation('nope-1')).toBeNull();
    await fx.git.run(['tag', 'light-1', fx.commits.c1], fx.checkoutDir);
    expect(await mgr.tagAnnotation('light-1')).toBeNull();
  });

  it('rejects unsafe tag names', async () => {
    expect(await codeOf(mgr.tagAnnotation('--list'))).toBe('BAD_REF');
    expect(await codeOf(mgr.tagAnnotation('a*'))).toBe('BAD_REF');
  });
});

describe('lsRemote', () => {
  it('maps requested refs to shas without a checkout', async () => {
    const refs = await mgr.lsRemote(fx.mirrorUrl, ['refs/heads/stable', 'refs/heads/candidate']);
    expect(refs).toEqual({
      'refs/heads/stable': fx.commits.c2,
      'refs/heads/candidate': fx.commits.c3,
    });
    expect(existsSync(fx.checkoutDir)).toBe(false);
  });

  it('shows both the tag object and the peeled commit for annotated tags', async () => {
    const refs = await mgr.lsRemote(fx.mirrorUrl, ['refs/tags/v0.1.0*']);
    expect(refs['refs/tags/v0.1.0^{}']).toBe(fx.commits.c2);
    expect(refs['refs/tags/v0.1.0']).toMatch(/^[0-9a-f]{40}$/);
    expect(refs['refs/tags/v0.1.0']).not.toBe(fx.commits.c2);
  });

  it('returns an empty map when nothing matches, and sees moved refs', async () => {
    expect(await mgr.lsRemote(fx.mirrorUrl, ['refs/heads/nope'])).toEqual({});
    await fx.moveStable(fx.commits.c4);
    const refs = await mgr.lsRemote(fx.mirrorUrl, ['refs/heads/stable']);
    expect(refs['refs/heads/stable']).toBe(fx.commits.c4);
  });

  it('classifies unreachable remotes as NETWORK and times out stalled ones', async () => {
    expect(await codeOf(mgr.lsRemote('http://127.0.0.1:1/x.git', ['HEAD']))).toBe('NETWORK');
    const url = await startHangingServer();
    expect(await codeOf(mgr.lsRemote(url, ['HEAD'], { timeoutMs: 500 }))).toBe('GIT_TIMEOUT');
  });

  it('fails with GIT_FAILED for a missing local repository', async () => {
    expect(await codeOf(mgr.lsRemote('file://' + join(fx.root, 'missing.git'), []))).toBe(
      'GIT_FAILED',
    );
  });
});

describe('remote url', () => {
  it('round-trips and never logs credentials', async () => {
    await cloneAndCheckout();
    await mgr.setRemoteUrl('https://user:topsecret99@example.invalid/org/repo.git');
    expect(await mgr.remoteUrl()).toBe('https://user:topsecret99@example.invalid/org/repo.git');
    expect(fx.logLines.join('\n')).not.toContain('topsecret99');
    expect(await codeOf(mgr.setRemoteUrl('--bad'))).toBe('BAD_REF');
  });

  it('exists() is false for a folder without a repository', async () => {
    await mkdir(fx.checkoutDir, { recursive: true });
    expect(await mgr.exists()).toBe(false);
    expect(await mgr.repoSizeBytes()).toBe(0);
  });
});

describe('confinement to the checkout repository', () => {
  /** Makes `fx.root/data` a work tree of its own, with a tracked file the checkout dir sits in. */
  async function makeParentRepo(): Promise<string> {
    const parent = join(fx.root, 'data');
    await mkdir(join(parent, 'checkout'), { recursive: true });
    await fx.git.run(['init', '--quiet'], parent);
    await writeFile(join(parent, 'tracked.txt'), 'orig\n');
    await fx.git.run(['add', '--', 'tracked.txt'], parent);
    await fx.git.run(['commit', '--quiet', '-m', 'parent'], parent, {
      env: {
        GIT_AUTHOR_DATE: '@1700000000 +0000',
        GIT_COMMITTER_DATE: '@1700000000 +0000',
      },
    });
    return parent;
  }

  it('reports NOT_A_REPO instead of discovering a parent repository', async () => {
    const parent = await makeParentRepo();
    expect(await codeOf(mgr.head())).toBe('NOT_A_REPO');
    expect(await codeOf(mgr.dirtyReport())).toBe('NOT_A_REPO');
    expect(await codeOf(mgr.fetch())).toBe('NOT_A_REPO');
    expect(await mgr.exists()).toBe(false);
    expect(parent).not.toBe('');
  });

  it('never resets or cleans the parent repository', async () => {
    const parent = await makeParentRepo();
    await writeFile(join(parent, 'tracked.txt'), 'USER EDIT\n');
    await writeFile(join(parent, 'stray.txt'), 'keep me\n');
    expect(await codeOf(mgr.resetToTarget('HEAD'))).toBe('NOT_A_REPO');
    expect(await codeOf(mgr.checkoutDetached('HEAD'))).toBe('NOT_A_REPO');
    expect(await readFile(join(parent, 'tracked.txt'), 'utf8')).toBe('USER EDIT\n');
    expect(existsSync(join(parent, 'stray.txt'))).toBe(true);
  });

  it('does not treat a broken .git directory as a repository via the parent', async () => {
    await makeParentRepo();
    await mkdir(join(fx.checkoutDir, '.git'), { recursive: true });
    expect(await mgr.exists()).toBe(false);
    expect(await codeOf(mgr.resetToTarget('HEAD'))).not.toBe('NO_ERROR');
  });

  it('still works for a real checkout nested inside another repository', async () => {
    await makeParentRepo();
    await cloneAndCheckout();
    expect(await mgr.exists()).toBe(true);
    expect(await mgr.head()).toBe(fx.commits.c2);
  });
});
