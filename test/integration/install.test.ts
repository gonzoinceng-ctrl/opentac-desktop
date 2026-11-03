import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createInstallManager,
  InstallError,
  type InstallManager,
  type InstallProgress,
} from '../../src/main/install.js';
import {
  arrayLogger,
  makeInstallFixture,
  type InstallFixture,
} from '../helpers/install-fixtures.js';

const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
const PROJECT_ROOT = join(import.meta.dirname, '..', '..');
const VENDOR_NODE = join(PROJECT_ROOT, 'vendor', 'node', `darwin-${ARCH}`);
const REAL_NODE = join(VENDOR_NODE, 'bin', 'node');
const REAL_NPM = join(VENDOR_NODE, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
const HAVE_VENDOR = existsSync(REAL_NODE) && existsSync(REAL_NPM);
if (!HAVE_VENDOR) {
  console.warn(`SKIPPING real-npm install tests: bundled Node not found at ${VENDOR_NODE}`);
}
const itVendor = it.skipIf(!HAVE_VENDOR);

let fx: InstallFixture;
const pidsToKill: number[] = [];

beforeEach(async () => {
  fx = await makeInstallFixture();
});

afterEach(async () => {
  for (const pid of pidsToKill.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  await fx.cleanup();
});

function manager(
  nodeBin: string,
  npmCli: string,
  extra: { retryDelayMs?: number } = {},
): { mgr: InstallManager; logs: string[] } {
  const { log, out } = arrayLogger();
  const mgr = createInstallManager({
    paths: {
      checkoutDir: fx.checkoutDir,
      nodeBin,
      npmCli,
      npmCacheDir: fx.npmCacheDir,
      nodeModulesDir: fx.nodeModulesDir,
    },
    log,
    env: { HOME: fx.home, TMPDIR: fx.root },
    ...extra,
  });
  return { mgr, logs: out };
}

async function fakeNpm(source: string): Promise<string> {
  const file = join(fx.root, 'fake-npm-cli.js');
  await writeFile(file, source);
  return file;
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('waitFor timed out');
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('install with the bundled npm', () => {
  itVendor('runs npm ci on a dependency-free fixture', async () => {
    const { mgr, logs } = manager(REAL_NODE, REAL_NPM);
    const lines: InstallProgress[] = [];
    const result = await mgr.install((p) => lines.push(p));

    const lockBytes = await readFile(join(fx.checkoutDir, 'package-lock.json'));
    expect(result.lockHash).toBe(createHash('sha256').update(lockBytes).digest('hex'));
    expect(result.nodeVersion).toBe('24.22.2');
    expect(result.attempts).toBe(1);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(await mgr.lockHash()).toBe(result.lockHash);
    // npm ci creates node_modules even when empty; either way the exit was clean.
    if (!existsSync(fx.nodeModulesDir)) {
      expect(result.lockHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.stream === 'stdout' || l.stream === 'stderr')).toBe(true);
    expect(logs.some((l) => /^info:\[install\] npm ci \(attempt 1\) took \d+ms$/.test(l))).toBe(
      true,
    );
    expect(logs.some((l) => l.startsWith('debug:[install] npm '))).toBe(true);
  });

  itVendor('needsInstall walks through every transition', async () => {
    const { mgr } = manager(REAL_NODE, REAL_NPM);
    const never = { installedLockHash: null, installedNodeVersion: null, installedCommit: null };
    expect(await mgr.needsInstall(never)).toEqual({ needed: true, reason: 'never-installed' });

    const result = await mgr.install(() => {});
    const recorded = {
      installedLockHash: result.lockHash,
      installedNodeVersion: result.nodeVersion,
      installedCommit: 'abc123',
    };
    // Make sure node_modules exists regardless of what npm ci did for an empty tree.
    await mkdir(fx.nodeModulesDir, { recursive: true });
    expect(await mgr.needsInstall(recorded)).toEqual({ needed: false, reason: 'up-to-date' });

    expect(await mgr.needsInstall({ ...recorded, installedNodeVersion: '24.0.0' })).toEqual({
      needed: true,
      reason: 'node-changed',
    });

    await rm(fx.nodeModulesDir, { recursive: true, force: true });
    expect(await mgr.needsInstall(recorded)).toEqual({ needed: true, reason: 'no-node-modules' });
    await mkdir(fx.nodeModulesDir, { recursive: true });

    await appendFile(join(fx.checkoutDir, 'package-lock.json'), '\n');
    expect(await mgr.needsInstall(recorded)).toEqual({ needed: true, reason: 'lock-changed' });
  });

  itVendor('runDoctor reports not ready for a doctor that exits 1', async () => {
    await mkdir(join(fx.checkoutDir, 'scripts'), { recursive: true });
    await writeFile(
      join(fx.checkoutDir, 'scripts', 'setup-doctor.mjs'),
      "console.log('Missing OPENAI_API_KEY=sk-live1234567890abcdef');\nconsole.error('not ready');\nprocess.exit(1);\n",
    );
    const { mgr } = manager(REAL_NODE, REAL_NPM);
    const r = await mgr.runDoctor();
    expect(r.ready).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('not ready');
    expect(r.output).toContain('Missing OPENAI_API_KEY=[REDACTED]');
    expect(r.output).not.toContain('sk-live');
  });

  itVendor('runDoctor reports ready for a doctor that exits 0', async () => {
    await mkdir(join(fx.checkoutDir, 'scripts'), { recursive: true });
    await writeFile(
      join(fx.checkoutDir, 'scripts', 'setup-doctor.mjs'),
      "console.log('all good');\n",
    );
    const r = await manager(REAL_NODE, REAL_NPM).mgr.runDoctor();
    expect(r).toEqual({ ready: true, exitCode: 0, output: 'all good' });
  });
});

describe('install with a fake npm-cli.js (current Node)', () => {
  it('runDoctor with no script returns ready', async () => {
    const r = await manager(process.execPath, '/unused').mgr.runDoctor();
    expect(r).toEqual({ ready: true, output: 'no doctor script', exitCode: 0 });
  });

  it('runDoctor with a doctor that exits 1 never throws', async () => {
    await mkdir(join(fx.checkoutDir, 'scripts'), { recursive: true });
    await writeFile(join(fx.checkoutDir, 'scripts', 'setup-doctor.mjs'), 'process.exit(1);\n');
    const r = await manager(process.execPath, '/unused').mgr.runDoctor();
    expect(r.ready).toBe(false);
    expect(r.exitCode).toBe(1);
  });

  it('bundledNodeVersion strips the v and caches', async () => {
    const { mgr, logs } = manager(process.execPath, '/unused');
    const v = await mgr.bundledNodeVersion();
    expect(v).toBe(process.version.slice(1));
    await mgr.bundledNodeVersion();
    expect(logs.filter((l) => l.includes('node --version took')).length).toBe(1);
  });

  it('AbortSignal aborts a long-running npm and kills the child', async () => {
    const pidFile = join(fx.root, 'pid');
    const npmCli = await fakeNpm(
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        "console.log('sleeping');\nsetInterval(() => {}, 1000);\n",
    );
    const { mgr } = manager(process.execPath, npmCli);
    const ac = new AbortController();
    const seen: string[] = [];
    const promise = mgr.install((p) => seen.push(p.line), { signal: ac.signal });
    const settled = promise.catch((e: unknown) => e);
    await waitFor(() => existsSync(pidFile) && seen.includes('sleeping'));
    const pid = Number(await readFile(pidFile, 'utf8'));
    pidsToKill.push(pid);
    expect(alive(pid)).toBe(true);
    ac.abort();
    const err = await settled;
    expect(err).toBeInstanceOf(InstallError);
    expect((err as InstallError).code).toBe('ABORTED');
    await waitFor(() => !alive(pid));
  });

  it('times out a hung npm with TIMEOUT and kills it', async () => {
    const pidFile = join(fx.root, 'pid');
    const npmCli = await fakeNpm(
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        'setInterval(() => {}, 1000);\n',
    );
    const { mgr } = manager(process.execPath, npmCli);
    const err = await mgr.install(() => {}, { timeoutMs: 600 }).catch((e: unknown) => e);
    expect((err as InstallError).code).toBe('TIMEOUT');
    const pid = Number(await readFile(pidFile, 'utf8'));
    pidsToKill.push(pid);
    await waitFor(() => !alive(pid));
  });

  it('tolerates npm warn install-scripts lines on stderr and splits lines on both streams', async () => {
    const npmCli = await fakeNpm(
      "console.error('npm warn install-scripts esbuild has a postinstall');\n" +
        "process.stdout.write('added 0 packages\\r\\nsecond line\\nno newline at end');\n",
    );
    const { mgr } = manager(process.execPath, npmCli);
    const got: InstallProgress[] = [];
    const result = await mgr.install((p) => got.push(p));
    expect(result.attempts).toBe(1);
    expect(got).toContainEqual({
      stream: 'stderr',
      line: 'npm warn install-scripts esbuild has a postinstall',
    });
    expect(got.filter((p) => p.stream === 'stdout').map((p) => p.line)).toEqual([
      'added 0 packages',
      'second line',
      'no newline at end',
    ]);
  });

  it('passes the clean npm environment and ignores parent npm_config_*', async () => {
    process.env['npm_config_registry'] = 'http://leak.invalid';
    try {
      const npmCli = await fakeNpm(
        'const e = process.env;\n' +
          'console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), path: e.PATH, ci: e.CI, ' +
          'cache: e.npm_config_cache, reg: e.npm_config_registry ?? null, pup: e.PUPPETEER_SKIP_DOWNLOAD }));\n',
      );
      const { mgr } = manager(process.execPath, npmCli);
      const got: string[] = [];
      await mgr.install((p) => got.push(p.line));
      const info = JSON.parse(got[0] ?? '{}') as Record<string, unknown>;
      expect(info['args']).toEqual(['ci', '--no-audit', '--no-fund', '--loglevel=notice']);
      expect(info['reg']).toBeNull();
      expect(info['ci']).toBe('1');
      expect(info['pup']).toBe('1');
      expect(info['cache']).toBe(fx.npmCacheDir);
      expect(String(info['path'])).toMatch(/:\/usr\/bin:\/bin$/);
      expect(await realpathish(String(info['cwd']))).toBe(await realpathish(fx.checkoutDir));
    } finally {
      delete process.env['npm_config_registry'];
    }
  });

  it('retries once after a network failure and reports attempts', async () => {
    const counter = join(fx.root, 'count');
    const npmCli = await fakeNpm(
      "const fs = require('node:fs');\n" +
        `const f = ${JSON.stringify(counter)};\n` +
        "fs.appendFileSync(f, 'x');\n" +
        "if (fs.readFileSync(f, 'utf8').length === 1) {\n" +
        "  console.error('npm ERR! code ECONNRESET');\n  process.exit(1);\n}\n" +
        "console.log('added 0 packages');\n",
    );
    const { mgr, logs } = manager(process.execPath, npmCli, { retryDelayMs: 10 });
    const result = await mgr.install(() => {});
    expect(result.attempts).toBe(2);
    expect(logs.some((l) => l.includes('retrying'))).toBe(true);
  });

  it('gives up with NETWORK after the second network failure', async () => {
    const npmCli = await fakeNpm("console.error('npm error code ETIMEDOUT');\nprocess.exit(1);\n");
    const { mgr } = manager(process.execPath, npmCli, { retryDelayMs: 10 });
    const err = await mgr.install(() => {}).catch((e: unknown) => e);
    expect((err as InstallError).code).toBe('NETWORK');
    expect((err as InstallError).detail).toContain('ETIMEDOUT');
    expect((err as InstallError).message).not.toMatch(/\n|\bat .*:\d+/);
  });

  it('maps ENOSPC to DISK_FULL without retrying', async () => {
    const counter = join(fx.root, 'count');
    const npmCli = await fakeNpm(
      `require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'x');\n` +
        "console.error('npm ERR! code ENOSPC');\nprocess.exit(1);\n",
    );
    const { mgr } = manager(process.execPath, npmCli, { retryDelayMs: 10 });
    const err = await mgr.install(() => {}).catch((e: unknown) => e);
    expect((err as InstallError).code).toBe('DISK_FULL');
    expect((await readFile(counter, 'utf8')).length).toBe(1);
  });

  it('maps other failures to NPM_FAILED with the output tail and redacts secrets', async () => {
    const npmCli = await fakeNpm(
      "console.error('npm ERR! code E404');\n" +
        "console.error('token OPENAI_API_KEY=sk-live1234567890abcdef');\nprocess.exit(1);\n",
    );
    const { mgr, logs } = manager(process.execPath, npmCli);
    const got: string[] = [];
    const err = await mgr.install((p) => got.push(p.line)).catch((e: unknown) => e);
    expect((err as InstallError).code).toBe('NPM_FAILED');
    expect((err as InstallError).detail).toContain('exited with code 1');
    expect((err as InstallError).detail).toContain('E404');
    expect((err as InstallError).detail).not.toContain('sk-live');
    expect(got.join('\n')).not.toContain('sk-live');
    expect(logs.join('\n')).not.toContain('sk-live');
  });
});

async function realpathish(p: string): Promise<string> {
  const { realpath } = await import('node:fs/promises');
  return realpath(p);
}
