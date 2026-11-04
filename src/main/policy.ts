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

/** Builds the entry to remember from a pick, keeping only the identity fields that are present. */
export function toRememberedUsb(d: {
  vendorId: number;
  productId: number;
  serialNumber?: string | null | undefined;
  productName?: string | null | undefined;
}): RememberedUsbDevice {
  const entry: RememberedUsbDevice = { vendorId: d.vendorId, productId: d.productId };
  if (d.serialNumber !== undefined && d.serialNumber !== null && d.serialNumber !== '') {
    entry.serialNumber = d.serialNumber;
  }
  if (d.productName !== undefined && d.productName !== null && d.productName !== '') {
    entry.productName = d.productName;
  }
  return entry;
}

/** True when two remembered entries describe the same device identity, product name included. */
export function sameUsbIdentity(a: RememberedUsbDevice, b: RememberedUsbDevice): boolean {
  return (
    a.vendorId === b.vendorId &&
    a.productId === b.productId &&
    (a.serialNumber ?? null) === (b.serialNumber ?? null) &&
    (a.productName ?? null) === (b.productName ?? null)
  );
}

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
  IPC.setAppSettings,
  IPC.getEngineKeys,
  IPC.saveEngineKey,
  IPC.clearEngineKey,
  IPC.getEngineSettings,
  IPC.saveEngineSettings,
  IPC.listOllamaModels,
  IPC.usbPickerList,
  IPC.usbPickerChoose,
]);

/** One-way channel only the engine page may use (IPC.renderError, kept literal to avoid a cycle). */
const ENGINE_ONLY_RENDER_ERROR = 'opentac:renderError';

/** Auto-reload budget after Cesium render errors. */
export const RENDER_ERROR_WINDOW_MS = 10 * 60_000;
export const RENDER_ERROR_MAX_RELOADS = 3;

/**
 * Whether a render-error report should trigger an automatic reload: fewer than three reports
 * (including earlier ones, excluding the one at `now`) in the last ten minutes.
 */
export function shouldAutoReloadAfterRenderError(timestamps: readonly number[], now: number): boolean {
  const recent = timestamps.filter((t) => Number.isFinite(t) && t <= now && now - t < RENDER_ERROR_WINDOW_MS);
  return recent.length < RENDER_ERROR_MAX_RELOADS;
}

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
  if (channel === ENGINE_ONLY_RENDER_ERROR) {
    if (engineOrigin === null || engineOrigin === undefined) return false;
    return originOf(frameUrl) === engineOrigin;
  }
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
  // Keep the whole window inside the work area (a clamped size must not leave it hanging off the
  // bottom or right edge), which also keeps the title bar below the top of the work area.
  const maxX = Math.max(workArea.x, workArea.x + workArea.width - size.width);
  const maxY = Math.max(workArea.y, workArea.y + workArea.height - size.height);
  const x = Math.min(Math.max(saved.x, workArea.x), maxX);
  const y = Math.min(Math.max(saved.y, workArea.y), maxY);
  return { x: Math.round(x), y: Math.round(y), ...size };
}

/**
 * Picks the work area to restore saved bounds into: the current display whose work area overlaps
 * the saved rectangle enough to be reachable, else `fallback` (the primary display), in which case
 * {@link validateBounds} drops the saved position and the window is centred.
 */
export function chooseWorkArea(saved: WindowBounds | null, workAreas: readonly Rect[], fallback: Rect): Rect {
  if (
    saved === null ||
    !isFiniteNumber(saved.x) ||
    !isFiniteNumber(saved.y) ||
    !isFiniteNumber(saved.width) ||
    !isFiniteNumber(saved.height)
  ) {
    return fallback;
  }
  let best: Rect | null = null;
  let bestArea = 0;
  for (const wa of workAreas) {
    const w = Math.min(saved.x + saved.width, wa.x + wa.width) - Math.max(saved.x, wa.x);
    const h = Math.min(saved.y + saved.height, wa.y + wa.height) - Math.max(saved.y, wa.y);
    if (w < MIN_VISIBLE_WIDTH || h < MIN_VISIBLE_HEIGHT) continue;
    if (w * h > bestArea) {
      best = wa;
      bestArea = w * h;
    }
  }
  return best ?? fallback;
}

// ---------------------------------------------------------------------------
// Ollama host
// ---------------------------------------------------------------------------

function isLoopbackHost(h: string): boolean {
  return h === 'localhost' || h === '::1' || h === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(h);
}

function isPrivateLanHost(h: string): boolean {
  if (/^10(?:\.\d{1,3}){3}$/.test(h)) return true;
  if (/^192\.168(?:\.\d{1,3}){2}$/.test(h)) return true;
  if (/^169\.254(?:\.\d{1,3}){2}$/.test(h)) return true;
  const m = /^172\.(\d{1,3})(?:\.\d{1,3}){2}$/.exec(h);
  if (m !== null && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return h.endsWith('.local') || /^\[f[cd][0-9a-f:]*\]$/i.test(h) || /^\[fe80:[0-9a-f:]*\]$/i.test(h);
}

/**
 * A warning for an Ollama host that sends summary prompts (which carry location context) somewhere
 * other than this Mac or a private network, or in clear text off this Mac; null when it is fine.
 */
export function ollamaHostWarning(host: string | null): string | null {
  const raw = (host ?? '').trim();
  if (raw === '') return null;
  const m = /^(https?):\/\/([^\s/@:]+|\[[0-9a-f:]+\])(?::\d{1,5})?\/?$/i.exec(raw);
  if (m === null) return null;
  const scheme = (m[1] ?? '').toLowerCase();
  const name = (m[2] ?? '').toLowerCase();
  if (isLoopbackHost(name)) return null;
  if (!isPrivateLanHost(name)) {
    return `the Ollama host ${name} is neither this Mac nor a private network address; HUD summary prompts will leave your network${scheme === 'http' ? ' unencrypted' : ''}`;
  }
  if (scheme === 'http') return `the Ollama host ${name} is reached over plain http; prompts cross the network unencrypted`;
  return null;
}
