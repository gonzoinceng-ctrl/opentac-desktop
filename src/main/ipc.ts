import { homedir } from 'node:os';

import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent, Shell } from 'electron';

import {
  IPC,
  isActionName,
  isAppSettingsPatch,
  isClearEngineKeyPayload,
  isExternalUrl,
  isPrefsPatch,
  isSaveEngineKeyPayload,
  isSaveEngineSettingsPayload,
  isSetAiKeyPayload,
  isSetAiPayload,
  isUsbChoice,
} from '../shared/ipc.js';
import { redactHomeDir } from '../shared/redact.js';
import type { PublicState } from '../shared/ipc.js';
import type { ControllerApi } from './contracts.js';
import type { Logger } from './logger.js';
import type { Paths } from './paths.js';
import { isAllowedSender } from './policy.js';
import type { ShellUiFull } from './windows.js';

export { isAllowedSender } from './policy.js';

/** Options for {@link registerIpc}. */
export interface IpcOptions {
  controller: ControllerApi;
  ui: Pick<ShellUiFull, 'pushState' | 'usbPickerDevices' | 'chooseUsb' | 'engineOrigin'>;
  log: Logger;
  paths: Pick<Paths, 'logsDir' | 'dataDir'>;
  shell: Pick<Shell, 'openExternal' | 'openPath'>;
}

/** Minimum gap between two state pushes to the setup renderer. */
const PUSH_INTERVAL_MS = 100;

/**
 * Registers every channel of IPC with `ipcMain.handle`. Each handler checks the sender frame
 * ({@link isAllowedSender}) and the payload (guards from src/shared/ipc.ts) before acting, and
 * rejects with `Error('forbidden sender')` / `Error('invalid payload')`. Controller state is pushed
 * to the setup window, throttled to one push per 100 ms with a trailing push. Returns a disposer.
 */
export function registerIpc(opts: IpcOptions): () => void {
  const { controller, ui, shell, paths } = opts;
  const log = opts.log.scope('ipc');

  function guard(event: IpcMainInvokeEvent, channel: string): void {
    const url = event.senderFrame?.url ?? null;
    if (!isAllowedSender(url, channel, ui.engineOrigin())) {
      log.warn(`refused ${channel} from ${(url ?? 'an unknown frame').slice(0, 80)}`);
      throw new Error('forbidden sender');
    }
  }

  const registered: string[] = [];
  function handle(
    channel: string,
    fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      guard(event, channel);
      try {
        return await fn(event, ...args);
      } catch (err) {
        if (err instanceof Error && (err.message === 'invalid payload' || err.message === 'forbidden sender')) {
          throw err;
        }
        log.error(err instanceof Error ? err : String(err));
        throw new Error(err instanceof Error ? err.message.split('\n')[0] ?? 'Something went wrong.' : 'Something went wrong.');
      }
    });
    registered.push(channel);
  }

  function invalid(): never {
    throw new Error('invalid payload');
  }

  const openFolder = async (what: string, dir: string): Promise<void> => {
    log.info(`opening the ${what}: ${redactHomeDir(dir, homedir())}`);
    const err = await shell.openPath(dir);
    if (err !== '') log.warn(`could not open the ${what}: ${err}`);
    else log.info(`opened the ${what}`);
  };

  // Shared with the engine window.
  handle(IPC.getVersions, () => controller.versions());
  handle(IPC.openExternal, async (_e, url) => {
    if (!isExternalUrl(url)) invalid();
    await shell.openExternal(url);
  });
  handle(IPC.openLogsFolder, async () => {
    await openFolder('logs folder', paths.logsDir);
  });

  // Setup window only.
  handle(IPC.getState, () => controller.publicState());
  handle(IPC.action, async (_e, name) => {
    if (!isActionName(name)) invalid();
    if (name === 'showLogs') {
      await openFolder('logs folder', paths.logsDir);
      return;
    }
    if (name === 'openDataFolder') {
      await openFolder('data folder', paths.dataDir);
      return;
    }
    await controller.action(name);
  });
  handle(IPC.setPrefs, async (_e, patch) => {
    if (!isPrefsPatch(patch)) invalid();
    await controller.setPrefs(patch);
  });
  handle(IPC.setAi, async (_e, payload) => {
    if (!isSetAiPayload(payload)) invalid();
    await controller.setAi(payload);
  });
  handle(IPC.setAiKey, async (_e, payload) => {
    if (!isSetAiKeyPayload(payload)) invalid();
    await controller.setAiKey(payload);
  });
  handle(IPC.testAi, () => controller.testAi());
  handle(IPC.setAppSettings, async (_e, patch) => {
    if (!isAppSettingsPatch(patch)) invalid();
    await controller.setAppSettings(patch);
  });
  handle(IPC.getEngineKeys, () => controller.getEngineKeys());
  handle(IPC.saveEngineKey, (_e, payload) => {
    if (!isSaveEngineKeyPayload(payload)) invalid();
    return controller.saveEngineKey(payload);
  });
  handle(IPC.clearEngineKey, (_e, payload) => {
    if (!isClearEngineKeyPayload(payload)) invalid();
    return controller.clearEngineKey(payload);
  });
  handle(IPC.getEngineSettings, () => controller.getEngineSettings());
  handle(IPC.saveEngineSettings, (_e, payload) => {
    if (!isSaveEngineSettingsPayload(payload)) invalid();
    return controller.saveEngineSettings(payload);
  });
  handle(IPC.listOllamaModels, () => controller.listOllamaModels());

  // USB chooser page.
  handle(IPC.usbPickerList, () => ui.usbPickerDevices());
  handle(IPC.usbPickerChoose, (_e, choice) => {
    if (!isUsbChoice(choice)) invalid();
    ui.chooseUsb(choice);
  });

  // Controller -> setup renderer, throttled with a trailing push.
  let lastPush = 0;
  let pending: PublicState | null = null;
  let timer: NodeJS.Timeout | null = null;
  const flush = (): void => {
    timer = null;
    if (pending === null) return;
    const state = pending;
    pending = null;
    lastPush = Date.now();
    ui.pushState(state);
  };
  const unsubscribe = controller.onState((state) => {
    pending = state;
    const wait = PUSH_INTERVAL_MS - (Date.now() - lastPush);
    if (wait <= 0 && timer === null) flush();
    else timer ??= setTimeout(flush, Math.max(wait, 0));
  });

  return () => {
    unsubscribe();
    if (timer !== null) clearTimeout(timer);
    timer = null;
    for (const channel of registered) ipcMain.removeHandler(channel);
  };
}
