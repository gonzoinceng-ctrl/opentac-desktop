// Shared shapes used by both the main process and the renderers.
// Controller phases (AppController states) are defined elsewhere, not here.

/** Which ref of the OpenTac engine mirror the app follows. */
export type Channel = 'stable' | 'candidate' | 'upstream';

/** Summary-provider choices for the HUD summary gateway. */
export type AiProvider = 'openai' | 'ollama' | 'openrouter' | 'xai';

/** Placeholder engine mirror URL; replaced at Phase 5b. */
export const DEFAULT_REMOTE_URL = 'https://github.com/OWNER/opentac-engine.git';

/** Saved window geometry; x/y are absent when the position was never set. */
export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

/** A remembered WebUSB device pick. */
export interface UsbDeviceId {
  vendorId: number;
  productId: number;
  serialNumber?: string;
}

/** Persisted shell state (state.json). Provider API keys live in Keychain, never here. */
export interface ShellState {
  schemaVersion: 1;
  channel: Channel;
  remoteUrl: string;
  installedCommit: string | null;
  installedLockHash: string | null;
  installedNodeVersion: string | null;
  rollbackCommit: string | null;
  /** ISO-8601 timestamp. */
  lastUpdateCheck: string | null;
  /** ISO-8601 timestamp. */
  lastSuccessfulStart: string | null;
  lastPort: number | null;
  updateCheckOnLaunch: boolean;
  skippedCommit: string | null;
  mainWindowBounds: WindowBounds | null;
  usbDevices: UsbDeviceId[];
  ai: { provider: AiProvider; model: string | null; ollamaHost: string | null };
}
