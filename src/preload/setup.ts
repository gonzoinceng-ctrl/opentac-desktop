/**
 * Preload for the setup window. Exposes `window.openTacSetup` and nothing else.
 * Sandboxed preload: bundled by esbuild to CommonJS; only `electron` is required at runtime.
 * The raw ipcRenderer (and its events) are never handed to the page.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { IPC } from '../shared/ipc.js';
import type {
  ActionName,
  OpenTacSetupApi,
  Prefs,
  PublicState,
  SetAiKeyPayload,
  SetAiPayload,
} from '../shared/ipc.js';

const api: OpenTacSetupApi = {
  getVersions: () => ipcRenderer.invoke(IPC.getVersions),
  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url),
  openLogsFolder: () => ipcRenderer.invoke(IPC.openLogsFolder),
  getState: () => ipcRenderer.invoke(IPC.getState),
  onState: (cb: (state: PublicState) => void) => {
    const listener = (_event: IpcRendererEvent, state: PublicState): void => {
      cb(state);
    };
    ipcRenderer.on(IPC.stateEvent, listener);
    return () => {
      ipcRenderer.removeListener(IPC.stateEvent, listener);
    };
  },
  action: (name: ActionName) => ipcRenderer.invoke(IPC.action, name),
  setPrefs: (patch: Partial<Prefs>) => ipcRenderer.invoke(IPC.setPrefs, patch),
  setAi: (payload: SetAiPayload) => ipcRenderer.invoke(IPC.setAi, payload),
  setAiKey: (payload: SetAiKeyPayload) => ipcRenderer.invoke(IPC.setAiKey, payload),
  testAi: () => ipcRenderer.invoke(IPC.testAi),
  listOllamaModels: () => ipcRenderer.invoke(IPC.listOllamaModels),
};

contextBridge.exposeInMainWorld('openTacSetup', api);
