import { dirname, join } from 'node:path';

import { app, BrowserWindow, dialog, screen, shell } from 'electron';
import type { WebContents } from 'electron';

import { IPC, isExternalUrl } from '../shared/ipc.js';
import type { Phase, PublicState, UsbDevicePublic } from '../shared/ipc.js';
import type { ShellState, WindowBounds } from '../shared/types.js';
import type { ShellUi } from './contracts.js';
import type { Logger } from './logger.js';
import { decideNavigation, originOf, SETUP_ORIGIN, validateBounds } from './policy.js';

/** Options for {@link createShellUi}. */
export interface ShellUiOptions {
  /** Absolute path of dist/preload/setup.cjs. */
  setupPreload: string;
  /** Absolute path of dist/preload/main.cjs. */
  mainPreload: string;
  /** `app://setup/index.html`. */
  setupUrl: string;
  /** `app://setup/usb-picker.html`. */
  usbPickerUrl: string;
  log: Logger;
  state: () => ShellState;
  saveBounds: (b: WindowBounds) => void;
  /** Asked when the user closes the setup window while the engine is not RUNNING. */
  onSetupCloseWhileNotRunning: () => Promise<'quit' | 'keep'>;
  /** Called when the main window gains focus (rate-limited update check in the controller). */
  onMainFocus?: () => void;
}

/** The windows layer: the controller-facing {@link ShellUi} plus what main-process wiring needs. */
export type ShellUiFull = ShellUi & {
  setupWindow(): BrowserWindow | null;
  mainWindow(): BrowserWindow | null;
  /** Shows the USB chooser; resolves with the chosen deviceId, or null when closed without choosing. */
  showUsbPicker(devices: UsbDevicePublic[]): Promise<string | null>;
  /** Devices currently offered in the USB chooser (empty when none is open). */
  usbPickerDevices(): UsbDevicePublic[];
  /** Resolves the open USB chooser with a choice (null cancels) and closes it. */
  chooseUsb(deviceId: string | null): void;
  /** The engine origin set by the controller (`http://127.0.0.1:<port>`), or null. */
  engineOrigin(): string | null;
  /** Lets every window close for real: call once the app is going to quit. */
  markQuitting(): void;
};

const SETUP_SIZE = { width: 760, height: 560 };
const SETUP_MIN = { width: 600, height: 440 };
const MAIN_SIZE = { width: 1440, height: 900 };
const MAIN_MIN = { width: 1024, height: 640 };
const PICKER_SIZE = { width: 460, height: 420 };
const BOUNDS_DEBOUNCE_MS = 500;
const RETRY_INTERVAL_MS = 500;
const RETRY_WINDOW_MS = 15_000;
const RENDER_RELOAD_THROTTLE_MS = 10_000;
/** Chromium net error for a refused connection (net::ERR_CONNECTION_REFUSED). */
const ERR_CONNECTION_REFUSED = -102;

const WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  spellcheck: false,
} as const;

function safeOpenExternal(url: string, log: Logger): void {
  if (!isExternalUrl(url)) {
    log.warn('refused to hand a non-https/mailto URL to the system');
    return;
  }
  // Test hook (e2e): log instead of handing the URL to the system browser.
  if (process.env['OPENTAC_E2E_NO_EXTERNAL'] === '1') {
    log.info(`E2E: openExternal suppressed for ${url}`);
    return;
  }
  shell.openExternal(url).catch((err: unknown) => {
    log.warn(`openExternal failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/**
 * Installs navigation guards on `wc`: top-level navigations and redirects are checked with
 * {@link decideNavigation} (engine origin stays, https/mailto go to the system browser, the rest is
 * denied); `window.open` is always denied after routing https/mailto to the system browser.
 * Sub-frame navigations are only blocked when they would be denied; an https embed is not
 * "external" because it never replaces the app.
 */
function installNavigationGuards(wc: WebContents, origin: () => string | null, log: Logger): void {
  const handleTopLevel = (event: { preventDefault(): void }, url: string): void => {
    const verdict = decideNavigation(url, origin());
    if (verdict === 'allow') return;
    event.preventDefault();
    if (verdict === 'external') safeOpenExternal(url, log);
    else log.warn(`blocked navigation to ${url.slice(0, 80)}`);
  };
  wc.on('will-navigate', (details) => {
    if (details.isMainFrame) handleTopLevel(details, details.url);
  });
  wc.on('will-redirect', (details) => {
    if (details.isMainFrame) handleTopLevel(details, details.url);
  });
  // Fires for every frame; the main frame is already handled by will-navigate, so only sub-frames here.
  wc.on('will-frame-navigate', (details) => {
    if (details.isMainFrame) return;
    if (decideNavigation(details.url, origin()) === 'deny') {
      details.preventDefault();
      log.warn(`blocked sub-frame navigation to ${details.url.slice(0, 80)}`);
    }
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (decideNavigation(url, origin()) === 'external') safeOpenExternal(url, log);
    return { action: 'deny' };
  });
}

/** Creates the windows layer. No window exists until the controller asks for one. */
export function createShellUi(opts: ShellUiOptions): ShellUiFull {
  const log = opts.log.scope('windows');
  const usbPreload = join(dirname(opts.setupPreload), 'usb.cjs');

  let setupWin: BrowserWindow | null = null;
  let mainWin: BrowserWindow | null = null;
  let pickerWin: BrowserWindow | null = null;
  let setupWanted = false;
  let quitting = false;
  let lastPhase: Phase = 'BOOT';
  let engineOrigin: string | null = null;
  let engineUrl: string | null = null;
  let closePromptOpen = false;
  let pickerDevices: UsbDevicePublic[] = [];
  let pickerResolve: ((id: string | null) => void) | null = null;
  let lastRenderReload = 0;

  app.on('before-quit', () => {
    quitting = true;
  });

  // ----- setup window -----

  function createSetup(): BrowserWindow {
    const win = new BrowserWindow({
      ...SETUP_SIZE,
      minWidth: SETUP_MIN.width,
      minHeight: SETUP_MIN.height,
      resizable: true,
      show: false,
      titleBarStyle: 'default',
      title: 'OpenTac',
      webPreferences: { ...WEB_PREFERENCES, preload: opts.setupPreload },
    });
    installNavigationGuards(win.webContents, () => SETUP_ORIGIN, log);
    win.once('ready-to-show', () => {
      if (setupWanted && !win.isDestroyed()) win.show();
    });
    win.on('close', (event) => {
      if (quitting) return;
      event.preventDefault();
      if (lastPhase === 'RUNNING') {
        win.hide();
        return;
      }
      if (closePromptOpen) return;
      closePromptOpen = true;
      opts
        .onSetupCloseWhileNotRunning()
        .then((choice) => {
          if (choice === 'quit') {
            quitting = true;
            app.quit();
          }
        })
        .catch((err: unknown) => log.warn(`close prompt failed: ${String(err)}`))
        .finally(() => {
          closePromptOpen = false;
        });
    });
    win.on('closed', () => {
      if (setupWin === win) setupWin = null;
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      log.error(`setup renderer gone (${details.reason})`);
    });
    win.loadURL(opts.setupUrl).catch((err: unknown) => {
      log.error(`setup window failed to load ${opts.setupUrl}: ${String(err)}`);
    });
    return win;
  }

  // ----- main window -----

  function boundsForMain(): WindowBounds {
    const saved = opts.state().mainWindowBounds;
    const probe =
      saved !== null && saved.x !== undefined && saved.y !== undefined
        ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
        : undefined;
    const display = probe !== undefined ? screen.getDisplayMatching(probe) : screen.getPrimaryDisplay();
    return validateBounds(saved, display.workArea, MAIN_SIZE, MAIN_MIN);
  }

  function createMain(url: string): BrowserWindow {
    const bounds = boundsForMain();
    const win = new BrowserWindow({
      ...bounds,
      minWidth: MAIN_MIN.width,
      minHeight: MAIN_MIN.height,
      show: false,
      backgroundColor: '#0a0a0f',
      title: 'OpenTac',
      webPreferences: {
        ...WEB_PREFERENCES,
        autoplayPolicy: 'no-user-gesture-required',
        preload: opts.mainPreload,
      },
    });
    if (bounds.x === undefined) win.center();
    const wc = win.webContents;
    installNavigationGuards(wc, () => engineOrigin, log);

    let saveTimer: NodeJS.Timeout | null = null;
    const saveNow = (): void => {
      if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
      opts.saveBounds(win.getNormalBounds());
    };
    const scheduleSave = (): void => {
      if (saveTimer !== null) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = null;
        saveNow();
      }, BOUNDS_DEBOUNCE_MS);
    };
    win.on('focus', () => opts.onMainFocus?.());
    win.on('resize', scheduleSave);
    win.on('move', scheduleSave);
    win.on('close', () => {
      if (saveTimer !== null) clearTimeout(saveTimer);
      saveTimer = null;
      saveNow();
    });
    win.on('closed', () => {
      if (mainWin === win) mainWin = null;
    });
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.show();
    });

    // Vite restarts after an API-key save: the page's origin refuses connections for a moment.
    let retryStart: number | null = null;
    let retryTimer: NodeJS.Timeout | null = null;
    wc.on('did-finish-load', () => {
      retryStart = null;
    });
    wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      const refused = errorCode === ERR_CONNECTION_REFUSED || errorDescription === 'ERR_CONNECTION_REFUSED';
      const target = engineUrl;
      const sameOrigin = target !== null && originOf(validatedURL) === originOf(target);
      if (!refused || target === null || !sameOrigin) {
        log.warn(`main window failed to load (${errorDescription}, ${errorCode})`);
        return;
      }
      const now = Date.now();
      retryStart ??= now;
      if (now - retryStart > RETRY_WINDOW_MS) {
        log.warn('the engine did not answer within 15 s; no longer retrying');
        retryStart = null;
        return;
      }
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (win.isDestroyed() || engineUrl === null) return;
        win.loadURL(engineUrl).catch(() => undefined);
      }, RETRY_INTERVAL_MS);
    });
    win.on('closed', () => {
      if (retryTimer !== null) clearTimeout(retryTimer);
    });
    wc.on('render-process-gone', (_e, details) => {
      log.error(`main renderer gone (${details.reason})`);
      const now = Date.now();
      if (details.reason !== 'clean-exit' && now - lastRenderReload > RENDER_RELOAD_THROTTLE_MS) {
        lastRenderReload = now;
        if (!win.isDestroyed()) win.webContents.reload();
      }
    });

    win.loadURL(url).catch((err: unknown) => {
      log.warn(`main window load of ${url} was interrupted: ${String(err)}`);
    });
    return win;
  }

  // ----- dialogs -----

  function dialogParent(): BrowserWindow | undefined {
    for (const w of [setupWin, mainWin]) {
      if (w !== null && !w.isDestroyed() && w.isVisible()) return w;
    }
    return undefined;
  }

  async function showBox(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
    const parent = dialogParent();
    return parent !== undefined ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
  }

  // ----- USB picker -----

  function sendPickerDevices(): void {
    if (pickerWin !== null && !pickerWin.isDestroyed() && !pickerWin.webContents.isLoading()) {
      pickerWin.webContents.send(IPC.usbPickerEvent, pickerDevices);
    }
  }

  function settlePicker(id: string | null): void {
    const resolve = pickerResolve;
    pickerResolve = null;
    if (resolve !== null) resolve(id);
  }

  function showUsbPicker(devices: UsbDevicePublic[]): Promise<string | null> {
    // A new request supersedes an open chooser.
    settlePicker(null);
    pickerDevices = devices;
    const result = new Promise<string | null>((resolve) => {
      pickerResolve = resolve;
    });
    if (pickerWin !== null && !pickerWin.isDestroyed()) {
      sendPickerDevices();
      pickerWin.focus();
      return result;
    }
    const parent = mainWin !== null && !mainWin.isDestroyed() ? mainWin : undefined;
    const win = new BrowserWindow({
      ...PICKER_SIZE,
      ...(parent !== undefined ? { parent, modal: true } : {}),
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: 'Choose a USB device',
      webPreferences: { ...WEB_PREFERENCES, preload: usbPreload },
    });
    pickerWin = win;
    installNavigationGuards(win.webContents, () => SETUP_ORIGIN, log);
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.show();
    });
    win.webContents.on('did-finish-load', sendPickerDevices);
    win.on('closed', () => {
      if (pickerWin === win) pickerWin = null;
      settlePicker(null);
      pickerDevices = [];
    });
    win.loadURL(opts.usbPickerUrl).catch((err: unknown) => {
      log.error(`USB picker failed to load: ${String(err)}`);
      settlePicker(null);
      if (!win.isDestroyed()) win.close();
    });
    return result;
  }

  // ----- ShellUi -----

  return {
    showSetup() {
      setupWanted = true;
      if (setupWin === null || setupWin.isDestroyed()) {
        setupWin = createSetup();
        return;
      }
      if (setupWin.isMinimized()) setupWin.restore();
      setupWin.show();
      setupWin.focus();
    },

    hideSetup() {
      setupWanted = false;
      if (setupWin !== null && !setupWin.isDestroyed()) setupWin.hide();
    },

    showMain(url) {
      engineUrl = url;
      engineOrigin = originOf(url) ?? engineOrigin;
      if (mainWin === null || mainWin.isDestroyed()) {
        mainWin = createMain(url);
        return;
      }
      if (mainWin.isMinimized()) mainWin.restore();
      if (originOf(mainWin.webContents.getURL()) !== originOf(url)) {
        mainWin.loadURL(url).catch(() => undefined);
      }
      mainWin.show();
      mainWin.focus();
    },

    setMainEnabled(enabled) {
      if (mainWin !== null && !mainWin.isDestroyed()) mainWin.setEnabled(enabled);
    },

    reloadMain() {
      if (mainWin === null || mainWin.isDestroyed()) return;
      if (engineUrl !== null && mainWin.webContents.getURL() === '') {
        mainWin.loadURL(engineUrl).catch(() => undefined);
      } else {
        mainWin.webContents.reload();
      }
    },

    hasMain() {
      return mainWin !== null && !mainWin.isDestroyed();
    },

    pushState(state: PublicState) {
      lastPhase = state.phase;
      if (setupWin !== null && !setupWin.isDestroyed() && !setupWin.webContents.isDestroyed()) {
        setupWin.webContents.send(IPC.stateEvent, state);
      }
    },

    setEngineOrigin(origin) {
      engineOrigin = origin;
      if (origin === null) engineUrl = null;
    },

    async confirm({ title, message, detail, confirmLabel, destructive }) {
      const res = await showBox({
        type: destructive === true ? 'warning' : 'question',
        title,
        message,
        ...(detail !== undefined ? { detail } : {}),
        buttons: [confirmLabel, 'Cancel'],
        defaultId: destructive === true ? 1 : 0,
        cancelId: 1,
        noLink: true,
      });
      return res.response === 0;
    },

    async notify({ title, message, detail }) {
      await showBox({
        type: 'info',
        title,
        message,
        ...(detail !== undefined ? { detail } : {}),
        buttons: ['OK'],
        defaultId: 0,
        noLink: true,
      });
    },

    setupWindow: () => (setupWin !== null && !setupWin.isDestroyed() ? setupWin : null),
    mainWindow: () => (mainWin !== null && !mainWin.isDestroyed() ? mainWin : null),
    showUsbPicker,
    usbPickerDevices: () => pickerDevices,
    chooseUsb(deviceId) {
      settlePicker(deviceId);
      if (pickerWin !== null && !pickerWin.isDestroyed()) pickerWin.close();
    },
    engineOrigin: () => engineOrigin,
    markQuitting() {
      quitting = true;
    },
  };
}
