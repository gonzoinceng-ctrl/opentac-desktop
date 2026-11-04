import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';

import { app as electronApp, BrowserWindow, clipboard, Menu, shell } from 'electron';
import type { App, MenuItemConstructorOptions } from 'electron';

import { redact, redactHomeDir } from '../shared/redact.js';
import type { ControllerApi } from './contracts.js';
import type { Logger } from './logger.js';
import type { Paths } from './paths.js';
import type { ShellUiFull } from './windows.js';

/** The attribution line shown wherever the brief requires it. */
export const ATTRIBUTION =
  "OpenTac is an unofficial desktop app for God's Eye View by Bilawal Sidhu (MIT)";

/** External destinations used by the Help and Engine menus. */
export interface MenuUrls {
  upstreamReadme: string;
  upstreamIssues: string;
  appIssues: string;
  site: string;
  providerHelp: string;
}

/** Options for {@link buildMenu}. */
export interface MenuOptions {
  controller: ControllerApi & { openAbout?: () => void };
  ui: Pick<ShellUiFull, 'showSetup' | 'reloadMain' | 'notify' | 'confirm' | 'mainWindow'>;
  log: Logger;
  urls: MenuUrls;
  paths: Pick<Paths, 'dataDir' | 'logsDir' | 'mainLog'>;
  /** Defaults to Electron's app.isPackaged; the OPENTAC_E2E_NO_EXTERNAL hook only works unpackaged. */
  isPackaged?: boolean;
  app?: Pick<App, 'getVersion' | 'getGPUInfo' | 'getGPUFeatureStatus' | 'setAboutPanelOptions' | 'showAboutPanel'>;
}

const DIAGNOSTIC_LOG_LINES = 50;

function openUrl(url: string, log: Logger, suppress: boolean): void {
  if (suppress) {
    log.info(`E2E: openExternal suppressed for ${url}`);
    return;
  }
  shell.openExternal(url).catch((err: unknown) => log.warn(`could not open ${url}: ${String(err)}`));
}

/** Last `n` lines of a text file, or an empty list when it cannot be read. */
async function tailFile(file: string, n: number): Promise<string[]> {
  try {
    const text = await readFile(file, 'utf8');
    return text.split('\n').filter((l) => l !== '').slice(-n);
  } catch {
    return [];
  }
}

/**
 * Builds and installs the application menu (docs/SHELL-DESIGN.md section 11). Every click handler
 * catches its own errors so a failed action is logged, never an unhandled rejection.
 */
export function buildMenu(opts: MenuOptions): Menu {
  const { controller, ui, urls, paths } = opts;
  const app = opts.app ?? electronApp;
  const log = opts.log.scope('menu');
  const suppressExternal = !(opts.isPackaged ?? electronApp.isPackaged) && process.env['OPENTAC_E2E_NO_EXTERNAL'] === '1';
  const openExternalUrl = (url: string): void => openUrl(url, log, suppressExternal);
  const openFolder = async (what: string, dir: string): Promise<void> => {
    log.info(`opening the ${what}: ${redactHomeDir(dir, homedir())}`);
    const err = await shell.openPath(dir);
    if (err !== '') log.warn(`could not open the ${what}: ${err}`);
    else log.info(`opened the ${what}`);
  };

  const run = (label: string, fn: () => Promise<void> | void): (() => void) => {
    return () => {
      Promise.resolve()
        .then(fn)
        .catch((err: unknown) => log.error(`menu action "${label}" failed: ${err instanceof Error ? err.message : String(err)}`));
    };
  };

  async function showAbout(): Promise<void> {
    if (controller.openAbout !== undefined) {
      controller.openAbout();
      return;
    }
    const versions = await controller.versions();
    app.setAboutPanelOptions({
      applicationName: 'OpenTac',
      applicationVersion: versions.app,
      version: `Electron ${versions.electron}, engine ${versions.engine.short ?? 'not installed'}`,
      copyright: ATTRIBUTION,
      credits: `${ATTRIBUTION}. Source and licences: https://github.com/bilawalsidhu/gods-eye-view`,
    });
    app.showAboutPanel();
  }

  async function gpuStatus(): Promise<void> {
    await app.getGPUInfo('basic');
    const status = app.getGPUFeatureStatus();
    const text = JSON.stringify(status, null, 2);
    log.info(`GPU feature status: ${JSON.stringify(status)}`);
    await ui.notify({
      title: 'Graphics status',
      message: 'GPU feature status was written to the log.',
      detail: text,
    });
  }

  async function copyDiagnostics(): Promise<void> {
    const v = await controller.versions();
    const lines = await tailFile(paths.mainLog, DIAGNOSTIC_LOG_LINES);
    const text = [
      `OpenTac ${v.app}`,
      `Electron ${v.electron}, Chromium ${v.chromium}, bundled Node ${v.bundledNode}`,
      `Engine: ${v.engine.commit ?? 'not installed'} (${v.engine.channel}, ${v.engine.upstreamTag ?? 'no tag'})`,
      `Phase: ${controller.phase()}`,
      '',
      `Last ${lines.length} log lines:`,
      ...lines,
    ].join('\n');
    clipboard.writeText(redactHomeDir(redact(text), homedir()));
    log.info('diagnostics copied to the clipboard');
  }

  const template: MenuItemConstructorOptions[] = [
    {
      label: 'OpenTac',
      submenu: [
        { label: 'About OpenTac…', click: run('about', showAbout) },
        { type: 'separator' },
        { label: 'Check for App Updates…', click: run('check app updates', () => controller.checkForAppUpdates()) },
        {
          label: 'Preferences…',
          accelerator: 'CommandOrControl+,',
          click: run('preferences', async () => {
            ui.showSetup();
            await controller.action('openPreferences');
          }),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Engine',
      submenu: [
        { label: 'Check for Engine Updates…', click: run('check engine updates', () => controller.checkForEngineUpdates()) },
        { type: 'separator' },
        {
          label: 'Open in Browser',
          click: run('open in browser', async () => {
            const url = controller.engineUrl();
            if (url === null) {
              await ui.notify({ title: 'Not running yet', message: 'The engine is not running, so there is nothing to open.' });
              return;
            }
            openExternalUrl(url);
          }),
        },
        { label: 'Restart Server', click: run('restart server', () => controller.action('restartServer')) },
        { label: 'Reload Page', click: run('reload page', () => ui.reloadMain()) },
        { type: 'separator' },
        { label: 'Provider Settings Help', click: () => openExternalUrl(urls.providerHelp) },
        {
          label: 'Show Logs',
          click: run('show logs', async () => {
            await openFolder('logs folder', paths.logsDir);
          }),
        },
        { type: 'separator' },
        {
          label: 'Reinstall Dependencies…',
          click: run('reinstall', async () => {
            const ok = await ui.confirm({
              title: 'Reinstall dependencies?',
              message: 'Reinstall the engine dependencies?',
              detail: 'OpenTac stops the server and installs the dependencies again. This can take several minutes and needs an internet connection.',
              confirmLabel: 'Reinstall',
            });
            if (ok) await controller.action('reinstall');
          }),
        },
        {
          label: 'Download Engine Again…',
          click: run('reset checkout', async () => {
            // The controller asks for confirmation itself (one dialog) and only acts in ERROR.
            if (controller.phase() !== 'ERROR') {
              await ui.notify({
                title: 'Download the engine again',
                message: 'This is only available when the engine shows an error.',
                detail:
                  'The engine is not in an error state, so there is nothing to repair. Use Reinstall Dependencies… or Check for Engine Updates… instead.',
              });
              return;
            }
            await controller.action('resetCheckout');
          }),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CommandOrControl+R', click: run('reload', () => ui.reloadMain()) },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        {
          label: 'Developer',
          submenu: [
            {
              label: 'Toggle DevTools',
              accelerator: 'Alt+CommandOrControl+I',
              click: run('devtools', () => {
                const win = BrowserWindow.getFocusedWindow() ?? ui.mainWindow();
                win?.webContents.toggleDevTools();
              }),
            },
            { label: 'GPU Status', click: run('gpu status', gpuStatus) },
            {
              label: 'Open Data Folder',
              click: run('open data folder', async () => {
                await openFolder('data folder', paths.dataDir);
              }),
            },
            { label: 'Copy Diagnostics', click: run('copy diagnostics', copyDiagnostics) },
          ],
        },
      ],
    },
    {
      label: 'Window',
      role: 'windowMenu',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'close' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
    {
      role: 'help',
      submenu: [
        { label: 'God’s Eye View README', click: () => openExternalUrl(urls.upstreamReadme) },
        { label: 'Report an Engine Issue (upstream)', click: () => openExternalUrl(urls.upstreamIssues) },
        { label: 'Report an App Issue', click: () => openExternalUrl(urls.appIssues) },
        { type: 'separator' },
        { label: 'opentac.icu', click: () => openExternalUrl(urls.site) },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  return menu;
}
