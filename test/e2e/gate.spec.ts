/**
 * The engine mirror's compatibility smoke (docs/brief/08-STAGED-UPDATES.md §3.3 item 3, as amended
 * by DECISIONS "the gate smoke drives the packaged app").
 *
 * The gate hands us a BUILT app and one engine commit:
 *   OPENTAC_E2E_APP        path of the .app bundle (released zip or a fresh `npm run pack`)
 *   OPENTAC_ENGINE_REMOTE  the mirror URL
 *   OPENTAC_ENGINE_REF     the 40-character engine SHA under test
 *   OPENTAC_DATA_DIR       an empty directory
 *
 * A packaged app has the Node-inspector fuse off, so Playwright cannot attach to it. This spec
 * therefore runs the bundle exactly as a user would (spawn the executable) and watches what a user's
 * install would show: the phase log, state.json, the engine over HTTP, and a clean quit. It proves that
 * this engine commit clones, installs and starts under the shell's bundled Node and launcher, honours
 * the key-setup contract, and that the shell stops it on quit. Update, rollback and UI flows are
 * covered by the fixture suite (app.spec.ts) and the integration tests.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const RUNNING_BUDGET_MS = 15 * 60_000; // clone + npm ci + first Vite start on a CI Mac
const QUIT_BUDGET_MS = 30_000;

const appBundle = process.env['OPENTAC_E2E_APP'] ?? '';
const engineRemote = process.env['OPENTAC_ENGINE_REMOTE'] ?? '';
const engineRef = process.env['OPENTAC_ENGINE_REF'] ?? '';
const dataDir = resolve(process.env['OPENTAC_DATA_DIR'] ?? '');
const mainLog = join(dataDir, 'logs', 'main.log');
const serverLog = join(dataDir, 'logs', 'server.log');
const stateFile = join(dataDir, 'state.json');
const outDir = join(process.cwd(), 'test-results', 'gate');

let child: ChildProcess;
let exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
let engineUrl = '';

const PHASE_LINE = /\[controller\] phase (\w+) -> (\w+): (.*)$/;

interface PhaseEvent {
  at: number;
  from: string;
  to: string;
  reason: string;
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

async function phases(): Promise<PhaseEvent[]> {
  const out: PhaseEvent[] = [];
  for (const line of (await readText(mainLog)).split('\n')) {
    const m = PHASE_LINE.exec(line);
    if (m === null) continue;
    const stamp = /^\[([^\]]+)\]/.exec(line);
    out.push({ at: stamp === null ? 0 : Date.parse(stamp[1]!.replace(' ', 'T')), from: m[1]!, to: m[2]!, reason: m[3]! });
  }
  return out;
}

async function readState(): Promise<Record<string, unknown> | null> {
  const text = await readText(stateFile);
  if (text === '') return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs: number, stepMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (child.exitCode !== null) throw new Error(`${what}: the app exited early (code ${child.exitCode})`);
    if (Date.now() > deadline) throw new Error(`${what}: not within ${Math.round(timeoutMs / 1000)} s`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

async function portOpen(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

async function fetchJson(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(new URL(path, engineUrl), {
    ...init,
    headers: { Origin: engineUrl.replace(/\/$/, ''), Accept: 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep the text */
  }
  return { status: res.status, body };
}

async function keepArtifacts(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  for (const [src, name] of [
    [mainLog, 'main.log'],
    [serverLog, 'server.log'],
    [stateFile, 'state.json'],
  ] as const) {
    if (existsSync(src)) await copyFile(src, join(outDir, name));
  }
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(appBundle, 'OPENTAC_E2E_APP must point at the .app bundle').not.toBe('');
  expect(engineRemote, 'OPENTAC_ENGINE_REMOTE must be the mirror URL').not.toBe('');
  expect(engineRef, 'OPENTAC_ENGINE_REF must be a full commit SHA').toMatch(/^[0-9a-f]{40}$/);
  expect(dataDir, 'OPENTAC_DATA_DIR is required').not.toBe(resolve(''));
  await mkdir(dataDir, { recursive: true });
  expect(await readdir(dataDir), 'OPENTAC_DATA_DIR must start empty').toEqual([]);

  const macos = join(appBundle, 'Contents', 'MacOS');
  const exes = await readdir(macos);
  expect(exes, `one executable in ${macos}`).toHaveLength(1);
  const exe = join(macos, exes[0]!);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  }
  env['OPENTAC_DATA_DIR'] = dataDir;
  env['NO_COLOR'] = '1';

  await mkdir(outDir, { recursive: true });
  const stdio = createWriteStream(join(outDir, 'app-stdio.log'));
  child = spawn(exe, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.pipe(stdio);
  child.stderr?.pipe(stdio);
  exited = new Promise((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  console.log(`launched ${exe} (pid ${child.pid}) with engine ${engineRef.slice(0, 7)} from ${engineRemote}`);
});

test.afterAll(async () => {
  await keepArtifacts();
  if (child !== undefined && child.exitCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
});

test('the engine commit clones, installs and starts under the shell within budget', async () => {
  test.setTimeout(RUNNING_BUDGET_MS + 60_000);
  const seen = await waitFor(
    'RUNNING',
    async () => {
      const list = await phases();
      const bad = list.find((p) => p.to === 'ERROR' || p.to === 'CRASHED');
      if (bad !== undefined) {
        await keepArtifacts();
        throw new Error(`the shell went to ${bad.to} (${bad.reason}); see test-results/gate/main.log`);
      }
      return list.some((p) => p.to === 'RUNNING') ? list : undefined;
    },
    RUNNING_BUDGET_MS,
    2000,
  );
  const order = seen.map((p) => p.to);
  // A first run from an empty directory must take the full path; nothing may be skipped.
  expect(order.slice(0, order.indexOf('RUNNING') + 1)).toEqual(['CLONING', 'INSTALLING', 'STARTING', 'RUNNING']);
  const started = seen[0]!.at;
  for (const p of seen) console.log(`phase ${p.from} -> ${p.to} at +${((p.at - started) / 1000).toFixed(1)} s: ${p.reason}`);

  const state = await waitFor('state.json with a port', async () => {
    const s = await readState();
    return s !== null && typeof s['lastPort'] === 'number' ? s : undefined;
  }, 30_000);
  expect(state['installedCommit']).toBe(engineRef);
  expect(state['installedNodeVersion']).toMatch(/^\d+\.\d+\.\d+$/);
  engineUrl = `http://127.0.0.1:${state['lastPort'] as number}/`;
  console.log(`engine at ${engineUrl}, node ${String(state['installedNodeVersion'])}`);
});

test('the engine serves its page and the key-setup contract holds', async () => {
  const page = await fetch(engineUrl, { signal: AbortSignal.timeout(15_000) });
  expect(page.status).toBe(200);
  expect(page.headers.get('content-type') ?? '').toContain('text/html');
  const html = await page.text();
  expect(html.length).toBeGreaterThan(200);
  expect(html.toLowerCase()).toContain('<html');

  // /api/setup/status with the local Origin: the list the Preferences key tab is built from.
  const status = await fetchJson('/api/setup/status');
  expect(status.status, JSON.stringify(status.body).slice(0, 300)).toBe(200);
  expect(typeof status.body).toBe('object');

  // The keyless feed the gate was given for this purpose (DECISIONS "Keyless smoke endpoint").
  const feed = await fetchJson('/api/celestrak/stations', { headers: { Accept: '*/*' } });
  expect([404, 405], `/api/celestrak/stations is gone (${feed.status})`).not.toContain(feed.status);
  console.log(`/api/celestrak/stations -> ${feed.status}`);
});

test('saving an engine key restarts the engine in place without the shell crashing', async () => {
  const before = (await phases()).length;
  const envVar = 'AISSTREAM_API_KEY';
  const set = await fetchJson('/api/setup/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [envVar]: 'gate-smoke-test-key-1234567890' }),
  });
  expect(set.status, JSON.stringify(set.body).slice(0, 300)).toBe(200);

  // Upstream restarts its server ~250 ms after a save; the child must not exit and the shell must not
  // move phase. Give it a moment, then both the engine and the shell must still be there.
  await new Promise((r) => setTimeout(r, 6000));
  const after = await fetchJson('/api/setup/status');
  expect(after.status).toBe(200);
  const later = await phases();
  expect(later.slice(before).filter((p) => p.to === 'CRASHED' || p.to === 'ERROR')).toEqual([]);

  const unset = await fetchJson('/api/setup/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [envVar]: null }),
  });
  expect(unset.status).toBe(200);
});

test('quitting the app stops the engine', async () => {
  expect(child.exitCode).toBeNull();
  child.kill('SIGTERM');
  const result = await Promise.race([
    exited,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`the app did not quit within ${QUIT_BUDGET_MS / 1000} s`)), QUIT_BUDGET_MS)),
  ]);
  console.log(`app exited: code ${String(result.code)} signal ${String(result.signal)}`);
  expect(result.signal).toBeNull();

  await expect.poll(() => portOpen(engineUrl), { timeout: 20_000, message: 'the engine port is still answering after quit' }).toBe(false);
  // The shell's own shutdown ran (not a crash): the launcher was stopped and the controller closed.
  const log = await readText(mainLog);
  expect(log).toContain('stopping launcher pid');
  expect(log).toContain('controller shut down');
});
