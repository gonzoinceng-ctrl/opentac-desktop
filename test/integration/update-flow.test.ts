import { execFileSync } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCoreIntegration, isAlive, type CoreIntegration } from '../helpers/core-integration.js';

let ctx: CoreIntegration | null = null;
afterEach(async () => {
  await ctx?.cleanup();
  ctx = null;
});

async function start(env: NodeJS.ProcessEnv = {}): Promise<CoreIntegration> {
  ctx = await createCoreIntegration({ env });
  await ctx.controller.start();
  return ctx;
}

async function headOf(c: CoreIntegration): Promise<string> {
  return (await c.fixture.git.run(['rev-parse', 'HEAD'], c.paths.checkoutDir)).stdout.trim();
}

async function fetchStatus(url: string): Promise<number> {
  return (await fetch(url)).status;
}

describe('boot from an empty data directory', () => {
  it('clones, installs, starts and shows the main window', async () => {
    const c = await start();
    expect(c.phases).toEqual(['BOOT', 'CLONING', 'INSTALLING', 'STARTING', 'RUNNING']);
    expect(c.controller.phase()).toBe('RUNNING');
    const url = c.ui.mainUrl;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(c.controller.engineUrl()).toBe(url);
    expect(await fetchStatus(url as string)).toBe(200);
    expect(await headOf(c)).toBe(c.fixture.commits.c2);
    const s = c.controller.state();
    expect(s.installedCommit).toBe(c.fixture.commits.c2);
    expect(s.installedLockHash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.lastPort).toBe(Number(new URL(url as string).port));
    expect(s.rollbackCommit).toBeNull();
    // The state file on disk matches.
    const onDisk = JSON.parse(await readFile(c.paths.stateFile, 'utf8')) as { installedCommit: string };
    expect(onDisk.installedCommit).toBe(c.fixture.commits.c2);
    expect((await stat(join(c.paths.nodeModulesDir, '.fake-install'))).isFile()).toBe(true);
    expect(c.ui.hasMain()).toBe(true);
    expect(c.ui.calls).toContain('hideSetup');
  });

  it('shutdown leaves no child process', async () => {
    const c = await start();
    const pid = c.server.handle()?.pid;
    expect(pid).toBeDefined();
    expect(isAlive(pid as number)).toBe(true);
    await c.controller.shutdown();
    expect(isAlive(pid as number)).toBe(false);
    expect(c.server.isRunning()).toBe(false);
    for (const child of c.children) expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(c.controller.engineUrl()).toBeNull();
  });
});

describe('engine update', () => {
  it('behind: disclosure with the commit list, then confirm applies, installs and reloads', async () => {
    const c = await start();
    const { c2, c3, c4 } = c.fixture.commits;
    const firstPid = c.server.handle()?.pid as number;
    await c.fixture.moveStable(c4);

    await c.controller.action('checkForUpdates');
    expect(c.controller.phase()).toBe('DISCLOSING');
    const d = c.controller.disclosure();
    expect(d).not.toBeNull();
    expect(d?.fromCommit).toBe(c2);
    expect(d?.toCommit).toBe(c4);
    expect(d?.commitCount).toBe(2);
    expect(d?.commits.map((x) => x.subject)).toEqual(['c4: more', 'c3: bump dependency']);
    expect(d?.commits.map((x) => x.sha)).toEqual([c4, c3]);
    expect(d?.lockfileChanged).toBe(true);
    expect(d?.needsReset).toBe(false);
    expect(d?.dirty).toEqual({ modified: [], untracked: [] });
    expect(d?.compareUrl).toBeNull();
    expect(d?.fromLabel).toBe('v0.1.0 (stable-2026.11.01)');
    expect(d?.untested).toBe(false);
    expect(d?.diffStat).toMatch(/changed/);
    // Nothing moved yet.
    expect(await headOf(c)).toBe(c2);
    expect(c.controller.state().lastUpdateCheck).not.toBeNull();

    await c.controller.action('confirmUpdate');
    expect(c.controller.phase()).toBe('RUNNING');
    expect(c.phases.slice(-6)).toEqual(['CHECKING', 'DISCLOSING', 'UPDATING', 'INSTALLING', 'STARTING', 'RUNNING']);
    expect(await headOf(c)).toBe(c4);
    expect(c.ui.count('reloadMain')).toBe(1);
    const s = c.controller.state();
    expect(s.installedCommit).toBe(c4);
    expect(s.rollbackCommit).toBeNull();
    expect(s.skippedCommit).toBeNull();
    // The old server is gone, a new one answers on the same pinned port.
    expect(isAlive(firstPid)).toBe(false);
    expect(await fetchStatus(c.ui.mainUrl as string)).toBe(200);
    // The install saw the new lockfile.
    const installed = await readFile(join(c.paths.nodeModulesDir, '.fake-install'), 'utf8');
    expect(installed).toContain('2.0.0');
    // A second check finds nothing to do and does not fetch.
    await c.controller.action('checkForUpdates');
    expect(c.controller.phase()).toBe('RUNNING');
  });

  it('a start failure after the update (OPENTAC_FAIL_START_ONCE) rolls back to the previous commit', async () => {
    const c = await start({ OPENTAC_FAIL_START_ONCE: '1' });
    const { c2, c4 } = c.fixture.commits;
    expect(c.controller.phase()).toBe('RUNNING');
    await c.fixture.moveStable(c4);
    await c.controller.action('checkForUpdates');
    expect(c.controller.phase()).toBe('DISCLOSING');

    await c.controller.action('confirmUpdate');
    expect(c.controller.phase()).toBe('RUNNING');
    expect(c.phases.slice(-9)).toEqual([
      'CHECKING',
      'DISCLOSING',
      'UPDATING',
      'INSTALLING',
      'STARTING',
      'ROLLING_BACK',
      'INSTALLING',
      'STARTING',
      'RUNNING',
    ]);
    expect(await headOf(c)).toBe(c2);
    const s = c.controller.state();
    expect(s.installedCommit).toBe(c2);
    expect(s.rollbackCommit).toBeNull();
    expect(s.skippedCommit).toBe(c4);
    // The restored dependencies belong to the old lockfile.
    expect(await readFile(join(c.paths.nodeModulesDir, '.fake-install'), 'utf8')).toContain('1.0.0');
    expect(await fetchStatus(c.ui.mainUrl as string)).toBe(200);
    expect(c.controller.publicState().notices.join(' ')).toMatch(/went back to the previous version/);
    // A later automatic-style check stays quiet about the commit that failed, an interactive one does not.
    await c.controller.action('checkForUpdates');
    expect(c.controller.phase()).toBe('DISCLOSING');
  });

  it('a dirty tracked file is reported and resetAndUpdate preserves .env', async () => {
    const c = await start();
    const { c4 } = c.fixture.commits;
    const env = 'GOOGLE_MAPS_API_KEY=local-test-value\n';
    await writeFile(c.paths.envFile, env);
    await writeFile(join(c.paths.checkoutDir, 'src', 'app.txt'), 'edited by the user\n');
    await writeFile(join(c.paths.checkoutDir, 'scratch.txt'), 'untracked\n');
    await c.fixture.moveStable(c4);

    await c.controller.action('checkForUpdates');
    expect(c.controller.phase()).toBe('DISCLOSING');
    const d = c.controller.disclosure();
    expect(d?.dirty.modified).toEqual(['src/app.txt']);
    expect(d?.dirty.untracked).toEqual(['scratch.txt']);

    // A plain confirm is refused while the tree is dirty.
    await c.controller.action('confirmUpdate');
    expect(c.controller.phase()).toBe('DISCLOSING');

    await c.controller.action('resetAndUpdate');
    expect(c.controller.phase()).toBe('RUNNING');
    expect(await headOf(c)).toBe(c4);
    expect(await readFile(c.paths.envFile, 'utf8')).toBe(env);
    expect(await readFile(join(c.paths.checkoutDir, 'src', 'app.txt'), 'utf8')).toBe('app v2\n');
    await expect(stat(join(c.paths.checkoutDir, 'scratch.txt'))).rejects.toThrow();
    expect(c.controller.state().installedCommit).toBe(c4);
  });

  it('a channel switch to an older commit needs a reset and goes through resetAndUpdate', async () => {
    const c = await start();
    const { c2, c3 } = c.fixture.commits;
    await c.fixture.moveStable(c3);
    await c.controller.action('checkForUpdates');
    await c.controller.action('confirmUpdate');
    expect(await headOf(c)).toBe(c3);
    // Stable moves backwards (a revert on the mirror).
    await c.fixture.moveStable(c2);
    await c.controller.action('checkForUpdates');
    expect(c.controller.phase()).toBe('DISCLOSING');
    expect(c.controller.disclosure()?.needsReset).toBe(true);
    await c.controller.action('confirmUpdate');
    expect(c.controller.phase()).toBe('DISCLOSING');
    await c.controller.action('resetAndUpdate');
    expect(c.controller.phase()).toBe('RUNNING');
    expect(await headOf(c)).toBe(c2);
  });

  it('up to date is detected without changing anything', async () => {
    const c = await start();
    await c.controller.action('checkForUpdates');
    expect(c.controller.phase()).toBe('RUNNING');
    expect(c.ui.calls.some((x) => x.startsWith('notify:'))).toBe(true);
    expect(await headOf(c)).toBe(c.fixture.commits.c2);
  });

  it('a check that cannot talk to the remote leaves the engine running and says so', async () => {
    const c = await start();
    execFileSync('mv', [c.fixture.mirrorDir, `${c.fixture.mirrorDir}.gone`]);
    await c.controller.action('checkForUpdates');
    expect(c.controller.phase()).toBe('RUNNING');
    expect(c.controller.publicState().notices.join(' ')).toMatch(/check for engine updates/);
    expect(await fetchStatus(c.ui.mainUrl as string)).toBe(200);
  });
});
