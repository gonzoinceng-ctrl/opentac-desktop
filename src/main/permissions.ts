/**
 * Session permission handlers (docs/SHELL-DESIGN.md section 7). Only types are imported from
 * electron so this module can be exercised with fakes; the verdicts come from policy.ts.
 */
import type { Session, SystemPreferences } from 'electron';

import type { UsbDevicePublic } from '../shared/ipc.js';
import type { UsbDeviceId } from '../shared/types.js';
import type { Logger } from './logger.js';
import { decidePermission, matchUsbDevice, originOf } from './policy.js';
import type { RememberedUsbDevice } from './policy.js';

/** Options for {@link installPermissionHandlers}. */
export interface PermissionOptions {
  session: Pick<
    Session,
    'setPermissionCheckHandler' | 'setPermissionRequestHandler' | 'setDevicePermissionHandler' | 'on'
  >;
  /** `http://127.0.0.1:<port>` while an engine is known, else null. */
  engineOrigin: () => string | null;
  rememberedUsb: () => UsbDeviceId[];
  rememberUsb: (d: RememberedUsbDevice) => void;
  /** Shows the chooser; resolves with the chosen deviceId or null. */
  pickUsb: (devices: UsbDevicePublic[]) => Promise<string | null>;
  systemPreferences: Pick<SystemPreferences, 'askForMediaAccess' | 'getMediaAccessStatus'>;
  log: Logger;
  /** Plain information dialog (microphone guidance, "no USB device found"). */
  notify?: (opts: { title: string; message: string; detail?: string }) => Promise<void>;
}

/** The pieces of Chromium's USB device record this module reads. */
interface UsbDeviceRecord {
  deviceId: string;
  vendorId: number;
  productId: number;
  productName?: string | undefined;
  serialNumber?: string | undefined;
}

function toPublic(d: UsbDeviceRecord): UsbDevicePublic {
  return {
    deviceId: d.deviceId,
    vendorId: d.vendorId,
    productId: d.productId,
    productName: d.productName ?? null,
    serialNumber: d.serialNumber ?? null,
  };
}

/** Installs the check, request and device handlers and the WebUSB chooser on `session`. */
export function installPermissionHandlers(opts: PermissionOptions): void {
  const log = opts.log.scope('permissions');
  let micGuidanceShown = false;

  async function showMicGuidance(): Promise<void> {
    if (micGuidanceShown || opts.notify === undefined) return;
    micGuidanceShown = true;
    try {
      await opts.notify({
        title: 'Microphone access is turned off',
        message: 'OpenTac cannot use the microphone because access was denied.',
        detail:
          'To use voice control, open System Settings, choose Privacy & Security, then Microphone, and turn on OpenTac. Then restart OpenTac.',
      });
    } catch (err) {
      log.warn(`microphone guidance dialog failed: ${String(err)}`);
    }
  }

  opts.session.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    const mediaType = details.mediaType;
    const allowed = decidePermission(
      permission,
      requestingOrigin,
      opts.engineOrigin(),
      mediaType !== undefined ? { mediaTypes: [mediaType] } : {},
    );
    if (!allowed) log.debug(`check denied: ${permission}`);
    return allowed;
  });

  opts.session.setPermissionRequestHandler((wc, permission, callback, details) => {
    const origin =
      ('securityOrigin' in details && typeof details.securityOrigin === 'string'
        ? details.securityOrigin
        : undefined) ??
      details.requestingUrl ??
      wc.getURL();
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined;
    const allowed = decidePermission(
      permission,
      origin,
      opts.engineOrigin(),
      mediaTypes !== undefined ? { mediaTypes } : {},
    );
    if (!allowed) {
      log.info(`request denied: ${permission} from ${originOf(origin) ?? 'unknown origin'}`);
      callback(false);
      return;
    }
    if (permission !== 'media') {
      callback(true);
      return;
    }
    // Audio-only media for the engine: the operating system has the final say.
    void (async () => {
      try {
        const status = opts.systemPreferences.getMediaAccessStatus('microphone');
        if (status === 'granted') {
          callback(true);
          return;
        }
        if (status === 'denied' || status === 'restricted') {
          log.info('microphone is blocked in System Settings');
          callback(false);
          await showMicGuidance();
          return;
        }
        const granted = await opts.systemPreferences.askForMediaAccess('microphone');
        log.info(`microphone access ${granted ? 'granted' : 'declined'} by the user`);
        callback(granted);
        if (!granted) await showMicGuidance();
      } catch (err) {
        log.warn(`microphone request failed: ${String(err)}`);
        callback(false);
      }
    })();
  });

  opts.session.on('select-usb-device', (event, details, callback) => {
    event.preventDefault();
    const devices = details.deviceList.map(toPublic);
    if (devices.length === 0) {
      log.info('USB chooser opened with no devices present');
      callback();
      void opts.notify?.({
        title: 'No USB device found',
        message: 'OpenTac could not find a USB device to connect.',
        detail: 'Plug in the device, then try connecting again.',
      });
      return;
    }
    void (async () => {
      let chosen: string | null = null;
      try {
        chosen = await opts.pickUsb(devices);
      } catch (err) {
        log.warn(`USB chooser failed: ${String(err)}`);
      }
      const device = chosen === null ? undefined : devices.find((d) => d.deviceId === chosen);
      if (device === undefined) {
        callback();
        return;
      }
      callback(device.deviceId);
      const remembered: RememberedUsbDevice = {
        vendorId: device.vendorId,
        productId: device.productId,
        productName: device.productName,
        ...(device.serialNumber !== null && device.serialNumber !== ''
          ? { serialNumber: device.serialNumber }
          : {}),
      };
      try {
        opts.rememberUsb(remembered);
      } catch (err) {
        log.warn(`could not remember the USB device: ${String(err)}`);
      }
    })();
  });

  opts.session.setDevicePermissionHandler((details) => {
    if (details.deviceType !== 'usb') return false;
    const engine = opts.engineOrigin();
    if (engine === null || originOf(details.origin) !== engine) return false;
    const device = details.device as UsbDeviceRecord;
    return opts.rememberedUsb().some((r) => matchUsbDevice(r, device));
  });
  // setUSBProtectedClassesHandler is deliberately not set (DECISIONS round two).
}
