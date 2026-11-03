/**
 * Wires the real CheckoutManager, InstallManager (fake npm-cli) and ServerManager (fake launcher)
 * to the real controller on top of the fixture mirror. Only the UI, secrets and shell updater are
 * fakes. Used by test/integration/update-flow.test.ts.
 */
import { spawn as realSpawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCheckoutManager } from '../../src/main/checkout.js';
import { createController, type ShellController } from '../../src/main/controller.js';
import { createInstallManager } from '../../src/main/install.js';
import { resolvePaths, type Paths } from '../../src/main/paths.js';
import { findFreePort, isPortFree } from '../../src/main/ports.js';
import { createRingBuffer } from '../../src/main/ringBuffer.js';
import { createServerManager, type ServerManager } from '../../src/main/server.js';
import { defaultState, saveState } from '../../src/main/state.js';
import type { Phase } from '../../src/shared/ipc.js';
import { createCheckoutFixture, type CheckoutFixture } from './checkout-fixture.js';
import { FakeSecrets, FakeShellUpdater, FakeUi } from './core-fakes.js';

const NPM_CLI = fileURLToPath(new URL('./core-fake-npm-cli.cjs', import.meta.url));
const LAUNCHER = fileURLToPath(new URL('./core-launcher.mjs', import.meta.url));

export interface CoreIntegration {
  fixture: CheckoutFixture;
  paths: Paths;
  controller: ShellController;
  server: ServerManager;
  ui: FakeUi;
  phases: Phase[];
  children: ChildProcess[];
  /** Resolves once `cond()` holds (polling), else throws. */
  until(cond: () => boolean, ms?: number): Promise<void>;
  /** Shuts the controller down, kills strays, removes the temp tree. */
  cleanup(): Promise<void>;
}

export async function createCoreIntegration(
  opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<CoreIntegration> {
  const fixture = await createCheckoutFixture();
  const dataDir = join(fixture.root, 'data');
  const home = join(fixture.root, 'home');
  await mkdir(dataDir, { recursive: true });
  const base = resolvePaths({
    userData: dataDir,
    logs: join(fixture.root, 'logs'),
    resourcesPath: join(fixture.root, 'resources'),
    appRoot: fixture.root,
    isPackaged: false,
    arch: 'arm64',
    env: {},
  });
  const paths: Paths = { ...base, nodeBin: process.execPath, npmCli: NPM_CLI, launcherScript: LAUNCHER };

  const log = fixture.log;
  const ring = createRingBuffer(300);
  const children: ChildProcess[] = [];
  const checkout = createCheckoutManager({ checkoutDir: paths.checkoutDir, git: fixture.git, log });
  const install = createInstallManager({
    paths,
    log,
    env: { HOME: home, TMPDIR: fixture.root },
    retryDelayMs: 10,
  });
  const server = createServerManager({
    nodeBin: paths.nodeBin,
    launcherScript: paths.launcherScript,
    checkoutDir: paths.checkoutDir,
    log,
    ring,
    spawnImpl: ((...args: Parameters<typeof realSpawn>) => {
      const child = realSpawn(...args);
      children.push(child);
      return child;
    }) as typeof realSpawn,
  });

  const ui = new FakeUi();
  const portStart = 47000 + Math.floor(Math.random() * 2000);
  const controller = createController({
    paths,
    log,
    // Pin the summary provider to OpenAI so no AI gateway is started in these flows
    // (the product default is Ollama; gateway behaviour has its own unit tests).
    initialState: {
      ...defaultState(),
      remoteUrl: fixture.mirrorUrl,
      ai: { provider: 'openai', model: null, ollamaHost: null },
    },
    saveState: (s) => saveState(paths.stateFile, s),
    checkout,
    install,
    server,
    ring,
    gatewayFactory: () => {
      throw new Error('the gateway must not be created for the openai provider');
    },
    secrets: new FakeSecrets(),
    ui,
    shellUpdater: new FakeShellUpdater(),
    appVersion: '0.1.0',
    electronVersion: '45.2.1',
    chromiumVersion: '156.0.0',
    env: opts.env ?? {},
    isPackaged: false,
    diskFree: async () => 100 * 1024 ** 3,
    ports: {
      isPortFree: (p) => isPortFree(p),
      findFreePort: () => findFreePort({ rangeStart: portStart, rangeEnd: portStart + 500 }),
    },
  });
  const phases: Phase[] = [];
  controller.onState((s) => {
    if (phases[phases.length - 1] !== s.phase) phases.push(s.phase);
  });

  return {
    fixture,
    paths,
    controller,
    server,
    ui,
    phases,
    children,
    async until(cond, ms = 15_000) {
      const end = Date.now() + ms;
      while (!cond()) {
        if (Date.now() > end) throw new Error('until() timed out');
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    async cleanup() {
      try {
        await controller.shutdown();
      } finally {
        for (const child of children) {
          if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch {
              try {
                child.kill('SIGKILL');
              } catch {
                // already gone
              }
            }
          }
        }
        await fixture.cleanup();
      }
    },
  };
}

/** True while the process exists. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw err;
  }
}
