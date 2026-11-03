/**
 * Pure decision logic for the Electron shell (no electron import, unit-tested).
 * Navigation, permissions, WebUSB matching, the app:// path guard, IPC sender gating and window
 * bounds validation all live here so that the thin electron-bound modules only apply the verdicts.
 */
import { posix } from 'node:path';

import { IPC } from '../shared/ipc.js';
import type { UsbDeviceId, WindowBounds } from '../shared/types.js';

/** Origin of the setup window's custom scheme (app://setup/...). */
export const SETUP_ORIGIN = 'app://setup';

/** Prefix every setup-window document URL starts with. */
export const SETUP_URL_PREFIX = 'app://setup/';

/**
 * Returns the origin of `url` as `scheme//host[:port]`, or null when it does not parse.
 * Unlike `URL.origin` this also yields a value for non-special schemes such as `app:`, so the
 * result is stable between Node (tests) and Chromium.
 */
export function originOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.origin;
  if (parsed.host === '') return null;
  return `${parsed.protocol}//${parsed.host}`;
}

/** What to do with a navigation request. */
export type NavigationVerdict = 'allow' | 'external' | 'deny';

/**
 * Engine origin (or the setup origin for the setup window) is allowed; `https:` and `mailto:`
 * go to the system; everything else (file:, javascript:, data:, http: elsewhere, ...) is denied.
 */
export function decideNavigation(url: string, engineOrigin: string | null): NavigationVerdict {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'deny';
  }
  if (engineOrigin !== null && originOf(url) === engineOrigin) return 'allow';
  if (parsed.protocol === 'https:' || parsed.protocol === 'mailto:') return 'external';
  return 'deny';
}

/** Permissions the engine origin may hold (docs/SHELL-DESIGN.md section 7). */
const ENGINE_PERMISSIONS: ReadonlySet<string> = new Set([
  'usb',
  'media',
  'clipboard-read',
  'clipboard-sanitized-write',
  'fullscreen',
  'pointerLock',
]);

/**
 * Whether `permission` is granted to `requestingOrigin`. Only the engine origin ever gets
 * anything; `media` additionally requires every requested type to be audio (no camera, no
 * screen capture). Everything else, including geolocation, notifications, hid, serial, midi and
 * display-capture, is false.
 */
export function decidePermission(
  permission: string,
  requestingOrigin: string,
  engineOrigin: string | null,
  details?: { mediaTypes?: string[] },
): boolean {
  if (engineOrigin === null) return false;
  if (!ENGINE_PERMISSIONS.has(permission)) return false;
  const origin = originOf(requestingOrigin);
  if (origin === null || origin !== engineOrigin) return false;
  if (permission === 'media') {
    const types = details?.mediaTypes;
    if (types === undefined || types.length === 0) return false;
    return types.every((t) => t === 'audio');
  }
  return true;
}

/** A remembered WebUSB pick, optionally with the product name Chromium reported. */
export type RememberedUsbDevice = UsbDeviceId & { productName?: string | null };

/** A device as Chromium describes it. */
export interface UsbDeviceLike {
  vendorId: number;
  productId: number;
  productName?: string | null | undefined;
  serialNumber?: string | null | undefined;
}

/** True when vendor and product match and every remembered optional field also matches. */
export function matchUsbDevice(remembered: RememberedUsbDevice, device: UsbDeviceLike): boolean {
  if (remembered.vendorId !== device.vendorId || remembered.productId !== device.productId) {
    return false;
  }
  const serial = remembered.serialNumber;
  if (serial !== undefined && serial !== null && serial !== '') {
    if (device.serialNumber !== serial) return false;
  }
  const name = remembered.productName;
  if (name !== undefined && name !== null && name !== '') {
    if (device.productName !== name) return false;
  }
  return true;
}

/**
 * Pure posix containment test for the app:// protocol handler: true when `candidate`, after
 * normalisation, is `base` itself or lies below it. Rejects NUL bytes and any `..` escape.
 */
export function isWithinDir(base: string, candidate: string): boolean {
  if (base.includes('\0') || candidate.includes('\0')) return false;
  const root = posix.resolve('/', base);
  const target = posix.resolve('/', candidate);
  if (target === root) return true;
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return target.startsWith(prefix);
}

// ---------------------------------------------------------------------------
// IPC sender gate
// ---------------------------------------------------------------------------

const SHARED_CHANNELS: ReadonlySet<string> = new Set([
  IPC.getVersions,
  IPC.openExternal,
  IPC.openLogsFolder,
]);

const SETUP_ONLY_CHANNELS: ReadonlySet<string> = new Set([
  IPC.getState,
  IPC.action,
  IPC.setPrefs,
  IPC.setAi,
  IPC.setAiKey,
  IPC.testAi,
  IPC.listOllamaModels,
  IPC.usbPickerList,
  IPC.usbPickerChoose,
]);

/**
 * Whether a message on `channel` may come from the frame at `frameUrl`.
 * Setup-only channels and the USB picker channels require an `app://setup/` document. The three
 * shared channels (getVersions, openExternal, openLogsFolder) are also open to the engine page,
 * but only when `engineOrigin` is known and the frame is on exactly that origin. Unknown channels
 * and missing frame URLs are refused.
 */
export function isAllowedSender(
  frameUrl: string | null | undefined,
  channel: string,
  engineOrigin?: string | null,
): boolean {
  if (typeof frameUrl !== 'string' || frameUrl === '') return false;
  const fromSetup = frameUrl.startsWith(SETUP_URL_PREFIX);
  if (SETUP_ONLY_CHANNELS.has(channel)) return fromSetup;
  if (SHARED_CHANNELS.has(channel)) {
    if (fromSetup) return true;
    if (engineOrigin === null || engineOrigin === undefined) return false;
    return originOf(frameUrl) === engineOrigin;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Window bounds
// ---------------------------------------------------------------------------

/** A rectangle in screen coordinates (matches Electron.Rectangle). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Minimum overlap with a display work area for a saved position to count as reachable. */
const MIN_VISIBLE_WIDTH = 120;
const MIN_VISIBLE_HEIGHT = 60;

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * Validates saved window bounds against the work area of the display that matches them.
 * Size is clamped to `min` and to the work area; the position is kept only when a usable part of
 * the window (title bar side) lies inside the work area, otherwise it is dropped so the window
 * is centred. Returns the default size when nothing usable was saved.
 */
export function validateBounds(
  saved: WindowBounds | null,
  workArea: Rect,
  defaults: { width: number; height: number },
  min: { width: number; height: number },
): WindowBounds {
  const clampSize = (w: number, h: number): { width: number; height: number } => ({
    width: Math.max(min.width, Math.min(Math.round(w), Math.max(min.width, workArea.width))),
    height: Math.max(min.height, Math.min(Math.round(h), Math.max(min.height, workArea.height))),
  });
  if (saved === null || !isFiniteNumber(saved.width) || !isFiniteNumber(saved.height)) {
    return clampSize(defaults.width, defaults.height);
  }
  const size = clampSize(saved.width, saved.height);
  if (!isFiniteNumber(saved.x) || !isFiniteNumber(saved.y)) return size;
  const overlapW =
    Math.min(saved.x + size.width, workArea.x + workArea.width) - Math.max(saved.x, workArea.x);
  const overlapH =
    Math.min(saved.y + size.height, workArea.y + workArea.height) - Math.max(saved.y, workArea.y);
  if (overlapW < MIN_VISIBLE_WIDTH || overlapH < MIN_VISIBLE_HEIGHT) return size;
  // The title bar must be reachable: its top edge may not sit above the work area.
  const y = Math.max(saved.y, workArea.y);
  return { x: Math.round(saved.x), y: Math.round(y), ...size };
}
