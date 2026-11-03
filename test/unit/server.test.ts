import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, type LogSink } from '../../src/main/logger.js';
import { createRingBuffer } from '../../src/main/ringBuffer.js';
import {
  PLACEHOLDER_OPENAI_API_KEY,
  ServerError,
  buildServerEnv,
  createLineSplitter,
  createServerManager,
  parseReadyLine,
  type ServerEvent,
} from '../../src/main/server.js';

const baseEnvOpts = {
  port: 4200,
  nodeBinDir: '/res/node/bin',
  home: '/Users/me',
  tmpdir: '/tmp/x',
  shellVersion: '1.2.3',
};

describe('buildServerEnv', () => {
  it('builds the fixed base environment', () => {
    expect(buildServerEnv(baseEnvOpts)).toEqual({
      PATH: '/res/node/bin:/usr/bin:/bin',
      HOME: '/Users/me',
      TMPDIR: '/tmp/x',
      LANG: 'en_US.UTF-8',
      HOST: '127.0.0.1',
      PORT: '4200',
      NODE_ENV: 'development',
      OPENTAC: '1',
      OPENTAC_VERSION: '1.2.3',
      BROWSER: 'none',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    });
  });

  it('adds the gateway URL and the placeholder key only when asked', () => {
    const env = buildServerEnv({
      ...baseEnvOpts,
      aiGatewayUrl: 'http://127.0.0.1:9',
      placeholderOpenAiKey: true,
    });
    expect(env['OPENTAC_AI_GATEWAY_URL']).toBe('http://127.0.0.1:9');
    expect(env['OPENAI_API_KEY']).toBe(PLACEHOLDER_OPENAI_API_KEY);
    const plain = buildServerEnv({ ...baseEnvOpts, placeholderOpenAiKey: false });
    expect('OPENAI_API_KEY' in plain).toBe(false);
    expect('OPENTAC_AI_GATEWAY_URL' in plain).toBe(false);
  });

  it('does not leak ELECTRON_* or npm_config_* from a polluted extra', () => {
    const env = buildServerEnv({
      ...baseEnvOpts,
      extra: {
        ELECTRON_RUN_AS_NODE: '1',
        electron_enable_logging: '1',
        npm_config_prefix: '/x',
        NPM_CONFIG_REGISTRY: 'http://evil',
        FAKE_MODE: 'ok',
      },
    });
    expect(env['ELECTRON_RUN_AS_NODE']).toBeUndefined();
    expect(Object.keys(env).filter((k) => /^(electron_|npm_config_)/i.test(k))).toEqual([]);
    expect(env['FAKE_MODE']).toBe('ok');
  });

  it('never lets extra override the keys it owns (HOST, PORT, PATH)', () => {
    const env = buildServerEnv({
      ...baseEnvOpts,
      extra: { HOST: '0.0.0.0', PORT: '1', PATH: '/evil', OPENTAC_FAIL_START_ONCE: '1' },
    });
    expect(env['HOST']).toBe('127.0.0.1');
    expect(env['PORT']).toBe('4200');
    expect(env['PATH']).toBe('/res/node/bin:/usr/bin:/bin');
    expect(env['OPENTAC_FAIL_START_ONCE']).toBe('1');
  });

  it('overrides a real OPENAI_API_KEY from extra with the placeholder when asked', () => {
    const env = buildServerEnv({
      ...baseEnvOpts,
      placeholderOpenAiKey: true,
      extra: { OPENAI_API_KEY: 'real' },
    });
    expect(env['OPENAI_API_KEY']).toBe(PLACEHOLDER_OPENAI_API_KEY);
    expect(Object.values(env)).not.toContain('real');
  });

  it('passes a real OPENAI_API_KEY from extra through when the placeholder is off', () => {
    const env = buildServerEnv({
      ...baseEnvOpts,
      placeholderOpenAiKey: false,
      extra: { OPENAI_API_KEY: 'real' },
    });
    expect(env['OPENAI_API_KEY']).toBe('real');
  });

  it('does not copy the parent environment', () => {
    process.env['OPENTAC_UNIT_SENTINEL'] = 'leak';
    try {
      expect(buildServerEnv(baseEnvOpts)['OPENTAC_UNIT_SENTINEL']).toBeUndefined();
    } finally {
      delete process.env['OPENTAC_UNIT_SENTINEL'];
    }
  });
});

describe('parseReadyLine', () => {
  it('parses the launcher ready line', () => {
    expect(parseReadyLine('[OpenTac] Ready at http://127.0.0.1:4173/')).toEqual({
      url: 'http://127.0.0.1:4173/',
      port: 4173,
    });
  });

  it('returns null for Vite\'s Local line', () => {
    expect(parseReadyLine('  ➜  Local:   http://127.0.0.1:4173/')).toBeNull();
    expect(parseReadyLine('Local: http://127.0.0.1:4173/')).toBeNull();
  });

  it('returns null for other hosts, bad ports and other text', () => {
    expect(parseReadyLine('[OpenTac] Ready at http://0.0.0.0:4173/')).toBeNull();
    expect(parseReadyLine('[OpenTac] Ready at http://127.0.0.1:99999/')).toBeNull();
    expect(parseReadyLine('[OpenTac] Ready at http://127.0.0.1:0/')).toBeNull();
    expect(parseReadyLine('[OpenTac] Shutting down (SIGTERM).')).toBeNull();
    expect(parseReadyLine('')).toBeNull();
  });
});

describe('createLineSplitter', () => {
  it('joins a line split across chunks', () => {
    const lines: string[] = [];
    const s = createLineSplitter((l) => lines.push(l));
    s.write('hel');
    s.write('lo\nwor');
    expect(lines).toEqual(['hello']);
    s.write('ld\n');
    expect(lines).toEqual(['hello', 'world']);
  });

  it('handles several lines per chunk, CRLF and blank lines', () => {
    const lines: string[] = [];
    const s = createLineSplitter((l) => lines.push(l));
    s.write('a\r\n\nb\n');
    expect(lines).toEqual(['a', '', 'b']);
  });

  it('flush emits the trailing partial line once', () => {
    const lines: string[] = [];
    const s = createLineSplitter((l) => lines.push(l));
    s.write('tail');
    s.flush();
    s.flush();
    expect(lines).toEqual(['tail']);
  });

  it('keeps multi-byte characters intact across buffer boundaries', () => {
    const lines: string[] = [];
    const s = createLineSplitter((l) => lines.push(l));
    const bytes = Buffer.from('➜ Local\n', 'utf8');
    s.write(bytes.subarray(0, 1));
    s.write(bytes.subarray(1, 2));
    s.write(bytes.subarray(2));
    expect(lines).toEqual(['➜ Local']);
  });

  it('splits an over-long line instead of buffering without bound', () => {
    const lines: string[] = [];
    const s = createLineSplitter((l) => lines.push(l));
    s.write('x'.repeat(70 * 1024));
    expect(lines).toHaveLength(1);
    s.flush();
    expect(lines.join('').length).toBe(70 * 1024);
  });
});

// ---- manager with a fake child -------------------------------------------------------------

interface FakeChild extends EventEmitter {
  pid: number;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: (sig?: NodeJS.Signals) => boolean;
}

function fakeChild(pid = 4242): FakeChild {
  const c = new EventEmitter() as FakeChild;
  c.pid = pid;
  c.stdin = new PassThrough();
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.kill = () => true;
  return c;
}

function exitChild(c: FakeChild, code: number | null, signal: NodeJS.Signals | null = null): void {
  c.emit('exit', code, signal);
  c.emit('close', code, signal);
}

function setup(
  child: FakeChild,
  extra: {
    fetchImpl?: typeof fetch;
    killImpl?: (pid: number, sig: NodeJS.Signals) => void;
    treeKillImpl?: (pid: number, sig: string, cb: (e?: Error) => void) => void;
  } = {},
) {
  const logged: string[] = [];
  const sink: LogSink = {
    info: (m) => logged.push(m),
    warn: (m) => logged.push(m),
    error: (m) => logged.push(m),
    debug: (m) => logged.push(m),
  };
  const ring = createRingBuffer(100);
  const spawnImpl = vi.fn(() => child as unknown as ChildProcess) as unknown as typeof spawn;
  const mgr = createServerManager({
    nodeBin: '/res/node/bin/node',
    launcherScript: '/res/launcher/opentac-start.mjs',
    checkoutDir: '/data/checkout',
    log: createLogger(sink),
    ring,
    spawnImpl,
    fetchImpl: extra.fetchImpl ?? (async () => new Response('ok', { status: 200 })),
    // Never fall back to the real process.kill: the fake pids could name real process groups.
    killImpl: extra.killImpl ?? (() => undefined),
    ...(extra.treeKillImpl ? { treeKillImpl: extra.treeKillImpl } : {}),
  });
  const events: ServerEvent[] = [];
  mgr.onEvent((e) => events.push(e));
  return { mgr, ring, spawnImpl, logged, events };
}

const startOpts = { port: 4200, firstRun: false, shellVersion: '1.0.0' };
const READY = '[OpenTac] Ready at http://127.0.0.1:4200/\n';

async function expectServerError(p: Promise<unknown>, code: string): Promise<ServerError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ServerError);
  expect((err as ServerError).code).toBe(code);
  return err as ServerError;
}

describe('createServerManager (fake child)', () => {
  const pending: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of pending.splice(0)) await fn();
  });

  it('spawns with a stdin pipe, detached, cwd = checkout and a clean env', async () => {
    const child = fakeChild();
    const { mgr, spawnImpl } = setup(child);
    const p = mgr.start(startOpts);
    child.stdout.write(READY);
    await p;
    const call = vi.mocked(spawnImpl).mock.calls[0] as unknown as [
      string,
      string[],
      { cwd: string; stdio: string[]; detached: boolean; env: Record<string, string> },
    ];
    expect(call[0]).toBe('/res/node/bin/node');
    expect(call[1]).toEqual(['/res/launcher/opentac-start.mjs']);
    expect(call[2].cwd).toBe('/data/checkout');
    expect(call[2].stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(call[2].detached).toBe(true);
    expect(call[2].env['PORT']).toBe('4200');
    expect(call[2].env['ELECTRON_RUN_AS_NODE']).toBeUndefined();
    expect(child.stdin.writableEnded).toBe(false);
    exitChild(child, 0);
  });

  it('is not ready on the Vite Local line alone', async () => {
    const child = fakeChild();
    const { mgr } = setup(child, {
      killImpl: (_pid, sig) => {
        if (sig === 'SIGTERM') setImmediate(() => exitChild(child, null, 'SIGTERM'));
      },
    });
    const p = mgr.start({ ...startOpts, readinessTimeoutMs: 300 });
    child.stdout.write('  \u279c  Local:   http://127.0.0.1:4200/\n');
    await expectServerError(p, 'START_TIMEOUT');
  });

  it('retries the HTTP check until it answers 200', async () => {
    const child = fakeChild();
    const statuses = [503, 200];
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) throw new Error('ECONNREFUSED');
      return new Response('x', { status: statuses.shift() ?? 200 });
    }) as typeof fetch;
    const { mgr, events } = setup(child, { fetchImpl });
    const p = mgr.start(startOpts);
    child.stdout.write(READY);
    const handle = await p;
    expect(calls).toBe(3);
    expect(handle).toEqual({ port: 4200, url: 'http://127.0.0.1:4200/', pid: 4242 });
    expect(mgr.isRunning()).toBe(true);
    expect(mgr.handle()).toEqual(handle);
    expect(events.some((e) => e.type === 'ready')).toBe(true);
    exitChild(child, 0);
  });

  it('splits output into ring lines with stream prefixes, redacted, across chunks', async () => {
    const child = fakeChild();
    const { mgr, ring, events } = setup(child);
    const p = mgr.start(startOpts);
    child.stdout.write('hel');
    child.stdout.write('lo\nOPENAI_API_KEY=sk-live1234567890abcdef\n');
    child.stderr.write('warn: x\n');
    child.stdout.write(READY);
    await p;
    expect(ring.lines()).toContain('[stdout] hello');
    expect(ring.lines()).toContain('[stdout] OPENAI_API_KEY=[REDACTED]');
    expect(ring.lines()).toContain('[stderr] warn: x');
    expect(mgr.logTail(2)).toHaveLength(2);
    expect(events.filter((e) => e.type === 'line')).toContainEqual({
      type: 'line',
      stream: 'stderr',
      line: 'warn: x',
    });
    exitChild(child, 0);
  });

  it('maps exit code 99 to EADDRINUSE', async () => {
    const child = fakeChild();
    const { mgr } = setup(child);
    const p = mgr.start(startOpts);
    child.stderr.write('[OpenTac] EADDRINUSE: port 4200 is in use.\n');
    exitChild(child, 99);
    const err = await expectServerError(p, 'EADDRINUSE');
    expect(err.exitCode).toBe(99);
  });

  it('maps EADDRINUSE on stderr with another exit code to EADDRINUSE', async () => {
    const child = fakeChild();
    const { mgr } = setup(child);
    const p = mgr.start(startOpts);
    child.stderr.write('Error: listen EADDRINUSE: address already in use\n');
    exitChild(child, 1);
    await expectServerError(p, 'EADDRINUSE');
  });

  it('maps exit code 98 to VITE_MISSING', async () => {
    const child = fakeChild();
    const { mgr } = setup(child);
    const p = mgr.start(startOpts);
    exitChild(child, 98);
    await expectServerError(p, 'VITE_MISSING');
  });

  it('maps other early exits to START_FAILED with the last 20 lines as detail', async () => {
    const child = fakeChild();
    const { mgr } = setup(child);
    const p = mgr.start(startOpts);
    for (let i = 0; i < 30; i++) child.stdout.write(`line ${i}\n`);
    await new Promise((r) => setImmediate(r));
    exitChild(child, 1);
    const err = await expectServerError(p, 'START_FAILED');
    const lines = (err.detail ?? '').split('\n');
    expect(lines).toHaveLength(20);
    expect(lines[19]).toBe('[stdout] line 29');
    expect(err.exitCode).toBe(1);
    expect(err.message).not.toMatch(/\n\s+at /);
  });

  it('rejects ALREADY_RUNNING for a second start and ABORTED for a pre-aborted signal', async () => {
    const child = fakeChild();
    const { mgr } = setup(child);
    const p = mgr.start(startOpts);
    await expectServerError(mgr.start(startOpts), 'ALREADY_RUNNING');
    child.stdout.write(READY);
    await p;
    await expectServerError(mgr.start(startOpts), 'ALREADY_RUNNING');
    exitChild(child, 0);
    const ac = new AbortController();
    ac.abort();
    await expectServerError(mgr.start({ ...startOpts, signal: ac.signal }), 'ABORTED');
  });

  it('aborts a start in progress via the signal and kills the group', async () => {
    const child = fakeChild();
    const sent: Array<[number, string]> = [];
    const killImpl = (pid: number, sig: NodeJS.Signals): void => {
      sent.push([pid, sig]);
      if (sig === 'SIGTERM') exitChild(child, 0);
    };
    const { mgr, events } = setup(child, { killImpl });
    const ac = new AbortController();
    const p = mgr.start({ ...startOpts, signal: ac.signal });
    ac.abort();
    await expectServerError(p, 'ABORTED');
    expect(sent[0]).toEqual([-4242, 'SIGTERM']);
    expect(events.some((e) => e.type === 'exit')).toBe(false);
    expect(mgr.isRunning()).toBe(false);
  });

  it('stop() during start rejects the start with ABORTED', async () => {
    const child = fakeChild();
    const { mgr } = setup(child, {
      killImpl: (_pid, sig) => {
        if (sig === 'SIGTERM') exitChild(child, 0);
      },
    });
    const p = mgr.start(startOpts);
    const stopped = mgr.stop();
    await expectServerError(p, 'ABORTED');
    await stopped;
  });

  it('stop() sends SIGTERM to the group, resolves on exit, emits expected exit, is idempotent', async () => {
    const child = fakeChild();
    const sent: Array<[number, string]> = [];
    const killImpl = (pid: number, sig: NodeJS.Signals): void => {
      sent.push([pid, sig]);
      if (sig === 'SIGTERM') setImmediate(() => exitChild(child, 0));
    };
    const { mgr, events } = setup(child, { killImpl });
    const p = mgr.start(startOpts);
    child.stdout.write(READY);
    await p;
    await Promise.all([mgr.stop(), mgr.stop()]);
    await mgr.stop();
    expect(sent[0]).toEqual([-4242, 'SIGTERM']);
    expect(mgr.isRunning()).toBe(false);
    expect(mgr.handle()).toBeNull();
    expect(events.filter((e) => e.type === 'exit')).toEqual([
      { type: 'exit', code: 0, signal: null, expected: true },
    ]);
    expect(child.stdin.destroyed).toBe(true);
  });

  it('escalates to SIGKILL on the group when SIGTERM is ignored', async () => {
    const child = fakeChild();
    const sent: string[] = [];
    const killImpl = (_pid: number, sig: NodeJS.Signals): void => {
      sent.push(sig);
      if (sig === 'SIGKILL') setImmediate(() => exitChild(child, null, 'SIGKILL'));
    };
    const { mgr } = setup(child, { killImpl });
    const p = mgr.start(startOpts);
    child.stdout.write(READY);
    await p;
    await mgr.stop({ timeoutMs: 50 });
    expect(sent.slice(0, 2)).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('falls back to tree-kill when the group signal does not end the child', async () => {
    const child = fakeChild();
    const treeKillImpl = vi.fn((_pid: number, _sig: string, cb: (e?: Error) => void) => {
      exitChild(child, null, 'SIGKILL');
      cb();
    });
    const { mgr } = setup(child, { killImpl: () => undefined, treeKillImpl });
    const p = mgr.start(startOpts);
    child.stdout.write(READY);
    await p;
    // Group signals are no-ops here, so stop() has to wait out both timeouts (50 ms + 2 s).
    await mgr.stop({ timeoutMs: 50 });
    expect(treeKillImpl).toHaveBeenCalledWith(4242, 'SIGKILL', expect.any(Function));
  }, 15_000);

  it('emits exit expected:false when the child dies by itself after readiness', async () => {
    const child = fakeChild();
    const { mgr, events } = setup(child);
    const p = mgr.start(startOpts);
    child.stdout.write(READY);
    await p;
    exitChild(child, 3);
    expect(events.at(-1)).toEqual({ type: 'exit', code: 3, signal: null, expected: false });
    expect(mgr.isRunning()).toBe(false);
    await mgr.stop();
  });

  it('finalises on exit alone if close never arrives', async () => {
    const child = fakeChild();
    const { mgr, events } = setup(child);
    const p = mgr.start(startOpts);
    child.stdout.write(READY);
    await p;
    child.emit('exit', 5, null);
    await new Promise((r) => setTimeout(r, 400));
    expect(events.at(-1)).toMatchObject({ type: 'exit', code: 5, expected: false });
  });

  it('unsubscribes listeners and survives a throwing listener', async () => {
    const child = fakeChild();
    const { mgr } = setup(child);
    const seen: string[] = [];
    const off = mgr.onEvent((e) => seen.push(e.type));
    mgr.onEvent(() => {
      throw new Error('listener bug');
    });
    off();
    const p = mgr.start(startOpts);
    child.stdout.write(READY);
    await p;
    expect(seen).toEqual([]);
    exitChild(child, 0);
  });

  it('turns a spawn error into START_FAILED', async () => {
    const child = fakeChild();
    Object.defineProperty(child, 'pid', { value: undefined });
    const { mgr } = setup(child);
    const p = mgr.start(startOpts);
    child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    const err = await expectServerError(p, 'START_FAILED');
    expect(err.detail).toContain('ENOENT');
  });
});
