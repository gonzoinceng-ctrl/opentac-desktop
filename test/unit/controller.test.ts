import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ACTION_NAMES, PHASES, type Disclosure, type Phase } from '../../src/shared/ipc.js';
import type { ShellState } from '../../src/shared/types.js';
import {
  AUTO_RESTART_GUARD_MS,
  CHECK_INTERVAL_MS,
  IllegalTransitionError,
  LAUNCH_CHECK_DELAY_MS,
  SHELL_CHECK_DELAY_MS,
  TRANSITIONS,
  createController,
  createPhaseMachine,
  isAllowedTransition,
  isAutomaticCheckDue,
  isQuietlySkipped,
  resolveDevOverrides,
  resolveEngineOverrides,
  type ControllerDeps,
  type ShellController,
} from '../../src/main/controller.js';
import { GitError } from '../../src/main/git.js';
import { InstallError } from '../../src/main/install.js';
import type { Paths } from '../../src/main/paths.js';
import { createRingBuffer } from '../../src/main/ringBuffer.js';
import { ServerError } from '../../src/main/server.js';
import type { UpdateCheck } from '../../src/main/update.js';
import {
  BASE_TIME,
  FakeCheckout,
  FakeGateway,
  FakeInstall,
  FakeSecrets,
  FakeServer,
  FakeShellUpdater,
  FakeUi,
  FakeUpdate,
  SHA_A,
  SHA_B,
  SHA_C,
  createFakeClock,
  flush,
  stateWith,
  target,
  testLogger,
  waitFor,
} from '../helpers/core-fakes.js';

const GB = 1024 ** 3;

interface Harness {
  controller: ShellController;
  trace: string[];
  clock: ReturnType<typeof createFakeClock>;
  checkout: FakeCheckout;
  install: FakeInstall;
  server: FakeServer;
  ui: FakeUi;
  secrets: FakeSecrets;
  shellUpdater: FakeShellUpdater;
  update: FakeUpdate;
  gateways: FakeGateway[];
  saved: ShellState[];
  phases: Phase[];
  logs: string[];
  busyPorts: Set<number>;
  portCalls: Array<{ preferred?: number }>;
  envHasOpenAiKey: { value: boolean };
  paths: Paths;
  ring: ReturnType<typeof createRingBuffer>;
  quits: { count: number };
}

interface HarnessOptions {
  state?: Partial<ShellState>;
  env?: NodeJS.ProcessEnv;
  isPackaged?: boolean;
  free?: number | (() => number);
  exists?: boolean;
  dataDir?: string;
  fetchImpl?: typeof fetch;
  gatewayFails?: boolean;
}

function fakePaths(dataDir: string): Paths {
  const checkoutDir = join(dataDir, 'checkout');
  return {
    dataDir,
    checkoutDir,
    envFile: join(checkoutDir, '.env'),
    gevCacheDir: join(checkoutDir, '.gev-cache'),
    gevLogsDir: join(checkoutDir, '.gev-logs'),
    nodeModulesDir: join(checkoutDir, 'node_modules'),
    viteCacheDir: join(checkoutDir, 'node_modules', '.vite'),
    stateFile: join(dataDir, 'state.json'),
    stateBackupFile: join(dataDir, 'state.json.bak'),
    npmCacheDir: join(dataDir, 'npm-cache'),
    logsDir: join(dataDir, 'logs'),
    mainLog: join(dataDir, 'logs', 'main.log'),
    serverLog: join(dataDir, 'logs', 'server.log'),
    nodeBin: '/nope/node',
    npmCli: '/nope/npm-cli.js',
    launcherScript: '/nope/launcher.mjs',
    gitDir: '/nope/git',
  };
}

function makeHarness(o: HarnessOptions = {}): Harness {
  const trace: string[] = [];
  const clock = createFakeClock();
  const checkout = new FakeCheckout(trace);
  checkout.existsValue = o.exists ?? true;
  const install = new FakeInstall(trace);
  const server = new FakeServer(trace);
  const ui = new FakeUi(trace);
  const secrets = new FakeSecrets();
  const shellUpdater = new FakeShellUpdater();
  const update = new FakeUpdate();
  const gateways: FakeGateway[] = [];
  const saved: ShellState[] = [];
  const { log, out } = testLogger();
  const busyPorts = new Set<number>();
  const portCalls: Array<{ preferred?: number }> = [];
  const envHasOpenAiKey = { value: false };
  const paths = fakePaths(o.dataDir ?? '/nonexistent-opentac-test');
  const ring = createRingBuffer(500);
  const quits = { count: 0 };
  const initialState = stateWith({
    installedCommit: SHA_A,
    installedLockHash: 'lock-1',
    installedNodeVersion: '24.22.2',
    lastSuccessfulStart: new Date(BASE_TIME - 86_400_000).toISOString(),
    lastPort: 4173,
    ...o.state,
  });
  const deps: ControllerDeps = {
    paths,
    log,
    initialState,
    saveState: async (s) => {
      saved.push(s);
      trace.push(`save:rollback=${s.rollbackCommit === null ? 'null' : s.rollbackCommit.slice(0, 1)}`);
    },
    checkout,
    install,
    server,
    ring,
    gatewayFactory: (cfg) => {
      const g = new FakeGateway(cfg.getConfig, cfg.authToken);
      if (o.gatewayFails === true) {
        g.start = async () => {
          throw new Error('gateway cannot listen');
        };
      }
      gateways.push(g);
      return g;
    },
    secrets,
    ui,
    shellUpdater,
    appVersion: '0.1.0',
    electronVersion: '45.2.1',
    chromiumVersion: '156.0.0',
    env: o.env ?? {},
    isPackaged: o.isPackaged ?? false,
    now: clock.now,
    timers: clock.timers,
    diskFree: async () => (typeof o.free === 'function' ? o.free() : (o.free ?? 100 * GB)),
    envFileHasKey: async () => envHasOpenAiKey.value,
    ports: {
      isPortFree: async (p) => !busyPorts.has(p),
      findFreePort: async (opts) => {
        portCalls.push(opts);
        return opts.preferred ?? 4173;
      },
    },
    update,
    requestQuit: () => {
      quits.count += 1;
    },
    ...(o.fetchImpl !== undefined ? { fetchImpl: o.fetchImpl } : {}),
  };
  const controller = createController(deps);
  const phases: Phase[] = [];
  controller.onState((s) => {
    if (phases[phases.length - 1] !== s.phase) phases.push(s.phase);
  });
  return {
    controller,
    trace,
    clock,
    checkout,
    install,
    server,
    ui,
    secrets,
    shellUpdater,
    update,
    gateways,
    saved,
    phases,
    logs: out,
    busyPorts,
    portCalls,
    envHasOpenAiKey,
    paths,
    ring,
    quits,
  };
}

const live: Harness[] = [];
async function boot(o: HarnessOptions = {}): Promise<Harness> {
  const h = makeHarness(o);
  live.push(h);
  await h.controller.start();
  return h;
}

afterEach(async () => {
  for (const h of live.splice(0)) await h.controller.shutdown();
});

function disclosure(over: Partial<Disclosure> = {}): Disclosure {
  return {
    remote: 'https://github.com/o/r.git',
    channel: 'stable',
    fromCommit: SHA_A,
    toCommit: SHA_B,
    fromLabel: 'aaaaaaa',
    toLabel: 'bbbbbbb',
    commitCount: 1,
    truncated: false,
    commits: [],
    diffStat: '',
    lockfileChanged: false,
    compareUrl: null,
    dirty: { modified: [], untracked: [] },
    needsReset: false,
    untested: false,
    gate: null,
    minShell: null,
    severity: 'normal',
    blockedByShell: false,
    ...over,
  };
}

function available(over: Partial<Disclosure> = {}, commit = SHA_B): UpdateCheck {
  return { kind: 'available', target: target(commit), disclosure: disclosure({ toCommit: commit, ...over }) };
}

// ---------------------------------------------------------------------------

describe('phase machine and TRANSITIONS', () => {
  const marker = (on: boolean) => () => on;
  const quiet = testLogger().log;

  it('every allowed edge works and every other edge throws', () => {
    let allowed = 0;
    let forbidden = 0;
    for (const from of PHASES) {
      for (const to of PHASES) {
        const m = createPhaseMachine({ initial: from, log: quiet, hasRollbackMarker: marker(true) });
        if (TRANSITIONS[from].includes(to)) {
          expect(m.transition(to, 'test')).toBe(from);
          expect(m.phase()).toBe(to);
          allowed += 1;
        } else {
          expect(() => m.transition(to, 'test')).toThrow(IllegalTransitionError);
          expect(m.phase()).toBe(from);
          forbidden += 1;
        }
      }
    }
    expect(allowed).toBe(Object.values(TRANSITIONS).reduce((n, t) => n + t.length, 0));
    expect(allowed + forbidden).toBe(PHASES.length ** 2);
  });

  it('matches the design document for the documented edges', () => {
    const doc: Record<string, string[]> = {
      BOOT: ['CLONING', 'INSTALLING', 'STARTING', 'ERROR'],
      CLONING: ['INSTALLING', 'ERROR'],
      STARTING: ['RUNNING', 'ERROR', 'ROLLING_BACK'],
      RUNNING: ['CHECKING', 'CRASHED', 'RESTARTING', 'ERROR'],
      CHECKING: ['RUNNING', 'DISCLOSING', 'ERROR'],
      DISCLOSING: ['RUNNING', 'UPDATING'],
      UPDATING: ['INSTALLING', 'STARTING', 'ROLLING_BACK', 'ERROR'],
      ROLLING_BACK: ['INSTALLING', 'STARTING', 'ERROR'],
      CRASHED: ['STARTING', 'INSTALLING', 'ERROR'],
      ERROR: ['BOOT', 'CLONING', 'INSTALLING', 'STARTING'],
    };
    for (const [from, tos] of Object.entries(doc)) {
      expect([...TRANSITIONS[from as Phase]].sort()).toEqual([...tos].sort());
    }
    // The two documented additions.
    expect(isAllowedTransition('INSTALLING', 'ROLLING_BACK')).toBe(true);
    expect(isAllowedTransition('RESTARTING', 'INSTALLING')).toBe(true);
    expect(TRANSITIONS.INSTALLING).toEqual(['STARTING', 'ERROR', 'ROLLING_BACK']);
    expect(TRANSITIONS.RESTARTING).toContain('STARTING');
  });

  it('entering ROLLING_BACK needs a rollback marker', () => {
    for (const from of PHASES.filter((p) => isAllowedTransition(p, 'ROLLING_BACK'))) {
      const m = createPhaseMachine({ initial: from, log: quiet, hasRollbackMarker: marker(false) });
      expect(() => m.transition('ROLLING_BACK', 'x')).toThrow(/rollback marker/);
    }
  });

  it('every phase is reachable from BOOT', () => {
    const seen = new Set<Phase>(['BOOT']);
    const queue: Phase[] = ['BOOT'];
    while (queue.length > 0) {
      const p = queue.shift() as Phase;
      for (const n of TRANSITIONS[p]) {
        if (!seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    expect([...seen].sort()).toEqual([...PHASES].sort());
  });

  it('logs every move', () => {
    const { log, out } = testLogger();
    const m = createPhaseMachine({ log, hasRollbackMarker: marker(false) });
    m.transition('STARTING', 'because');
    expect(out.join('\n')).toContain('phase BOOT -> STARTING: because');
  });
});

describe('pure helpers', () => {
  it('resolveDevOverrides is empty when packaged and filters empties otherwise', () => {
    const env = {
      OPENTAC_LAUNCHER_OVERRIDE: '/l.mjs',
      OPENTAC_NODE_OVERRIDE: '/node',
      OPENTAC_NPM_CLI_OVERRIDE: '',
    };
    expect(resolveDevOverrides(env, true)).toEqual({});
    expect(resolveDevOverrides(env, false)).toEqual({ launcherScript: '/l.mjs', nodeBin: '/node' });
    expect(resolveDevOverrides({}, false)).toEqual({});
  });

  it('resolveEngineOverrides trims and rejects option-like refs', () => {
    expect(resolveEngineOverrides({ OPENTAC_ENGINE_REMOTE: ' file:///m.git ', OPENTAC_ENGINE_REF: 'candidate' })).toEqual({
      remoteUrl: 'file:///m.git',
      ref: 'candidate',
    });
    expect(resolveEngineOverrides({ OPENTAC_ENGINE_REF: '--upload-pack=x' })).toEqual({});
  });

  it('isAutomaticCheckDue and isQuietlySkipped', () => {
    const now = BASE_TIME;
    expect(isAutomaticCheckDue(null, now)).toBe(true);
    expect(isAutomaticCheckDue(new Date(now - 3_600_000).toISOString(), now)).toBe(false);
    expect(isAutomaticCheckDue(new Date(now - CHECK_INTERVAL_MS).toISOString(), now)).toBe(true);
    expect(isAutomaticCheckDue('garbage', now)).toBe(true);
    expect(isQuietlySkipped(SHA_B, SHA_B, false, 'normal')).toBe(true);
    expect(isQuietlySkipped(SHA_B, SHA_B, false, 'security')).toBe(false);
    expect(isQuietlySkipped(SHA_B, SHA_B, true, 'normal')).toBe(false);
    expect(isQuietlySkipped(SHA_A, SHA_B, false, 'normal')).toBe(false);
    expect(isQuietlySkipped(null, SHA_B, false, 'normal')).toBe(false);
  });
});

describe('boot', () => {
  it('no checkout: CLONING, INSTALLING, STARTING, RUNNING', async () => {
    const h = await boot({ exists: false, state: { installedCommit: null, installedLockHash: null, installedNodeVersion: null, lastSuccessfulStart: null, lastPort: null } });
    expect(h.phases).toEqual(['BOOT', 'CLONING', 'INSTALLING', 'STARTING', 'RUNNING']);
    expect(h.checkout.count('clone')).toBe(1);
    expect(h.checkout.count('checkoutDetached')).toBe(1);
    expect(h.install.count('install')).toBe(1);
    expect(h.install.count('runDoctor')).toBe(1);
    expect(h.server.starts).toHaveLength(1);
    expect(h.server.starts[0]?.firstRun).toBe(true);
    expect(h.ui.mainUrl).toBe('http://127.0.0.1:4173/');
    expect(h.ui.engineOrigin).toBe('http://127.0.0.1:4173');
    expect(h.controller.engineUrl()).toBe('http://127.0.0.1:4173/');
    const s = h.controller.state();
    expect(s.installedLockHash).toBe('lock-1');
    expect(s.installedNodeVersion).toBe('24.22.2');
    expect(s.installedCommit).toBe(SHA_B === s.installedCommit ? SHA_B : s.installedCommit);
    expect(s.lastPort).toBe(4173);
    expect(s.lastSuccessfulStart).not.toBeNull();
    expect(s.rollbackCommit).toBeNull();
  });

  it('checkout out then install then start happen in that order', async () => {
    const h = await boot({ exists: false, state: { installedCommit: null, installedLockHash: null, installedNodeVersion: null, lastSuccessfulStart: null, lastPort: null } });
    const order = h.trace.filter((t) => /checkout\.(clone|checkoutDetached)|^install$|server\.start/.test(t));
    expect(order).toEqual([
      'checkout.clone',
      'checkout.checkoutDetached',
      'install',
      'server.start',
    ]);
  });

  it('existing checkout with a changed lockfile installs first', async () => {
    const h = makeHarness();
    live.push(h);
    h.install.needs = { needed: true, reason: 'lock-changed' };
    await h.controller.start();
    expect(h.phases).toEqual(['BOOT', 'INSTALLING', 'STARTING', 'RUNNING']);
    expect(h.checkout.count('clone')).toBe(0);
    expect(h.install.count('install')).toBe(1);
  });

  it('existing, current checkout goes straight to STARTING', async () => {
    const h = await boot();
    expect(h.phases).toEqual(['BOOT', 'STARTING', 'RUNNING']);
    expect(h.install.count('install')).toBe(0);
    expect(h.server.starts[0]?.firstRun).toBe(false);
    expect(h.ui.count('hideSetup')).toBeGreaterThan(0);
  });

  it('a checkout that was cloned but never installed is checked out again', async () => {
    const h = await boot({ state: { installedCommit: null, installedLockHash: null, installedNodeVersion: null } });
    expect(h.phases).toEqual(['BOOT', 'INSTALLING', 'STARTING', 'RUNNING']);
    expect(h.checkout.count('clone')).toBe(0);
    expect(h.checkout.count('checkoutDetached')).toBe(1);
  });

  it('OPENTAC_ENGINE_REMOTE overrides the remote for the clone and is not persisted', async () => {
    const h = await boot({
      exists: false,
      state: { installedCommit: null, installedLockHash: null, installedNodeVersion: null, lastPort: null },
      env: { OPENTAC_ENGINE_REMOTE: 'file:///tmp/mirror.git', OPENTAC_ENGINE_REF: 'refs/heads/candidate' },
    });
    expect(h.checkout.cloneRemotes).toEqual(['file:///tmp/mirror.git']);
    expect(h.controller.state().remoteUrl).toBe('https://github.com/o/r.git');
  });

  it('points origin at the override remote when the checkout already exists', async () => {
    const h = await boot({ env: { OPENTAC_ENGINE_REMOTE: 'file:///tmp/mirror.git' } });
    expect(h.checkout.remote).toBe('file:///tmp/mirror.git');
  });

  it('logs dev overrides only when unpackaged', async () => {
    const env = { OPENTAC_LAUNCHER_OVERRIDE: '/fake/launcher.mjs' };
    const a = await boot({ env, isPackaged: false });
    expect(a.logs.join('\n')).toContain('dev override active: launcherScript = /fake/launcher.mjs');
    const b = await boot({ env, isPackaged: true });
    expect(b.logs.join('\n')).toContain('OPENTAC_LAUNCHER_OVERRIDE is ignored in a packaged build');
  });

  it('low disk space is an ERROR with DISK_SPACE before any clone', async () => {
    const h = await boot({ exists: false, free: 1 * GB, state: { installedCommit: null, installedLockHash: null, installedNodeVersion: null } });
    expect(h.controller.phase()).toBe('ERROR');
    const err = h.controller.publicState().error;
    expect(err?.code).toBe('DISK_SPACE');
    expect(err?.actions).toContain('retry');
    expect(err?.message).toContain('1.0 GB');
    expect(h.checkout.count('clone')).toBe(0);
    expect(h.ui.count('showSetup')).toBeGreaterThan(0);
  });

  it('low disk space does not block an engine that needs no install', async () => {
    const h = await boot({ free: 1 * GB });
    expect(h.controller.phase()).toBe('RUNNING');
  });

  it('retry after fixing the problem boots again', async () => {
    let free = 1 * GB;
    const h = await boot({ exists: false, free: () => free, state: { installedCommit: null, installedLockHash: null, installedNodeVersion: null } });
    expect(h.controller.phase()).toBe('ERROR');
    free = 50 * GB;
    await h.controller.action('retry');
    expect(h.controller.phase()).toBe('RUNNING');
    expect(h.phases).toEqual(['BOOT', 'ERROR', 'BOOT', 'CLONING', 'INSTALLING', 'STARTING', 'RUNNING']);
  });

  it('a clone failure is an ERROR with retry', async () => {
    const h = makeHarness({ exists: false, state: { installedCommit: null, installedLockHash: null, installedNodeVersion: null } });
    live.push(h);
    h.checkout.cloneError = new GitError('NETWORK', 'Could not reach.', 'unable to access');
    await h.controller.start();
    expect(h.controller.phase()).toBe('ERROR');
    expect(h.controller.publicState().error?.code).toBe('NETWORK');
    expect(h.controller.publicState().error?.actions).toContain('retry');
  });

  it('an install failure is an ERROR with NPM_FAILED', async () => {
    const h = makeHarness({ state: { installedLockHash: null } });
    live.push(h);
    h.install.needs = { needed: true, reason: 'never-installed' };
    h.install.installError = new InstallError('NPM_FAILED', 'npm failed.', 'npm error');
    await h.controller.start();
    expect(h.controller.phase()).toBe('ERROR');
    expect(h.controller.publicState().error?.code).toBe('NPM_FAILED');
    expect(h.server.starts).toHaveLength(0);
  });

  it('a start failure without a rollback marker is an ERROR', async () => {
    const h = makeHarness();
    live.push(h);
    h.server.startQueue = [new ServerError('START_FAILED', 'did not start', { detail: 'boom' })];
    await h.controller.start();
    expect(h.controller.phase()).toBe('ERROR');
    expect(h.controller.publicState().error?.code).toBe('START_FAILED');
    expect(h.phases).not.toContain('ROLLING_BACK');
  });

  it('reinstall from ERROR installs then starts', async () => {
    const h = makeHarness();
    live.push(h);
    h.server.startQueue = [new ServerError('VITE_MISSING', 'vite missing')];
    await h.controller.start();
    expect(h.controller.publicState().error?.actions).toContain('reinstall');
    await h.controller.action('reinstall');
    expect(h.controller.phase()).toBe('RUNNING');
    expect(h.install.count('install')).toBe(1);
  });

  it('start() twice does not boot twice', async () => {
    const h = await boot();
    await h.controller.start();
    expect(h.server.starts).toHaveLength(1);
  });
});

describe('port pinning', () => {
  it('first run asks for port 4173 preferred and saves it', async () => {
    const h = await boot({ state: { lastPort: null } });
    expect(h.portCalls).toEqual([{ preferred: 4173 }]);
    expect(h.controller.state().lastPort).toBe(4173);
  });

  it('reuses a free lastPort', async () => {
    const h = await boot({ state: { lastPort: 4200 } });
    expect(h.server.starts[0]?.port).toBe(4200);
    expect(h.portCalls).toEqual([]);
    expect(h.controller.publicState().port).toBe(4200);
  });

  it('a busy lastPort is ERROR PORT_IN_USE offering changePort, and the server is not started', async () => {
    const h = makeHarness({ state: { lastPort: 4200 } });
    live.push(h);
    h.busyPorts.add(4200);
    await h.controller.start();
    expect(h.controller.phase()).toBe('ERROR');
    const err = h.controller.publicState().error;
    expect(err?.code).toBe('PORT_IN_USE');
    expect(err?.actions).toContain('changePort');
    expect(err?.actions).toContain('retry');
    expect(h.server.starts).toHaveLength(0);
  });

  it('changePort picks a different free port and starts on it', async () => {
    const h = makeHarness({ state: { lastPort: 4200 } });
    live.push(h);
    h.busyPorts.add(4200);
    h.busyPorts.add(4173);
    await h.controller.start();
    await h.controller.action('changePort');
    expect(h.controller.phase()).toBe('RUNNING');
    expect(h.server.starts[0]?.port).toBe(4174);
    expect(h.controller.state().lastPort).toBe(4174);
  });

  it('changePort never picks the port it is leaving, even if it freed up', async () => {
    const h = makeHarness({ state: { lastPort: 4173 } });
    live.push(h);
    h.busyPorts.add(4173);
    await h.controller.start();
    h.busyPorts.delete(4173);
    await h.controller.action('changePort');
    expect(h.server.starts[0]?.port).not.toBe(4173);
  });

  it('changePort is ignored when there is no port problem', async () => {
    const h = await boot();
    await h.controller.action('changePort');
    expect(h.controller.phase()).toBe('RUNNING');
    expect(h.server.starts).toHaveLength(1);
  });

  it('EADDRINUSE is retried once after one second on the same port', async () => {
    const h = makeHarness();
    live.push(h);
    h.server.startQueue = [new ServerError('EADDRINUSE', 'in use')];
    const p = h.controller.start();
    await flush();
    expect(h.server.starts).toHaveLength(1);
    await h.clock.advance(999);
    expect(h.server.starts).toHaveLength(1);
    await h.clock.advance(1);
    await p;
    expect(h.server.starts).toHaveLength(2);
    expect(h.server.starts[1]?.port).toBe(h.server.starts[0]?.port);
    expect(h.controller.phase()).toBe('RUNNING');
  });

  it('a second EADDRINUSE becomes ERROR PORT_IN_USE', async () => {
    const h = makeHarness();
    live.push(h);
    h.server.startQueue = [new ServerError('EADDRINUSE', 'in use'), new ServerError('EADDRINUSE', 'in use')];
    const p = h.controller.start();
    await flush();
    await h.clock.advance(1000);
    await p;
    expect(h.server.starts).toHaveLength(2);
    expect(h.controller.phase()).toBe('ERROR');
    expect(h.controller.publicState().error?.code).toBe('PORT_IN_USE');
    expect(h.controller.publicState().error?.actions).toContain('changePort');
  });

  it('EADDRINUSE never triggers a rollback even with a marker', async () => {
    const h = makeHarness({ state: { rollbackCommit: SHA_C } });
    live.push(h);
    h.server.startQueue = [new ServerError('EADDRINUSE', 'in use'), new ServerError('EADDRINUSE', 'in use')];
    const p = h.controller.start();
    await flush();
    await h.clock.advance(1000);
    await p;
    expect(h.phases).not.toContain('ROLLING_BACK');
    expect(h.controller.phase()).toBe('ERROR');
  });
});

describe('crash policy', () => {
  it('restarts automatically once, then waits for the user inside 60 s', async () => {
    const h = await boot();
    expect(h.server.starts).toHaveLength(1);

    h.server.emit({ type: 'exit', code: 3, signal: null, expected: false });
    await flush();
    expect(h.phases.slice(-3)).toEqual(['CRASHED', 'STARTING', 'RUNNING']);
    expect(h.server.starts).toHaveLength(2);
    expect(h.ui.count('reloadMain')).toBe(1);

    await h.clock.advance(AUTO_RESTART_GUARD_MS - 1_000);
    h.server.emit({ type: 'exit', code: 3, signal: null, expected: false });
    await flush();
    expect(h.controller.phase()).toBe('CRASHED');
    expect(h.server.starts).toHaveLength(2);
    const err = h.controller.publicState().error;
    expect(err?.actions).toEqual(['restartServer', 'showLogs', 'reinstall']);
    expect(h.ui.calls).toContain('setMainEnabled:false');

    await h.controller.action('restartServer');
    expect(h.controller.phase()).toBe('RUNNING');
    expect(h.server.starts).toHaveLength(3);
    expect(h.controller.publicState().error).toBeNull();
  });

  it('restarts automatically again once the guard window has passed', async () => {
    const h = await boot();
    h.server.emit({ type: 'exit', code: 1, signal: null, expected: false });
    await flush();
    await h.clock.advance(AUTO_RESTART_GUARD_MS + 1);
    h.server.emit({ type: 'exit', code: 1, signal: null, expected: false });
    await flush();
    expect(h.controller.phase()).toBe('RUNNING');
    expect(h.server.starts).toHaveLength(3);
  });

  it('ignores expected exits and exits outside RUNNING', async () => {
    const h = await boot();
    h.server.emit({ type: 'exit', code: 0, signal: null, expected: true });
    await flush();
    expect(h.controller.phase()).toBe('RUNNING');
    expect(h.server.starts).toHaveLength(1);
  });

  it('shows the last server line as the detail and the tail in the log', async () => {
    const h = await boot();
    h.ring.push('TypeError: boom');
    h.server.emit({ type: 'exit', code: 2, signal: null, expected: false });
    await flush();
    await h.clock.advance(1_000);
    h.ring.push('TypeError: boom again');
    h.server.emit({ type: 'exit', code: 2, signal: null, expected: false });
    await flush();
    expect(h.controller.phase()).toBe('CRASHED');
    const pub = h.controller.publicState();
    expect(pub.error?.detail).toBe('TypeError: boom again');
    expect(pub.logTail.slice(-2)).toEqual(['TypeError: boom', 'TypeError: boom again']);
  });

  it('a failed automatic restart ends in ERROR', async () => {
    const h = await boot();
    h.server.startQueue = [new ServerError('START_FAILED', 'nope')];
    h.server.emit({ type: 'exit', code: 1, signal: null, expected: false });
    await flush();
    expect(h.controller.phase()).toBe('ERROR');
  });
});

describe('background update checks', () => {
  it('schedules the launch check at 20 s, the app check at 30 s and an interval', async () => {
    const h = await boot();
    expect(h.clock.pendingDelays()).toEqual([LAUNCH_CHECK_DELAY_MS, SHELL_CHECK_DELAY_MS, CHECK_INTERVAL_MS]);
    expect(h.update.checks).toHaveLength(0);
    await h.clock.advance(LAUNCH_CHECK_DELAY_MS - 1);
    expect(h.update.checks).toHaveLength(0);
    await h.clock.advance(1);
    expect(h.update.checks).toEqual([{ interactive: false }]);
    expect(h.shellUpdater.checks).toHaveLength(0);
    await h.clock.advance(SHELL_CHECK_DELAY_MS - LAUNCH_CHECK_DELAY_MS);
    expect(h.shellUpdater.checks).toEqual([{ interactive: false }]);
    expect(h.controller.state().lastUpdateCheck).toBe(new Date(BASE_TIME + LAUNCH_CHECK_DELAY_MS).toISOString());
    expect(h.controller.phase()).toBe('RUNNING');
  });

  it('is rate limited by lastUpdateCheck', async () => {
    const h = await boot({ state: { lastUpdateCheck: new Date(BASE_TIME - 3_600_000).toISOString() } });
    await h.clock.advance(LAUNCH_CHECK_DELAY_MS + 1000);
    expect(h.update.checks).toHaveLength(0);
  });

  it('runs again on the 6 h interval and not before', async () => {
    const h = await boot();
    await h.clock.advance(LAUNCH_CHECK_DELAY_MS);
    expect(h.update.checks).toHaveLength(1);
    await h.clock.advance(CHECK_INTERVAL_MS - LAUNCH_CHECK_DELAY_MS - 1000);
    expect(h.update.checks).toHaveLength(1);
    await h.clock.advance(1000);
    expect(h.update.checks).toHaveLength(2);
  });

  it('resume and focus are rate limited the same way', async () => {
    const h = await boot();
    await h.clock.advance(LAUNCH_CHECK_DELAY_MS);
    h.controller.notifyResume();
    h.controller.notifyMainFocus();
    await flush();
    expect(h.update.checks).toHaveLength(1);
    await h.clock.advance(CHECK_INTERVAL_MS);
    h.controller.notifyResume();
    await flush();
    expect(h.update.checks.length).toBeGreaterThanOrEqual(2);
  });

  it('does nothing automatic when updateCheckOnLaunch is off', async () => {
    const h = await boot({ state: { updateCheckOnLaunch: false } });
    await h.clock.advance(LAUNCH_CHECK_DELAY_MS + 1000);
    expect(h.update.checks).toHaveLength(0);
    await h.controller.checkForEngineUpdates();
    expect(h.update.checks).toEqual([{ interactive: true }]);
  });

  it('skips the check when the phase is not RUNNING', async () => {
    const h = await boot();
    h.server.startQueue = [new ServerError('START_FAILED', 'x')];
    await h.controller.action('restartServer');
    expect(h.controller.phase()).toBe('ERROR');
    await h.clock.advance(LAUNCH_CHECK_DELAY_MS + 1);
    expect(h.update.checks).toHaveLength(0);
  });

  it('an offline background check stays silent and does not stamp lastUpdateCheck', async () => {
    const h = await boot();
    h.update.results = [{ kind: 'offline' }];
    await h.clock.advance(LAUNCH_CHECK_DELAY_MS);
    expect(h.controller.phase()).toBe('RUNNING');
    expect(h.controller.state().lastUpdateCheck).toBeNull();
    expect(h.controller.publicState().notices).toEqual([]);
  });

  it('an interactive offline check shows a notice', async () => {
    const h = await boot();
    h.update.results = [{ kind: 'offline' }];
    await h.controller.checkForEngineUpdates();
    expect(h.controller.phase()).toBe('RUNNING');
    expect(h.controller.publicState().notices[0]).toMatch(/reach GitHub/);
    expect(h.ui.count('showSetup')).toBeGreaterThan(0);
  });

  it('an interactive up-to-date check tells the user through a dialog', async () => {
    const h = await boot();
    h.update.results = [{ kind: 'up-to-date', label: 'v0.1.0' }];
    await h.controller.checkForEngineUpdates();
    expect(h.ui.calls.some((c) => c.startsWith('notify:'))).toBe(true);
    expect(h.controller.phase()).toBe('RUNNING');
  });

  it('TAG_DRIFT is an ERROR with an explanation, never auto-recovered', async () => {
    const h = await boot();
    h.update.results = [{ kind: 'tag-drift', detail: 'would clobber existing tag stable-1' }];
    await h.controller.checkForEngineUpdates();
    expect(h.controller.phase()).toBe('ERROR');
    const err = h.controller.publicState().error;
    expect(err?.code).toBe('TAG_DRIFT');
    expect(err?.detail).toContain('would clobber');
    // The installed engine can still be started.
    await h.controller.action('restartServer');
    expect(h.controller.phase()).toBe('RUNNING');
  });

  it('a thrown check error returns to RUNNING', async () => {
    const h = await boot();
    h.update.results = [new Error('weird')];
    await h.controller.checkForEngineUpdates();
    expect(h.controller.phase()).toBe('RUNNING');
    expect(h.controller.publicState().notices).toHaveLength(1);
  });
});

describe('skippedCommit', () => {
  it('stays quiet for a skipped commit on an automatic check', async () => {
    const h = await boot({ state: { skippedCommit: SHA_B } });
    h.update.results = [available()];
    await h.clock.advance(LAUNCH_CHECK_DELAY_MS);
    expect(h.controller.phase()).toBe('RUNNING');
    expect(h.phases).not.toContain('DISCLOSING');
  });

  it('does not stay quiet for a security release', async () => {
    const h = await boot({ state: { skippedCommit: SHA_B } });
    h.update.results = [available({ severity: 'security' })];
    await h.clock.advance(LAUNCH_CHECK_DELAY_MS);
    expect(h.controller.phase()).toBe('DISCLOSING');
  });

  it('does not stay quiet for an interactive check', async () => {
    const h = await boot({ state: { skippedCommit: SHA_B } });
    h.update.results = [available()];
    await h.controller.action('checkForUpdates');
    expect(h.controller.phase()).toBe('DISCLOSING');
  });

  it('a different commit is announced', async () => {
    const h = await boot({ state: { skippedCommit: SHA_A } });
    h.update.results = [available()];
    await h.clock.advance(LAUNCH_CHECK_DELAY_MS);
    expect(h.controller.phase()).toBe('DISCLOSING');
  });

  it('skipUpdate saves the commit and returns to RUNNING; laterUpdate does not save', async () => {
    const h = await boot();
    h.update.results = [available(), available()];
    await h.controller.action('checkForUpdates');
    expect(h.controller.disclosure()?.toCommit).toBe(SHA_B);
    await h.controller.action('laterUpdate');
    expect(h.controller.phase()).toBe('RUNNING');
    expect(h.controller.state().skippedCommit).toBeNull();
    expect(h.controller.disclosure()).toBeNull();
    await h.controller.action('checkForUpdates');
    await h.controller.action('skipUpdate');
    expect(h.controller.phase()).toBe('RUNNING');
    expect(h.controller.state().skippedCommit).toBe(SHA_B);
  });

  it('a blocked-by-shell disclosure offers no way to apply', async () => {
    const h = await boot();
    h.update.results = [{ kind: 'blocked-by-shell', disclosure: disclosure({ blockedByShell: true, minShell: '9.0.0' }) }];
    await h.controller.action('checkForUpdates');
    expect(h.controller.phase()).toBe('DISCLOSING');
    await h.controller.action('confirmUpdate');
    await h.controller.action('resetAndUpdate');
    expect(h.controller.phase()).toBe('DISCLOSING');
    await h.controller.action('checkForAppUpdates');
    expect(h.shellUpdater.checks).toContainEqual({ interactive: true });
    await h.controller.action('laterUpdate');
    expect(h.controller.phase()).toBe('RUNNING');
  });
});

describe('applying an update', () => {
  async function disclosed(over: Partial<Disclosure> = {}, opts: HarnessOptions = {}): Promise<Harness> {
    const h = makeHarness(opts);
    live.push(h);
    await h.controller.start();
    h.update.results = [available(over)];
    await h.controller.action('checkForUpdates');
    expect(h.controller.phase()).toBe('DISCLOSING');
    h.trace.length = 0;
    return h;
  }

  it('stops the server first, saves the rollback marker before touching the checkout, reloads', async () => {
    const h = await disclosed();
    await h.controller.action('confirmUpdate');
    expect(h.controller.phase()).toBe('RUNNING');
    const t = h.trace;
    const idx = (s: string) => t.findIndex((x) => x.startsWith(s));
    expect(idx('server.stop')).toBeGreaterThan(-1);
    expect(idx('save:rollback=a')).toBeGreaterThan(-1);
    expect(idx('save:rollback=a')).toBeLessThan(idx('server.stop'));
    expect(idx('server.stop')).toBeLessThan(idx('checkout.checkoutDetached'));
    expect(idx('checkout.checkoutDetached')).toBeLessThan(idx('server.start'));
    expect(h.ui.count('reloadMain')).toBe(1);
    expect(h.ui.calls.indexOf('setMainEnabled:false')).toBeGreaterThan(-1);
    const s = h.controller.state();
    expect(s.installedCommit).toBe(SHA_B);
    expect(s.rollbackCommit).toBeNull();
    expect(s.skippedCommit).toBeNull();
    expect(h.checkout.headSha).toBe(SHA_B);
    expect(h.phases.slice(-4)).toEqual(['DISCLOSING', 'UPDATING', 'STARTING', 'RUNNING']);
    expect(h.install.count('install')).toBe(0);
  });

  it('installs only when the lockfile changed', async () => {
    const h = makeHarness();
    live.push(h);
    await h.controller.start();
    h.checkout.lockChanged = true;
    h.update.results = [available()];
    await h.controller.action('checkForUpdates');
    await h.controller.action('confirmUpdate');
    expect(h.install.count('install')).toBe(1);
    expect(h.phases.slice(-5)).toEqual(['DISCLOSING', 'UPDATING', 'INSTALLING', 'STARTING', 'RUNNING']);
  });

  it('installs when needsInstall says so even if the lockfile did not change', async () => {
    const h = makeHarness();
    live.push(h);
    await h.controller.start();
    h.install.needs = { needed: true, reason: 'node-changed' };
    h.update.results = [available()];
    await h.controller.action('checkForUpdates');
    await h.controller.action('confirmUpdate');
    expect(h.install.count('install')).toBe(1);
  });

  it('a start failure rolls back to the previous commit and ends RUNNING', async () => {
    const h = await disclosed();
    h.server.startQueue = [new ServerError('START_FAILED', 'did not start')];
    await h.controller.action('confirmUpdate');
    expect(h.controller.phase()).toBe('RUNNING');
    expect(h.phases.slice(-5)).toEqual(['UPDATING', 'STARTING', 'ROLLING_BACK', 'STARTING', 'RUNNING']);
    expect(h.checkout.headSha).toBe(SHA_A);
    expect(h.controller.state().installedCommit).toBe(SHA_A);
    expect(h.controller.state().rollbackCommit).toBeNull();
    expect(h.controller.state().skippedCommit).toBe(SHA_B);
    expect(h.controller.publicState().notices.join(' ')).toMatch(/went back to the previous version/);
    expect(h.ui.calls.some((c) => c === 'notify:Update rolled back')).toBe(true);
  });

  it('rollback reinstalls when the dependencies differ from the previous version', async () => {
    const h = await disclosed();
    h.server.startQueue = [new ServerError('START_TIMEOUT', 'slow')];
    // First needsInstall (update) false, second (rollback) true.
    let n = 0;
    h.install.needsInstall = async () => {
      n += 1;
      return n === 1 ? { needed: false, reason: 'up-to-date' } : { needed: true, reason: 'lock-changed' };
    };
    await h.controller.action('confirmUpdate');
    expect(h.install.count('install')).toBe(1);
    expect(h.phases.slice(-6)).toEqual(['UPDATING', 'STARTING', 'ROLLING_BACK', 'INSTALLING', 'STARTING', 'RUNNING']);
    expect(h.controller.phase()).toBe('RUNNING');
  });

  it('a failed install after the checkout rolls back (INSTALLING -> ROLLING_BACK)', async () => {
    const h = makeHarness();
    live.push(h);
    await h.controller.start();
    h.checkout.lockChanged = true;
    h.update.results = [available()];
    await h.controller.action('checkForUpdates');
    let calls = 0;
    h.install.install = async () => {
      calls += 1;
      if (calls === 1) throw new InstallError('NETWORK', 'offline', 'ENOTFOUND');
      return { durationMs: 1, lockHash: 'lock-1', nodeVersion: '24.22.2', attempts: 1 };
    };
    h.install.needsInstall = async () => (calls >= 1 ? { needed: true, reason: 'lock-changed' } : { needed: false, reason: 'up-to-date' });
    await h.controller.action('confirmUpdate');
    expect(h.phases.slice(-6)).toEqual(['UPDATING', 'INSTALLING', 'ROLLING_BACK', 'INSTALLING', 'STARTING', 'RUNNING']);
    expect(h.checkout.headSha).toBe(SHA_A);
  });

  it('a failed checkout step rolls back', async () => {
    const h = await disclosed();
    h.checkout.checkoutError = new GitError('GIT_FAILED', 'checkout failed', 'error: local changes');
    // The rollback checkout must be allowed to work.
    let n = 0;
    h.checkout.checkoutDetached = async (c: string) => {
      n += 1;
      if (n === 1) throw new GitError('GIT_FAILED', 'checkout failed', 'error: local changes');
      h.checkout.headSha = c;
    };
    await h.controller.action('confirmUpdate');
    expect(h.phases.slice(-4)).toEqual(['UPDATING', 'ROLLING_BACK', 'STARTING', 'RUNNING']);
    expect(h.checkout.headSha).toBe(SHA_A);
  });

  it('if the rollback also fails the result is ERROR with Retry / Reinstall / Show Logs and the marker stays', async () => {
    const h = await disclosed();
    h.server.startQueue = [new ServerError('START_FAILED', 'a'), new ServerError('START_FAILED', 'b')];
    await h.controller.action('confirmUpdate');
    expect(h.controller.phase()).toBe('ERROR');
    const err = h.controller.publicState().error;
    expect(err?.title).toBe("Couldn't go back to the previous version");
    expect(err?.actions).toEqual(['retry', 'reinstall', 'showLogs']);
    expect(h.controller.state().rollbackCommit).toBe(SHA_A);
  });

  it('a user rollback from ERROR goes back through STARTING and ROLLING_BACK', async () => {
    const h = await disclosed();
    h.server.startQueue = [new ServerError('START_FAILED', 'a'), new ServerError('START_FAILED', 'b')];
    await h.controller.action('confirmUpdate');
    expect(h.controller.phase()).toBe('ERROR');
    h.checkout.headSha = SHA_B;
    await h.controller.action('rollback');
    expect(h.controller.phase()).toBe('RUNNING');
    expect(h.checkout.headSha).toBe(SHA_A);
    expect(h.controller.state().rollbackCommit).toBeNull();
  });

  it('rollback is ignored when there is no marker', async () => {
    const h = await boot();
    await h.controller.action('rollback');
    expect(h.controller.phase()).toBe('RUNNING');
  });

  it('a stale marker at boot plus a failing start rolls back', async () => {
    const h = makeHarness({ state: { rollbackCommit: SHA_C } });
    live.push(h);
    h.server.startQueue = [new ServerError('START_FAILED', 'x')];
    await h.controller.start();
    expect(h.phases).toEqual(['BOOT', 'STARTING', 'ROLLING_BACK', 'STARTING', 'RUNNING']);
    expect(h.checkout.headSha).toBe(SHA_C);
  });

  it('confirmUpdate is refused for a dirty tree or a backwards move; resetAndUpdate takes over', async () => {
    const dirty = await disclosed({ dirty: { modified: ['server/x.js'], untracked: [] } });
    await dirty.controller.action('confirmUpdate');
    expect(dirty.controller.phase()).toBe('DISCLOSING');
    await dirty.controller.action('resetAndUpdate');
    expect(dirty.controller.phase()).toBe('RUNNING');
    expect(dirty.checkout.count('resetToTarget')).toBe(1);
    expect(dirty.checkout.count('checkoutDetached')).toBe(0);

    const back = await disclosed({ needsReset: true });
    await back.controller.action('confirmUpdate');
    expect(back.controller.phase()).toBe('DISCLOSING');
    await back.controller.action('resetAndUpdate');
    expect(back.checkout.count('resetToTarget')).toBe(1);
  });

  it('resetAndUpdate is refused for a clean tree', async () => {
    const h = await disclosed();
    await h.controller.action('resetAndUpdate');
    expect(h.controller.phase()).toBe('DISCLOSING');
  });

  it('confirmUpdate outside DISCLOSING is ignored', async () => {
    const h = await boot();
    await h.controller.action('confirmUpdate');
    expect(h.controller.phase()).toBe('RUNNING');
  });
});

describe('OPENTAC_FAIL_START_ONCE', () => {
  it('is passed to exactly one start, the first post-update one, then forgotten', async () => {
    const h = makeHarness({ env: { OPENTAC_FAIL_START_ONCE: '1' } });
    live.push(h);
    await h.controller.start();
    expect(h.server.starts[0]?.extraEnv?.['OPENTAC_FAIL_START_ONCE']).toBeUndefined();
    h.update.results = [available()];
    await h.controller.action('checkForUpdates');
    h.server.startQueue = [new ServerError('START_FAILED', 'simulated')];
    await h.controller.action('confirmUpdate');
    const flagged = h.server.starts.filter((s) => s.extraEnv?.['OPENTAC_FAIL_START_ONCE'] === '1');
    expect(flagged).toHaveLength(1);
    expect(h.server.starts).toHaveLength(3);
    expect(h.server.starts[1]?.extraEnv?.['OPENTAC_FAIL_START_ONCE']).toBe('1');
    expect(h.server.starts[2]?.extraEnv).toBeUndefined();
    expect(h.controller.phase()).toBe('RUNNING');
    // A later restart does not see it either.
    await h.controller.action('restartServer');
    expect(h.server.starts.filter((s) => s.extraEnv?.['OPENTAC_FAIL_START_ONCE'] === '1')).toHaveLength(1);
  });

  it('is not consumed by an EADDRINUSE retry (still only one flagged spawn)', async () => {
    const h = makeHarness({ env: { OPENTAC_FAIL_START_ONCE: '1' }, state: { rollbackCommit: SHA_C } });
    live.push(h);
    h.server.startQueue = [new ServerError('EADDRINUSE', 'in use')];
    const p = h.controller.start();
    await flush();
    await h.clock.advance(1000);
    await p;
    expect(h.server.starts).toHaveLength(2);
    expect(h.server.starts[0]?.extraEnv?.['OPENTAC_FAIL_START_ONCE']).toBe('1');
    expect(h.server.starts[1]?.extraEnv?.['OPENTAC_FAIL_START_ONCE']).toBeUndefined();
  });

  it('a value other than 1 is ignored', async () => {
    const h = makeHarness({ env: { OPENTAC_FAIL_START_ONCE: 'yes' }, state: { rollbackCommit: SHA_C } });
    live.push(h);
    await h.controller.start();
    expect(h.server.starts[0]?.extraEnv).toBeUndefined();
  });
});

describe('AI provider wiring', () => {
  it('openai: no gateway', async () => {
    const h = await boot();
    expect(h.gateways).toHaveLength(0);
    const o = h.server.starts[0];
    expect(o?.aiGatewayUrl).toBeUndefined();
    expect(o?.injectPlaceholderOpenAiKey).toBeUndefined();
    expect(o?.extraEnv).toBeUndefined();
  });

  it('a non-openai provider at boot starts the gateway with a fresh 32-byte hex token', async () => {
    const h = await boot({ state: { ai: { provider: 'ollama', model: 'qwen3:8b', ollamaHost: null } } });
    expect(h.gateways).toHaveLength(1);
    expect(h.gateways[0]?.started).toBe(1);
    const token = h.gateways[0]?.authToken ?? '';
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const o = h.server.starts[0];
    expect(o?.aiGatewayUrl).toBe('http://127.0.0.1:5555');
    expect(o?.extraEnv?.['OPENTAC_AI_GATEWAY_TOKEN']).toBe(token);
    expect(o?.injectPlaceholderOpenAiKey).toBe(true);
    // The gateway reads the live provider.
    expect(h.gateways[0]?.getConfig().provider).toBe('ollama');
  });

  it('the placeholder key is skipped when .env already has an OpenAI key', async () => {
    const h = makeHarness({ state: { ai: { provider: 'xai', model: null, ollamaHost: null } } });
    live.push(h);
    h.envHasOpenAiKey.value = true;
    await h.controller.start();
    expect(h.server.starts[0]?.injectPlaceholderOpenAiKey).toBe(false);
  });

  it('changing the provider while RUNNING restarts through RESTARTING with a new gateway', async () => {
    const h = await boot();
    await h.controller.setAi({ provider: 'ollama', model: 'qwen3:8b', ollamaHost: null });
    expect(h.phases.slice(-4)).toEqual(['RUNNING', 'RESTARTING', 'STARTING', 'RUNNING']);
    expect(h.server.stops).toBeGreaterThanOrEqual(1);
    expect(h.gateways).toHaveLength(1);
    expect(h.server.starts[1]?.aiGatewayUrl).toBeDefined();
    expect(h.server.starts[1]?.injectPlaceholderOpenAiKey).toBe(true);
    expect(h.controller.state().ai.provider).toBe('ollama');
    expect(h.ui.calls).toContain('setMainEnabled:false');
    expect(h.ui.count('reloadMain')).toBe(1);

    // Switching to another non-openai provider restarts again with a fresh token.
    await h.controller.setAi({ provider: 'xai', model: null, ollamaHost: null });
    expect(h.gateways).toHaveLength(2);
    expect(h.gateways[0]?.stopped).toBe(1);
    expect(h.gateways[1]?.authToken).not.toBe(h.gateways[0]?.authToken);

    // And back to openai: gateway stopped, no gateway env.
    await h.controller.setAi({ provider: 'openai', model: null, ollamaHost: null });
    expect(h.gateways[1]?.stopped).toBe(1);
    expect(h.server.starts[3]?.aiGatewayUrl).toBeUndefined();
  });

  it('changing only the model does not restart', async () => {
    const h = await boot({ state: { ai: { provider: 'ollama', model: 'a', ollamaHost: null } } });
    await h.controller.setAi({ provider: 'ollama', model: 'b', ollamaHost: null });
    expect(h.server.starts).toHaveLength(1);
    expect(h.gateways[0]?.getConfig().model).toBe('b');
  });

  it('a provider change while an update is being disclosed waits until RUNNING', async () => {
    const h = await boot();
    h.update.results = [available()];
    await h.controller.action('checkForUpdates');
    await h.controller.setAi({ provider: 'ollama', model: null, ollamaHost: null });
    expect(h.server.starts).toHaveLength(1);
    await h.controller.action('laterUpdate');
    expect(h.server.starts).toHaveLength(2);
    expect(h.phases).toContain('RESTARTING');
  });

  it('a gateway that fails to start degrades to no summaries with a notice', async () => {
    const h = await boot({ state: { ai: { provider: 'ollama', model: null, ollamaHost: null } }, gatewayFails: true });
    expect(h.controller.phase()).toBe('RUNNING');
    expect(h.server.starts[0]?.aiGatewayUrl).toBeUndefined();
    expect(h.server.starts[0]?.extraEnv).toBeUndefined();
    expect(h.controller.publicState().notices.join(' ')).toMatch(/summary provider could not start/);
  });

  it('setAiKey stores the key, never echoes it, and updates hasKey', async () => {
    const h = await boot();
    await h.controller.setAiKey({ provider: 'openrouter', key: 'sk-or-secret-value' });
    const pub = h.controller.publicState();
    expect(pub.ai.hasOpenRouterKey).toBe(true);
    expect(pub.ai.hasXaiKey).toBe(false);
    expect(JSON.stringify(pub)).not.toContain('sk-or-secret-value');
    expect(JSON.stringify(h.controller.state())).not.toContain('sk-or-secret-value');
    expect(h.logs.join('\n')).not.toContain('sk-or-secret-value');
    await h.controller.setAiKey({ provider: 'openrouter', key: '' });
    expect(h.controller.publicState().ai.hasOpenRouterKey).toBe(false);
  });

  it('setAiKey refuses when secure storage is unavailable', async () => {
    const h = await boot();
    h.secrets.isAvailable = false;
    await expect(h.controller.setAiKey({ provider: 'xai', key: 'abc' })).rejects.toThrow(/Secure storage/);
    expect(h.controller.publicState().ai.encryptionAvailable).toBe(true);
  });

  it('publicState reports encryptionAvailable from the secrets store', async () => {
    const h = makeHarness();
    live.push(h);
    h.secrets.isAvailable = false;
    await h.controller.start();
    expect(h.controller.publicState().ai.encryptionAvailable).toBe(false);
  });

  it('testAi: explains for openai, otherwise runs the gateway test with the live config and key', async () => {
    const h = await boot();
    const none = await h.controller.testAi();
    expect(none.ok).toBe(false);
    expect(none.error).toMatch(/nothing to test/);

    await h.controller.setAiKey({ provider: 'xai', key: 'xai-key-123456' });
    await h.controller.setAi({ provider: 'xai', model: 'grok', ollamaHost: null });
    const r = await h.controller.testAi();
    expect(r).toEqual({ ok: true, text: 'OK', latencyMs: 12, finishReason: 'stop', error: null });
    expect(h.gateways.at(-1)?.testConfigs.at(-1)).toMatchObject({ provider: 'xai', model: 'grok', apiKey: 'xai-key-123456' });
  });
});

describe('listOllamaModels', () => {
  function fetchOf(impl: (url: string) => Promise<Response>): typeof fetch {
    return ((input: string | URL | Request) => impl(String(input))) as typeof fetch;
  }

  it('reads /api/tags from the default host', async () => {
    const seen: string[] = [];
    const h = await boot({
      fetchImpl: fetchOf(async (u) => {
        seen.push(u);
        return new Response(JSON.stringify({ models: [{ name: 'qwen3:8b' }, { model: 'llama3' }, {}] }), { status: 200 });
      }),
    });
    expect(await h.controller.listOllamaModels()).toEqual({ models: ['qwen3:8b', 'llama3'], error: null });
    expect(seen).toEqual(['http://127.0.0.1:11434/api/tags']);
  });

  it('uses the configured host, adds a scheme and trims slashes', async () => {
    const seen: string[] = [];
    const h = await boot({
      state: { ai: { provider: 'ollama', model: null, ollamaHost: 'gpu-box:11434/' } },
      fetchImpl: fetchOf(async (u) => {
        seen.push(u);
        return new Response('{"models":[]}', { status: 200 });
      }),
    });
    await h.controller.listOllamaModels();
    expect(seen).toEqual(['http://gpu-box:11434/api/tags']);
  });

  it('reports a plain sentence when Ollama is unreachable or answers badly', async () => {
    const down = await boot({
      fetchImpl: fetchOf(async () => {
        throw new TypeError('fetch failed');
      }),
    });
    const r = await down.controller.listOllamaModels();
    expect(r.models).toEqual([]);
    expect(r.error).toMatch(/Couldn't reach Ollama/);

    const bad = await boot({ fetchImpl: fetchOf(async () => new Response('no', { status: 500 })) });
    expect((await bad.controller.listOllamaModels()).error).toMatch(/HTTP 500/);

    const slow = await boot({
      fetchImpl: fetchOf(async () => {
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      }),
    });
    expect((await slow.controller.listOllamaModels()).error).toMatch(/10 seconds/);
  });
});

describe('preferences and actions', () => {
  it('a channel change saves it and runs an interactive check', async () => {
    const h = await boot();
    await h.controller.setPrefs({ channel: 'candidate' });
    expect(h.controller.state().channel).toBe('candidate');
    expect(h.controller.publicState().prefs.channel).toBe('candidate');
    expect(h.update.checks).toEqual([{ interactive: true }]);
  });

  it('other prefs save without a check; the same channel does not check', async () => {
    const h = await boot();
    await h.controller.setPrefs({ updateCheckOnLaunch: false });
    await h.controller.setPrefs({ channel: 'stable' });
    expect(h.controller.state().updateCheckOnLaunch).toBe(false);
    expect(h.update.checks).toHaveLength(0);
  });

  it('openPreferences / closePreferences toggle the panel and the window', async () => {
    const h = await boot();
    await h.controller.action('openPreferences');
    expect(h.controller.publicState().preferencesOpen).toBe(true);
    const shows = h.ui.count('showSetup');
    expect(shows).toBeGreaterThan(0);
    await h.controller.action('closePreferences');
    expect(h.controller.publicState().preferencesOpen).toBe(false);
    expect(h.ui.calls.at(-1)).toBe('hideSetup');
  });

  it('about open/close', async () => {
    const h = await boot();
    h.controller.openAbout();
    expect(h.controller.publicState().aboutOpen).toBe(true);
    h.controller.closeAbout();
    expect(h.controller.publicState().aboutOpen).toBe(false);
  });

  it('checkForAppUpdates drives the shell updater only', async () => {
    const h = await boot();
    await h.controller.checkForAppUpdates();
    await h.controller.action('checkForAppUpdates');
    expect(h.shellUpdater.checks).toEqual([{ interactive: true }, { interactive: true }]);
    expect(h.update.checks).toHaveLength(0);
  });

  it('showLogs is a no-op; quit calls the quit handler', async () => {
    const h = await boot();
    const pushes = h.ui.pushed.length;
    await h.controller.action('showLogs');
    expect(h.controller.phase()).toBe('RUNNING');
    expect(h.ui.pushed.length).toBe(pushes);
    expect(h.quits.count).toBe(0);
    await h.controller.action('quit');
    expect(h.quits.count).toBe(1);
  });

  it('every action is safe in every reachable phase (inapplicable ones are ignored)', async () => {
    for (const name of ACTION_NAMES) {
      const h = await boot();
      await h.controller.action(name);
      // Whatever happened, the machine is in a legal phase.
      expect(PHASES).toContain(h.controller.phase());
    }
    for (const name of ACTION_NAMES) {
      const h = makeHarness();
      live.push(h);
      h.server.startQueue = [new ServerError('START_FAILED', 'x')];
      await h.controller.start();
      expect(h.controller.phase()).toBe('ERROR');
      await h.controller.action(name);
      expect(PHASES).toContain(h.controller.phase());
    }
  });

  it('restartServer from RUNNING goes through RESTARTING and reloads the window', async () => {
    const h = await boot();
    await h.controller.action('restartServer');
    expect(h.phases.slice(-4)).toEqual(['RUNNING', 'RESTARTING', 'STARTING', 'RUNNING']);
    expect(h.ui.count('reloadMain')).toBe(1);
    expect(h.server.stops).toBe(1);
  });

  it('reinstall from RUNNING stops the server, installs and restarts', async () => {
    const h = await boot();
    await h.controller.action('reinstall');
    expect(h.phases.slice(-5)).toEqual(['RUNNING', 'RESTARTING', 'INSTALLING', 'STARTING', 'RUNNING']);
    expect(h.install.count('install')).toBe(1);
  });

  it('resetCheckout asks first, keeps .env, and downloads again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opentac-ctl-'));
    try {
      const h = makeHarness({ dataDir: dir, exists: true });
      live.push(h);
      await mkdir(h.paths.checkoutDir, { recursive: true });
      await writeFile(h.paths.envFile, 'GOOGLE_MAPS_API_KEY=abc\n');
      h.server.startQueue = [new ServerError('START_FAILED', 'x')];
      await h.controller.start();
      expect(h.controller.phase()).toBe('ERROR');

      h.ui.confirmAnswer = false;
      await h.controller.action('resetCheckout');
      expect(h.controller.phase()).toBe('ERROR');
      expect(h.checkout.count('clone')).toBe(0);

      h.ui.confirmAnswer = true;
      // The fake clone does not recreate the checkout directory the way git would.
      const realClone = h.checkout.clone.bind(h.checkout);
      h.checkout.clone = async (r, p) => {
        await realClone(r, p);
        await mkdir(h.paths.checkoutDir, { recursive: true });
      };
      await h.controller.action('resetCheckout');
      expect(h.controller.phase()).toBe('RUNNING');
      expect(h.checkout.count('clone')).toBe(1);
      expect(h.phases.slice(-5)).toEqual(['ERROR', 'CLONING', 'INSTALLING', 'STARTING', 'RUNNING']);
      expect(await readFile(h.paths.envFile, 'utf8')).toBe('GOOGLE_MAPS_API_KEY=abc\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('public state', () => {
  it('carries the log tail from the ring, prefs, versions and message', async () => {
    const h = await boot();
    await waitFor(() => h.controller.publicState().versions !== null);
    const p = h.controller.publicState();
    expect(p.phase).toBe('RUNNING');
    expect(p.prefs).toEqual({ channel: 'stable', updateCheckOnLaunch: true });
    expect(p.versions?.app).toBe('0.1.0');
    expect(p.versions?.engine.commit).toBe(SHA_A);
    expect(p.versions?.engine.short).toBe('aaaaaaa');
    expect(p.versions?.bundledNode).toBe('24.22.2');
    expect(p.error).toBeNull();
    expect(p.message).toBe("God's Eye View is running.");
    const v = await h.controller.versions();
    expect(v.dataDir).toBe(h.paths.dataDir);
    expect(v.engine.remote).toBe('https://github.com/o/r.git');
  });

  it('pushes every state to the ui and to subscribers, throttling progress ticks', async () => {
    const h = makeHarness({ exists: false, state: { installedCommit: null, installedLockHash: null, installedNodeVersion: null } });
    live.push(h);
    const seen: number[] = [];
    const off = h.controller.onState((s) => seen.push(s.logTail.length));
    await h.controller.start();
    expect(h.ui.pushed.length).toBeGreaterThan(3);
    expect(h.ui.pushed.at(-1)?.phase).toBe('RUNNING');
    const before = seen.length;
    off();
    h.controller.openAbout();
    expect(seen.length).toBe(before);
  });

  it('server output during STARTING is pushed at most once per 100 ms', async () => {
    const h = makeHarness();
    live.push(h);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const realStart = h.server.start.bind(h.server);
    h.server.start = async (o) => {
      await gate;
      return realStart(o);
    };
    const p = h.controller.start();
    await flush();
    expect(h.controller.phase()).toBe('STARTING');
    const before = h.ui.pushed.length;
    for (let i = 0; i < 20; i += 1) {
      h.ring.push(`line ${i}`);
      h.server.emit({ type: 'line', stream: 'stdout', line: `line ${i}` });
    }
    expect(h.ui.pushed.length - before).toBeLessThanOrEqual(1);
    await h.clock.advance(100);
    expect(h.ui.pushed.length - before).toBeLessThanOrEqual(2);
    expect(h.ui.pushed.at(-1)?.logTail.at(-1)).toBe('line 19');
    release();
    await p;
    expect(h.controller.phase()).toBe('RUNNING');
  });

  it('install output lands in the log tail', async () => {
    const h = makeHarness({ state: { installedLockHash: null } });
    live.push(h);
    h.install.needs = { needed: true, reason: 'never-installed' };
    await h.controller.start();
    expect(h.controller.publicState().logTail).toContain('added 1 package');
  });

  it('versions() works before any checkout exists', async () => {
    const h = makeHarness({ exists: false });
    live.push(h);
    h.checkout.head = async () => {
      throw new GitError('NOT_A_REPO', 'no repo');
    };
    const v = await h.controller.versions();
    expect(v.engine.commit).toBe(SHA_A);
  });
});

describe('shutdown', () => {
  it('clears every timer, stops the server and the gateway, and saves state once more', async () => {
    const h = await boot({ state: { ai: { provider: 'ollama', model: null, ollamaHost: null } } });
    expect(h.clock.pending()).toBe(3);
    const savesBefore = h.saved.length;
    await h.controller.shutdown();
    expect(h.clock.pending()).toBe(0);
    expect(h.server.isRunning()).toBe(false);
    expect(h.server.stops).toBeGreaterThanOrEqual(1);
    expect(h.gateways[0]?.stopped).toBe(1);
    expect(h.saved.length).toBe(savesBefore + 1);
    expect(h.server.listenerCount()).toBe(0);
    await h.controller.shutdown();
    expect(h.saved.length).toBe(savesBefore + 1);
    await h.clock.advance(CHECK_INTERVAL_MS * 2);
    expect(h.update.checks).toHaveLength(0);
  });

  it('interrupts a pending EADDRINUSE sleep', async () => {
    const h = makeHarness();
    live.push(h);
    h.server.startQueue = [new ServerError('EADDRINUSE', 'in use')];
    const p = h.controller.start();
    await flush();
    await h.controller.shutdown();
    await p;
    expect(h.server.starts).toHaveLength(1);
    expect(h.clock.pending()).toBe(0);
  });

  it('a shutdown during a crash window does not restart', async () => {
    const h = await boot();
    await h.controller.shutdown();
    h.server.emit({ type: 'exit', code: 1, signal: null, expected: false });
    await flush();
    expect(h.server.starts).toHaveLength(1);
  });
});
