/**
 * Updates for the OpenTac app itself (Electron shell) through electron-updater and GitHub Releases
 * (docs/SHELL-DESIGN.md section 4). This is separate from the engine (God's Eye View) updates:
 * every string here says "OpenTac" or "the app", never "engine".
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { ShellUpdaterApi, ShellUi } from './contracts.js';
import type { Logger } from './logger.js';

/** Options for {@link createShellUpdater}. */
export interface ShellUpdaterOptions {
  ui: Pick<ShellUi, 'confirm' | 'notify'>;
  log: Logger;
  isPackaged: boolean;
  /**
   * True when the app carries its electron-updater feed config (`Resources/app-update.yml`, written
   * by dmg/zip builds only). Defaults to looking for that file next to the app.
   */
  hasUpdateConfig?: () => boolean;
  /** Stops the engine and flushes state; awaited before quitAndInstall. */
  beforeQuitAndInstall: () => Promise<void>;
}

/** The slice of electron-updater's AppUpdater this module drives. */
interface UpdaterLike {
  autoDownload: boolean;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  logger: unknown;
  checkForUpdates(): Promise<{ isUpdateAvailable?: boolean; updateInfo: { version: string } } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

function errorLine(err: unknown): string {
  return err instanceof Error ? err.message.split('\n')[0] ?? 'Unknown error' : String(err);
}

/** Loads electron-updater lazily; the default import is destructured (CJS getter export). */
async function loadUpdater(): Promise<UpdaterLike> {
  const mod = (await import('electron-updater')) as unknown as {
    default: { autoUpdater: UpdaterLike };
  };
  const { autoUpdater } = mod.default;
  return autoUpdater;
}

/** Shown when this build cannot update itself (dev run, or a `--dir` pack without a feed file). */
export const APP_UPDATES_UNAVAILABLE = {
  title: 'App updates are not available here',
  message: 'App updates are only available in the installed release build of OpenTac.',
  detail: 'This copy was not installed from an OpenTac release. Download the latest release from the OpenTac website to get updates.',
} as const;

function defaultHasUpdateConfig(): boolean {
  const res = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return res !== undefined && existsSync(join(res, 'app-update.yml'));
}

/** Creates the app updater. Inactive (check() only logs) when the app is not packaged. */
export function createShellUpdater(opts: ShellUpdaterOptions): ShellUpdaterApi {
  const log = opts.log.scope('app-update');
  let updater: UpdaterLike | null = null;
  let busy = false;
  let downloaded = false;

  async function getUpdater(): Promise<UpdaterLike> {
    if (updater !== null) return updater;
    const u = await loadUpdater();
    u.autoDownload = false;
    u.allowDowngrade = false;
    u.allowPrerelease = false;
    u.logger = {
      info: (m: unknown) => log.info(String(m)),
      warn: (m: unknown) => log.warn(String(m)),
      error: (m: unknown) => log.error(String(m)),
      debug: (m: unknown) => log.debug(String(m)),
    };
    updater = u;
    return u;
  }

  async function offerRestart(version: string): Promise<void> {
    const restart = await opts.ui.confirm({
      title: 'Restart to update',
      message: `OpenTac ${version} is ready to install.`,
      detail: 'OpenTac will close, update itself and open again.',
      confirmLabel: 'Restart to Update',
    });
    if (!restart) {
      log.info('restart for the app update postponed by the user');
      return;
    }
    await opts.beforeQuitAndInstall();
    (await getUpdater()).quitAndInstall(false, true);
  }

  async function runCheck(interactive: boolean): Promise<void> {
    const u = await getUpdater();
    log.info(`checking for app updates (${interactive ? 'interactive' : 'background'})`);
    const result = await u.checkForUpdates();
    if (result === null || result.isUpdateAvailable !== true) {
      log.info('OpenTac is up to date');
      if (interactive) {
        await opts.ui.notify({ title: 'OpenTac is up to date', message: 'You are using the newest version of OpenTac.' });
      }
      return;
    }
    const version = result.updateInfo.version;
    if (downloaded) {
      await offerRestart(version);
      return;
    }
    const download = await opts.ui.confirm({
      title: 'OpenTac update available',
      message: `OpenTac ${version} is available. Download now?`,
      detail: 'The update downloads in the background. OpenTac asks before it restarts.',
      confirmLabel: 'Download',
    });
    if (!download) {
      log.info(`app update ${version} declined for now`);
      return;
    }
    log.info(`downloading app update ${version}`);
    await u.downloadUpdate();
    downloaded = true;
    log.info(`app update ${version} downloaded`);
    await offerRestart(version);
  }

  return {
    async check({ interactive }) {
      const hasConfig = opts.hasUpdateConfig ?? defaultHasUpdateConfig;
      if (!opts.isPackaged || !hasConfig()) {
        log.info(
          opts.isPackaged
            ? 'app update check skipped: this build has no app-update.yml (not a release install)'
            : 'app update check skipped (unpackaged)',
        );
        if (interactive) await opts.ui.notify({ ...APP_UPDATES_UNAVAILABLE }).catch(() => undefined);
        return;
      }
      if (busy) {
        log.info('app update check already in progress');
        return;
      }
      busy = true;
      try {
        await runCheck(interactive);
      } catch (err) {
        log.warn(`app update check failed: ${errorLine(err)}`);
        if (interactive) {
          await opts.ui
            .notify({
              title: "Couldn't check for OpenTac updates",
              message: 'OpenTac could not reach GitHub to look for a new version.',
              detail: errorLine(err),
            })
            .catch(() => undefined);
        }
      } finally {
        busy = false;
      }
    },

    pending: () => downloaded,

    quitAndInstall() {
      if (!downloaded || updater === null) {
        log.warn('quitAndInstall called without a downloaded app update');
        return;
      }
      updater.quitAndInstall(false, true);
    },
  };
}
