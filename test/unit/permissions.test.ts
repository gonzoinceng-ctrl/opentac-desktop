import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../src/main/logger.js';
import { installPermissionHandlers } from '../../src/main/permissions.js';
import type { PermissionOptions } from '../../src/main/permissions.js';

const ENGINE = 'http://127.0.0.1:4173';

function setup(over: { micStatus?: string; ask?: boolean; pick?: string | null; remembered?: { vendorId: number; productId: number; serialNumber?: string }[] } = {}) {
  const handlers: Record<string, (...a: never[]) => unknown> = {};
  const listeners: Record<string, (...a: never[]) => unknown> = {};
  const session = {
    setPermissionCheckHandler: (h: never) => void (handlers['check'] = h),
    setPermissionRequestHandler: (h: never) => void (handlers['request'] = h),
    setDevicePermissionHandler: (h: never) => void (handlers['device'] = h),
    on: (e: string, l: never) => void (listeners[e] = l),
  };
  const remembered = over.remembered ?? [];
  const rememberUsb = vi.fn();
  const notify = vi.fn(async () => undefined);
  const askForMediaAccess = vi.fn(async () => over.ask ?? true);
  const nop = (): void => undefined;
  const opts = {
    session,
    engineOrigin: () => ENGINE,
    rememberedUsb: () => remembered,
    rememberUsb,
    pickUsb: vi.fn(async () => over.pick ?? null),
    systemPreferences: { askForMediaAccess, getMediaAccessStatus: () => over.micStatus ?? 'not-determined' },
    log: createLogger({ info: nop, warn: nop, error: nop, debug: nop }),
    notify,
  } as unknown as PermissionOptions;
  installPermissionHandlers(opts);
  return { handlers, listeners, rememberUsb, notify, askForMediaAccess, opts };
}

type Fn = (...a: unknown[]) => unknown;

describe('permission check handler', () => {
  it('grants usb and audio-only media to the engine origin only', () => {
    const { handlers } = setup();
    const check = handlers['check'] as unknown as Fn;
    expect(check(null, 'usb', ENGINE, { isMainFrame: true })).toBe(true);
    expect(check(null, 'usb', 'http://127.0.0.1:4173.evil.com', { isMainFrame: true })).toBe(false);
    expect(check(null, 'media', ENGINE, { isMainFrame: true, mediaType: 'audio' })).toBe(true);
    expect(check(null, 'media', ENGINE, { isMainFrame: true, mediaType: 'video' })).toBe(false);
    expect(check(null, 'media', ENGINE, { isMainFrame: true })).toBe(false);
    expect(check(null, 'geolocation', ENGINE, { isMainFrame: true })).toBe(false);
    expect(check(null, 'display-capture', ENGINE, { isMainFrame: true })).toBe(false);
  });
});

describe('permission request handler', () => {
  const wc = { getURL: () => ENGINE + '/' };
  it('denies geolocation and video', async () => {
    const { handlers } = setup();
    const req = handlers['request'] as unknown as Fn;
    const cb1 = vi.fn();
    req(wc, 'geolocation', cb1, { requestingUrl: ENGINE + '/' });
    expect(cb1).toHaveBeenCalledWith(false);
    const cb2 = vi.fn();
    req(wc, 'media', cb2, { requestingUrl: ENGINE + '/', securityOrigin: ENGINE, mediaTypes: ['video', 'audio'] });
    expect(cb2).toHaveBeenCalledWith(false);
  });
  it('asks the OS for the microphone and grants on yes', async () => {
    const { handlers, askForMediaAccess } = setup({ ask: true });
    const req = handlers['request'] as unknown as Fn;
    const cb = vi.fn();
    req(wc, 'media', cb, { requestingUrl: ENGINE + '/', securityOrigin: ENGINE, mediaTypes: ['audio'] });
    await vi.waitFor(() => expect(cb).toHaveBeenCalledWith(true));
    expect(askForMediaAccess).toHaveBeenCalledWith('microphone');
  });
  it('shows the guidance dialog once when the microphone is denied in System Settings', async () => {
    const { handlers, notify, askForMediaAccess } = setup({ micStatus: 'denied' });
    const req = handlers['request'] as unknown as Fn;
    for (let i = 0; i < 2; i++) {
      const cb = vi.fn();
      req(wc, 'media', cb, { requestingUrl: ENGINE + '/', securityOrigin: ENGINE, mediaTypes: ['audio'] });
      await vi.waitFor(() => expect(cb).toHaveBeenCalledWith(false));
    }
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(askForMediaAccess).not.toHaveBeenCalled();
  });
});

describe('WebUSB', () => {
  const fakeEvent = () => ({ preventDefault: vi.fn() });
  const list = [{ deviceId: 'd1', vendorId: 1, productId: 2, productName: 'SDR', serialNumber: 'S1' }];
  it('prevents default, picks, calls back and remembers', async () => {
    const { listeners, rememberUsb } = setup({ pick: 'd1' });
    const ev = fakeEvent();
    const cb = vi.fn();
    (listeners['select-usb-device'] as unknown as Fn)(ev, { deviceList: list }, cb);
    await vi.waitFor(() => expect(cb).toHaveBeenCalledWith('d1'));
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(rememberUsb).toHaveBeenCalledWith({ vendorId: 1, productId: 2, productName: 'SDR', serialNumber: 'S1' });
  });
  it('cancels with no argument when the picker is dismissed', async () => {
    const { listeners, rememberUsb } = setup({ pick: null });
    const cb = vi.fn();
    (listeners['select-usb-device'] as unknown as Fn)(fakeEvent(), { deviceList: list }, cb);
    await vi.waitFor(() => expect(cb).toHaveBeenCalled());
    expect(cb).toHaveBeenCalledWith();
    expect(rememberUsb).not.toHaveBeenCalled();
  });
  it('cancels and tells the user when no device is present', async () => {
    const { listeners, notify } = setup();
    const cb = vi.fn();
    (listeners['select-usb-device'] as unknown as Fn)(fakeEvent(), { deviceList: [] }, cb);
    expect(cb).toHaveBeenCalledWith();
    expect(notify).toHaveBeenCalled();
  });
  it('device handler honours remembered devices for the engine origin only', () => {
    const { handlers } = setup({ remembered: [{ vendorId: 1, productId: 2, serialNumber: 'S1' }] });
    const dev = handlers['device'] as unknown as Fn;
    const device = { vendorId: 1, productId: 2, serialNumber: 'S1', productName: 'SDR' };
    expect(dev({ deviceType: 'usb', origin: ENGINE, device })).toBe(true);
    expect(dev({ deviceType: 'usb', origin: 'https://example.com', device })).toBe(false);
    expect(dev({ deviceType: 'hid', origin: ENGINE, device })).toBe(false);
    expect(dev({ deviceType: 'usb', origin: ENGINE, device: { ...device, serialNumber: 'S2' } })).toBe(false);
  });
});
