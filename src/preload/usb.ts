/**
 * Preload for the USB device picker page. Exposes `window.openTacUsb` and nothing else.
 * Sandboxed preload: bundled by esbuild to CommonJS; only `electron` is required at runtime.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { IPC } from '../shared/ipc.js';
import type { OpenTacUsbApi, UsbDevicePublic } from '../shared/ipc.js';

const api: OpenTacUsbApi = {
  list: () => ipcRenderer.invoke(IPC.usbPickerList),
  onDevices: (cb: (devices: UsbDevicePublic[]) => void) => {
    const listener = (_event: IpcRendererEvent, devices: UsbDevicePublic[]): void => {
      cb(devices);
    };
    ipcRenderer.on(IPC.usbPickerEvent, listener);
    return () => {
      ipcRenderer.removeListener(IPC.usbPickerEvent, listener);
    };
  },
  choose: (deviceId: string | null) => ipcRenderer.invoke(IPC.usbPickerChoose, deviceId),
};

contextBridge.exposeInMainWorld('openTacUsb', api);
