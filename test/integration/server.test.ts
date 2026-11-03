import { spawn as realSpawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, type LogSink } from '../../src/main/logger.js';
import { findFreePort, isPortFree } from '../../src/main/ports.js';
import { createRingBuffer } from '../../src/main/ringBuffer.js';
import {
  ServerError,
  createServerManager,
  type ServerEvent,
  type ServerManager,
} from '../../src/main/server.js';

const FAKE_LAUNCHER = fileURLToPath(new URL('../fixtures/fake-launcher.mjs', import.meta.url));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw err;
  }
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function codeOf(p: Promise<unknown>): Promise<ServerError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ServerError);
  return err as ServerError;
}

describe('server manager (fake launcher, real processes)', () => {
  let checkout = '';
  let mgr: ServerManager;
  let events: ServerEvent[];
  let spawned: ChildProcess[];
  let ring: ReturnType<typeof createRingBuffer>;
  let port = 0;
  let nextPort = 46000 + Math.floor(Math.random() * 2000);

  beforeEach(async () => {
    checkout = await realpath(await mkdtemp(join(tmpdir(), 'opentac-server-')));
    port = await findFreePort({ rangeStart: nextPort, rangeEnd: nextPort + 500 });
    nextPort = port + 1;
    const sink: LogSink = { info() {}, warn() {}, error() {}, debug() {} };
    ring = createRingBuffer(200);
    spawned = [];
    events = [];
    mgr = createServerManager({
      nodeBin: process.execPath,
      launcherScript: FAKE_LAUNCHER,
      checkoutDir: checkout,
      log: createLogger(sink),
      ring,
      spawnImpl: ((...args: Parameters<typeof realSpawn>) => {
        const child = realSpawn(...args);
        spawned.push(child);
        return child;
      }) as typeof realSpawn,
    });
    mgr.onEvent((e) => events.push(e));
  });

  afterEach(async () => {
    await mgr.stop({ timeoutMs: 2000 });
    for (const child of spawned) {
      if (child.pid !== undefined && isAlive(child.pid)) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
    await rm(checkout, { recursive: true, force: true });
  });

  const start = (mode: string, extra: Record<string, string> = {}, ms?: number) =>
    mgr.start({
      port,
      firstRun: false,
      shellVersion: '9.9.9',
      extraEnv: { FAKE_MODE: mode, ...extra },
      ...(ms !== undefined ? { readinessTimeoutMs: ms } : {}),
    });

  it('ok: returns a handle, serves HTTP 200, emits ready, runs in the checkout with a clean env', async () => {
    process.env['ELECTRON_RUN_AS_NODE'] = '1';
    process.env['OPENTAC_PARENT_SENTINEL'] = 'x';
    try {
      const handle = await start('ok');
      expect(handle.port).toBe(port);
      expect(handle.url).toBe(`http://127.0.0.1:${port}/`);
      expect(isAlive(handle.pid)).toBe(true);
      expect(mgr.isRunning()).toBe(true);
      expect(mgr.handle()).toEqual(handle);

      const res = await fetch(handle.url);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<canvas>');

      expect(events).toContainEqual({ type: 'ready', url: handle.url, port, pid: handle.pid });
      expect(events.some((e) => e.type === 'line' && e.line.includes('Local:'))).toBe(true);

      const tail = mgr.logTail();
      expect(tail).toContain(`[stdout] [fake] cwd ${checkout}`);
      const envLine = tail.find((l) => l.includes('[fake] env-keys'));
      expect(envLine).toBeDefined();
      expect(envLine).not.toMatch(/ELECTRON_RUN_AS_NODE|OPENTAC_PARENT_SENTINEL|npm_config/);
      expect(envLine).toMatch(/OPENTAC_VERSION/);
    } finally {
      delete process.env['ELECTRON_RUN_AS_NODE'];
      delete process.env['OPENTAC_PARENT_SENTINEL'];
    }
  });

  it('stop(): child exits with expected:true, no process left, port free, idempotent', async () => {
    const handle = await start('ok');
    await mgr.stop();
    expect(isAlive(handle.pid)).toBe(false);
    expect(() => process.kill(handle.pid, 0)).toThrow(/ESRCH/);
    expect(await isPortFree(port)).toBe(true);
    expect(mgr.isRunning()).toBe(false);
    expect(events.filter((e) => e.type === 'exit')).toEqual([
      { type: 'exit', code: 0, signal: null, expected: true },
    ]);
    await mgr.stop();
    expect(events.filter((e) => e.type === 'exit')).toHaveLength(1);
  });

  it('can start again after stop', async () => {
    const first = await start('ok');
    await mgr.stop();
    const second = await start('ok');
    expect(second.pid).not.toBe(first.pid);
    expect((await fetch(second.url)).status).toBe(200);
  });

  it('rejects a second start with ALREADY_RUNNING', async () => {
    await start('ok');
    expect((await codeOf(start('ok'))).code).toBe('ALREADY_RUNNING');
  });

  it('eaddrinuse (exit 99): throws EADDRINUSE and leaves no child', async () => {
    const err = await codeOf(start('eaddrinuse'));
    expect(err.code).toBe('EADDRINUSE');
    expect(err.exitCode).toBe(99);
    expect(err.detail).toContain('EADDRINUSE');
    const pid = spawned[0]?.pid;
    expect(pid !== undefined && isAlive(pid)).toBe(false);
  });

  it('EADDRINUSE on stderr with exit code 1 is still EADDRINUSE', async () => {
    expect((await codeOf(start('eaddrinuse-exit1'))).code).toBe('EADDRINUSE');
  });

  it('vite-missing (exit 98): throws VITE_MISSING', async () => {
    expect((await codeOf(start('vite-missing'))).code).toBe('VITE_MISSING');
  });

  it('fail: START_FAILED with output as detail', async () => {
    const err = await codeOf(start('fail'));
    expect(err.code).toBe('START_FAILED');
    expect(err.detail).toContain('boom');
    expect(err.detail).toContain('some stdout before failing');
  });

  it('crash-after-ready: emits exit expected:false and isRunning() turns false', async () => {
    const handle = await start('crash-after-ready');
    await waitFor(() => events.some((e) => e.type === 'exit'));
    expect(events.find((e) => e.type === 'exit')).toEqual({
      type: 'exit',
      code: 3,
      signal: null,
      expected: false,
    });
    expect(mgr.isRunning()).toBe(false);
    expect(mgr.handle()).toBeNull();
    expect(isAlive(handle.pid)).toBe(false);
    await mgr.stop();
  });

  it('slow: START_TIMEOUT and the child is killed', async () => {
    const err = await codeOf(start('slow', {}, 1500));
    expect(err.code).toBe('START_TIMEOUT');
    const pid = spawned[0]?.pid;
    expect(pid).toBeDefined();
    expect(isAlive(pid ?? 0)).toBe(false);
    expect(mgr.isRunning()).toBe(false);
  });

  it('aborting the signal during start yields ABORTED and kills the child', async () => {
    const ac = new AbortController();
    const p = mgr.start({
      port,
      firstRun: false,
      shellVersion: '1',
      extraEnv: { FAKE_MODE: 'slow' },
      signal: ac.signal,
    });
    await waitFor(() => spawned.length > 0 && ring.size() > 0);
    ac.abort();
    expect((await codeOf(p)).code).toBe('ABORTED');
    expect(isAlive(spawned[0]?.pid ?? 0)).toBe(false);
  });

  it('no-stdin-exit: start succeeds, which proves the launcher got a pipe on stdin', async () => {
    const handle = await start('no-stdin-exit');
    expect(handle.port).toBe(port);
    expect(isAlive(handle.pid)).toBe(true);
    expect(spawned[0]?.stdin?.writable).toBe(true);
  });

  it('watchdog: destroying the stdin pipe makes the launcher exit (unexpected exit event)', async () => {
    const handle = await start('ok');
    spawned[0]?.stdin?.destroy();
    await waitFor(() => events.some((e) => e.type === 'exit'));
    expect(events.find((e) => e.type === 'exit')).toMatchObject({ code: 0, expected: false });
    expect(isAlive(handle.pid)).toBe(false);
    expect(mgr.isRunning()).toBe(false);
  });

  it('stubborn: SIGKILL to the process group takes down an ignoring leader and its worker', async () => {
    const handle = await start('stubborn');
    const workerLine = mgr.logTail().find((l) => l.includes('[fake] worker pid'));
    const workerPid = Number.parseInt(workerLine?.split(' ').at(-1) ?? '', 10);
    expect(Number.isInteger(workerPid)).toBe(true);
    expect(isAlive(workerPid)).toBe(true);

    await mgr.stop({ timeoutMs: 500 });
    expect(isAlive(handle.pid)).toBe(false);
    await waitFor(() => !isAlive(workerPid));
    expect(events.find((e) => e.type === 'exit')).toMatchObject({
      signal: 'SIGKILL',
      expected: true,
    });
    expect(await isPortFree(port)).toBe(true);
  }, 20_000);
});
