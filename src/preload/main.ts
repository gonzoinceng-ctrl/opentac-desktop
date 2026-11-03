/**
 * Preload for the engine (main) window. Exposes `window.openTac` and nothing else.
 * Sandboxed preload: bundled by esbuild to CommonJS; only `electron` is required at runtime.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc.js';
import type { OpenTacMainApi } from '../shared/ipc.js';

const api: OpenTacMainApi = {
  getVersions: () => ipcRenderer.invoke(IPC.getVersions),
  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url),
  openLogsFolder: () => ipcRenderer.invoke(IPC.openLogsFolder),
};

contextBridge.exposeInMainWorld('openTac', api);
