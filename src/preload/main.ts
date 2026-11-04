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

// Recovery from a dead globe: Cesium shows `.cesium-widget-errorPanel` after a render-loop error and
// stops rendering for good. Tell the main process (one-way) so it can reload the page.
let lastReport = 0;
function reportRenderError(): void {
  const panel = document.querySelector('.cesium-widget-errorPanel');
  if (panel === null) return;
  const now = Date.now();
  if (now - lastReport < 5000) return;
  lastReport = now;
  ipcRenderer.send(IPC.renderError, (panel.textContent ?? '').slice(0, 500));
}
setInterval(reportRenderError, 2000);
