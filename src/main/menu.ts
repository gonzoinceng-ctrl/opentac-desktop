import { readFile } from 'node:fs/promises';

import { app as electronApp, BrowserWindow, clipboard, Menu, shell } from 'electron';
import type { App, MenuItemConstructorOptions } from 'electron';

import { redact } from '../shared/redact.js';
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
  app?: Pick<App, 'getVersion' | 'getGPUInfo' | 'getGPUFeatureStatus' | 'setAboutPanelOptions' | 'showAboutPanel'>;
}

const DIAGNOSTIC_LOG_LINES = 50;

function openUrl(url: string, log: Logger): void {
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
    clipboard.writeText(redact(text));
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
            openUrl(url, log);
          }),
        },
        { label: 'Restart Server', click: run('restart server', () => controller.action('restartServer')) },
        { label: 'Reload Page', click: run('reload page', () => ui.reloadMain()) },
        { type: 'separator' },
        { label: 'Provider Settings Help', click: () => openUrl(urls.providerHelp, log) },
        {
          label: 'Show Logs',
          click: run('show logs', async () => {
            const err = await shell.openPath(paths.logsDir);
            if (err !== '') log.warn(`could not open the logs folder: ${err}`);
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
          label: 'Reset to Upstream…',
          click: run('reset checkout', async () => {
            const ok = await ui.confirm({
              title: 'Reset the engine?',
              message: 'Reset the engine to a clean copy of its source?',
              detail:
                'Any edits made inside the engine folder are discarded. Your API keys, settings and saved layers are not touched. Nothing you entered is lost.',
              confirmLabel: 'Reset',
              destructive: true,
            });
            if (ok) await controller.action('resetCheckout');
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
                const err = await shell.openPath(paths.dataDir);
                if (err !== '') log.warn(`could not open the data folder: ${err}`);
              }),
            },
            { label: 'Copy Diagnostics', click: run('copy diagnostics', copyDiagnostics) },
          ],
        },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'God’s Eye View README', click: () => openUrl(urls.upstreamReadme, log) },
        { label: 'Report an Engine Issue (upstream)', click: () => openUrl(urls.upstreamIssues, log) },
        { label: 'Report an App Issue', click: () => openUrl(urls.appIssues, log) },
        { type: 'separator' },
        { label: 'opentac.icu', click: () => openUrl(urls.site, log) },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  return menu;
}
