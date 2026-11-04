/**
 * OpenTac main-process entry (docs/SHELL-DESIGN.md section 1).
 *
 * Top level runs synchronously and never awaits app.whenReady(): scheme registration, command-line
 * switches, the app name and the single-instance lock. Everything else happens in boot().
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { arch as processArch, homedir, platform } from 'node:os';
import { extname, join, resolve } from 'node:path';

import {
  app,
  powerMonitor,
  protocol,
  safeStorage,
  session,
  shell,
  systemPreferences,
} from 'electron';

import type { ShellState, WindowBounds } from '../shared/types.js';
import { proxyEnvFor } from '../shared/appSettings.js';
import { redactHomeDir } from '../shared/redact.js';
import { createAiGateway } from './aiGateway.js';
import { createCheckoutManager } from './checkout.js';
import { createController, resolveDevOverrides } from './controller.js';
import type { ShellController } from './controller.js';
import { createGitRunner } from './git.js';
import { createInstallManager } from './install.js';
import { registerIpc } from './ipc.js';
import { createElectronLogSink, createLogger, createServerLogWriter, resolveLogLevels } from './logger.js';
import type { Logger, ServerLogWriter } from './logger.js';
import { buildMenu } from './menu.js';
import { ensureDataDirs, resolvePaths } from './paths.js';
import type { Paths } from './paths.js';
import { installPermissionHandlers } from './permissions.js';
import { isWithinDir, sameUsbIdentity, toRememberedUsb } from './policy.js';
import type { RememberedUsbDevice } from './policy.js';
import { createRingBuffer } from './ringBuffer.js';
import { createSecrets } from './secrets.js';
import { createServerManager } from './server.js';
import { createShellUpdater } from './shellUpdate.js';
import { loadStateReport, readLogLevelSetting, saveState } from './state.js';
import { createShellUi } from './windows.js';

// ---------------------------------------------------------------------------
// Synchronous top level
// ---------------------------------------------------------------------------

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Unpackaged runs get their own name so that their Keychain item ("OpenTac Dev Safe Storage") and
// default userData never collide with the installed, Developer ID-signed app: a keychain item made
// under one code signature raises a password prompt for the other (DECISIONS 2026-11-04).
app.setName(app.isPackaged ? 'OpenTac' : 'OpenTac Dev');

// A dev/test run with OPENTAC_DATA_DIR keeps Chromium's profile and the logs inside that directory
// so it neither touches nor collides with a real installation (single-instance lock included).
if (!app.isPackaged && (process.env['OPENTAC_DATA_DIR'] ?? '') !== '') {
  const dataDir = resolve(process.env['OPENTAC_DATA_DIR'] as string);
  app.setPath('userData', join(dataDir, 'electron-user-data'));
  app.setPath('logs', join(dataDir, 'logs'));
}

const URLS = {
  upstreamReadme: 'https://github.com/bilawalsidhu/gods-eye-view#readme',
  upstreamIssues: 'https://github.com/bilawalsidhu/gods-eye-view/issues',
  appIssues: 'https://github.com/gonzoinceng-ctrl/opentac-desktop/issues',
  site: 'https://opentac.icu',
  providerHelp: 'https://github.com/bilawalsidhu/gods-eye-view#readme',
} as const;

/** Time the engine gets to stop at quit before the app exits anyway. */
const SHUTDOWN_CAP_MS = 8000;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

let controllerRef: ShellController | null = null;
let logRef: Logger | null = null;
let focusWindow: (() => void) | null = null;
let quitting = false;
let shutdownDone = false;
let serverLogRef: ServerLogWriter | null = null;

/** Stops the engine (idempotent) with the 8 s cap; never rejects. */
async function shutdownWithCap(): Promise<void> {
  if (shutdownDone) return;
  const controller = controllerRef;
  if (controller !== null) {
    let timer: NodeJS.Timeout | undefined;
    const cap = new Promise<'timeout'>((res) => {
      timer = setTimeout(() => res('timeout'), SHUTDOWN_CAP_MS);
    });
    try {
      const outcome = await Promise.race([controller.shutdown().then(() => 'done' as const), cap]);
      if (outcome === 'timeout') logRef?.warn(`shutdown did not finish within ${SHUTDOWN_CAP_MS} ms; exiting anyway`);
    } catch (err) {
      logRef?.error(`shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  shutdownDone = true;
  // After the engine is down so its final lines (and the exit marker) are flushed to server.log.
  try {
    await serverLogRef?.close();
  } catch (err) {
    logRef?.error(`closing server.log failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => focusWindow?.());
  app.on('window-all-closed', () => {
    // macOS: the server keeps running and the Dock icon stays until an explicit Quit.
    if (platform() !== 'darwin') app.quit();
  });
  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    if (shutdownDone || controllerRef === null) return;
    event.preventDefault();
    void shutdownWithCap().finally(() => app.exit(0));
  });
  app.whenReady().then(boot).catch((err: unknown) => {
    console.error('OpenTac failed to start:', err);
    app.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/** Dev/test overrides for the runtime binaries; ignored when packaged. */
function applyDevOverrides(paths: Paths, env: NodeJS.ProcessEnv): Paths {
  const o = resolveDevOverrides(env, app.isPackaged);
  return {
    ...paths,
    ...(o.launcherScript !== undefined ? { launcherScript: resolve(o.launcherScript) } : {}),
    ...(o.nodeBin !== undefined ? { nodeBin: resolve(o.nodeBin) } : {}),
    ...(o.npmCli !== undefined ? { npmCli: resolve(o.npmCli) } : {}),
  };
}

function registerAppProtocol(rendererRoot: string, log: Logger): void {
  protocol.handle('app', async (request) => {
    const notFound = new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return notFound;
    }
    if (url.host !== 'setup') return notFound;
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return notFound;
    }
    if (pathname === '/' || pathname === '') pathname = '/index.html';
    const file = join(rendererRoot, pathname);
    if (!isWithinDir(rendererRoot, file)) {
      log.warn(`app:// request outside the renderer directory refused: ${pathname.slice(0, 80)}`);
      return notFound;
    }
    try {
      const body = await readFile(file);
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        },
      });
    } catch {
      return notFound;
    }
  });
}

async function boot(): Promise<void> {
  const resolvedPaths = resolvePaths({
    userData: app.getPath('userData'),
    logs: app.getPath('logs'),
    resourcesPath: process.resourcesPath,
    appRoot: app.getAppPath(),
    isPackaged: app.isPackaged,
    arch: processArch() === 'arm64' ? 'arm64' : 'x64',
  });
  const paths = applyDevOverrides(resolvedPaths, process.env);
  ensureDataDirs(paths);

  // OPENTAC_LOG_LEVEL wins, then the App settings level (applies at next launch), then the defaults.
  const logLevelSetting = await readLogLevelSetting(paths.stateFile);
  const sink = await createElectronLogSink(resolveLogLevels(process.env, app.isPackaged, logLevelSetting));
  // electron-log picks its own default location; pin the file to Paths.mainLog so that Copy
  // Diagnostics, "Show Logs" and an OPENTAC_DATA_DIR run all agree on one place.
  const electronLog = (await import('electron-log/main.js')).default;
  electronLog.transports.file.resolvePathFn = () => paths.mainLog;
  const log = createLogger(sink);
  logRef = log;
  log.info(`OpenTac ${app.getVersion()} starting (electron ${process.versions.electron}, packaged ${app.isPackaged})`);
  log.info(`data directory ${paths.dataDir}`);

  // State. The controller is the single writer of everything except two fields that only the
  // windows and permission layers learn about: the main window bounds and remembered USB devices.
  // Those live here and are overlaid onto every save, so neither side can overwrite the other.
  const stateReport = await loadStateReport(paths.stateFile, paths.stateBackupFile, log);
  const initialState: ShellState = stateReport.state;
  let windowBounds: WindowBounds | null = initialState.mainWindowBounds;
  // Entries keep productName in memory (state.ts cannot persist it yet; see DECISIONS).
  let usbDevices: RememberedUsbDevice[] = initialState.usbDevices;
  let saveChain: Promise<void> = Promise.resolve();
  const overlay = (s: ShellState): ShellState => ({ ...s, mainWindowBounds: windowBounds, usbDevices });
  const persistState = (s: ShellState): Promise<void> => {
    const snapshot = overlay(s);
    saveChain = saveChain.catch(() => undefined).then(() => saveState(paths.stateFile, snapshot));
    return saveChain;
  };

  const rendererRoot = join(app.getAppPath(), 'dist', 'renderer', 'setup');
  registerAppProtocol(rendererRoot, log);

  // Engine plumbing.
  // Proxy from App settings, read per call so a change applies to the next git or npm command.
  const proxyEnv = (): Record<string, string> => proxyEnvFor((controllerRef?.state() ?? initialState).app.proxy);
  const git = createGitRunner({ gitDir: paths.gitDir, log: log.scope('git'), proxyEnv });
  // Once per launch: which git binary dugite will run (PKG-5), home directory shown as ~.
  {
    const gitBin = join(paths.gitDir, 'bin', 'git');
    log.info(
      `git: ${redactHomeDir(gitBin, homedir())} (${existsSync(gitBin) ? 'present' : 'MISSING'}; dugite LOCAL_GIT_DIRECTORY)`,
    );
  }
  const checkout = createCheckoutManager({ checkoutDir: paths.checkoutDir, git, log: log.scope('checkout') });
  const install = createInstallManager({ paths, log: log.scope('install'), proxyEnv });
  const ring = createRingBuffer();
  const server = createServerManager({
    nodeBin: paths.nodeBin,
    launcherScript: paths.launcherScript,
    checkoutDir: paths.checkoutDir,
    log: log.scope('server'),
    ring,
  });
  // Tee of the engine's stdout/stderr plus ready/exit markers (brief 03 section 4.9); redacted, 10 MB x 5.
  const serverLog = createServerLogWriter({ file: paths.serverLog });
  serverLogRef = serverLog;
  server.onEvent((e) => {
    if (e.type === 'line') serverLog.write(`[gev:${e.stream}] ${e.line}`);
    else if (e.type === 'ready') serverLog.write(`[gev:shell] ready url=${e.url} port=${e.port} pid=${e.pid}`);
    else {
      serverLog.write(
        `[gev:shell] exit code=${e.code ?? 'null'} signal=${e.signal ?? 'null'} expected=${String(e.expected)}`,
      );
    }
  });
  const secrets = createSecrets({
    file: join(paths.dataDir, 'secrets.json'),
    safeStorage: {
      isEncryptionAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
      encryptStringAsync: (plain) => safeStorage.encryptStringAsync(plain),
      decryptStringAsync: (data) => safeStorage.decryptStringAsync(data),
    },
    log,
  });
  // Deliberately no secrets.available() here: on a Mac whose login keychain holds an 'OpenTac Safe
  // Storage' item made by a differently signed build, the first safeStorage call raises a password
  // prompt. Boot must not wait on it (DECISIONS 2026-11-04); the controller probes it in the
  // background, with a timeout, after the setup window is up.

  // Windows.
  const ui = createShellUi({
    setupPreload: join(app.getAppPath(), 'dist', 'preload', 'setup.cjs'),
    mainPreload: join(app.getAppPath(), 'dist', 'preload', 'main.cjs'),
    setupUrl: 'app://setup/index.html',
    usbPickerUrl: 'app://setup/usb-picker.html',
    log,
    state: () => overlay(controllerRef?.state() ?? initialState),
    saveBounds: (bounds) => {
      windowBounds = bounds;
      persistState(controllerRef?.state() ?? initialState).catch((err: unknown) => log.warn(`could not save window bounds: ${String(err)}`));
    },
    onMainFocus: () => controllerRef?.notifyMainFocus(),
    onSetupCloseWhileNotRunning: async () => {
      const quit = await ui.confirm({
        title: 'Quit OpenTac?',
        message: 'OpenTac is still getting ready. Quit anyway?',
        detail: 'Setup continues the next time you open OpenTac.',
        confirmLabel: 'Quit',
        destructive: true,
      });
      return quit ? 'quit' : 'keep';
    },
  });
  focusWindow = () => {
    const win = ui.mainWindow() ?? ui.setupWindow();
    if (win === null) {
      ui.showSetup();
      return;
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };

  const shellUpdater = createShellUpdater({
    ui,
    log,
    isPackaged: app.isPackaged,
    beforeQuitAndInstall: async () => {
      // quitAndInstall closes windows before before-quit: stop the engine first, then let them close.
      await shutdownWithCap();
      quitting = true;
      ui.markQuitting();
    },
  });

  const controller = createController({
    paths,
    log,
    ui,
    shellUpdater,
    initialState,
    ...(stateReport.reset
      ? {
          startupNotice: `OpenTac's settings file was damaged and was reset${stateReport.salvaged.length > 0 ? ` (kept: ${stateReport.salvaged.join(', ')})` : ''}. A copy was saved as state.json.bak in the data folder. Check Preferences if something looks different.`,
        }
      : {}),
    saveState: persistState,
    secrets,
    checkout,
    install,
    server,
    ring,
    gatewayFactory: ({ getConfig, authToken }) => createAiGateway({ getConfig, log: log.scope('gateway'), authToken }),
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    chromiumVersion: process.versions.chrome,
    env: process.env,
    isPackaged: app.isPackaged,
    requestQuit: () => app.quit(),
    setLoginItem: (openAtLogin) => {
      // An unpackaged run would register the bare Electron binary as a login item.
      if (!app.isPackaged) {
        log.info(`launch at login not changed: this build is not packaged (wanted ${String(openAtLogin)})`);
        return;
      }
      app.setLoginItemSettings({ openAtLogin });
    },
    forgetUsbDevices: () => {
      usbDevices = [];
    },
  });
  controllerRef = controller;

  // Wiring.
  installPermissionHandlers({
    session: session.defaultSession,
    engineOrigin: () => ui.engineOrigin(),
    rememberedUsb: () => usbDevices,
    rememberUsb: (d) => {
      const entry = toRememberedUsb(d);
      if (usbDevices.some((u) => sameUsbIdentity(u, entry))) return;
      usbDevices = [...usbDevices, entry];
      persistState(controller.state()).catch((err: unknown) => log.warn(`could not save the USB device: ${String(err)}`));
    },
    pickUsb: (devices) => ui.showUsbPicker(devices),
    systemPreferences,
    log,
    notify: (o) => ui.notify(o),
  });
  buildMenu({ controller, ui, log, urls: URLS, paths, app });
  registerIpc({ controller, ui, log, paths, shell });

  app.on('activate', () => {
    if (controller.phase() === 'RUNNING') {
      const url = controller.engineUrl();
      if (url !== null) {
        ui.showMain(url);
        return;
      }
    }
    ui.showSetup();
  });
  // The controller rate-limits these background checks (once per 6 h) and ignores them outside RUNNING.
  powerMonitor.on('resume', () => controller.notifyResume());

  // The controller shows the setup window when it has something to say; this is the safety net for
  // a boot that is not quick, so the user never stares at an app with no window.
  setTimeout(() => {
    if (controller.phase() !== 'RUNNING' && !ui.hasMain()) ui.showSetup();
  }, 400).unref();
  await controller.start();
}
