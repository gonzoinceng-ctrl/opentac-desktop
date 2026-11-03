// Shared shapes used by both the main process and the renderers.
// Controller phases (AppController states) are defined elsewhere, not here.

/** Which ref of the OpenTac engine mirror the app follows. */
export type Channel = 'stable' | 'candidate' | 'upstream';

/** Summary-provider choices for the HUD summary gateway. */
export type AiProvider = 'openai' | 'ollama' | 'openrouter' | 'xai';

/** Placeholder engine mirror URL; replaced at Phase 5b. */
export const DEFAULT_REMOTE_URL = 'https://github.com/gonzoinceng-ctrl/opentac-engine.git';

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

/** How often background engine update checks run (docs/SHELL-DESIGN.md section 14). */
export type UpdateCheckInterval = 'launch-only' | '6h' | 'daily';

/** Log level chosen in App settings; `default` leaves the built-in levels in place. */
export type LogLevelSetting = 'default' | 'error' | 'warn' | 'info' | 'debug';

/** Proxy settings handed to the engine, git and npm. Addresses never carry credentials. */
export interface ProxySettings {
  httpsProxy: string | null;
  noProxy: string | null;
}

/** OpenTac's own settings (state.json `app`). Contains no secrets. */
export interface AppSettings {
  launchAtLogin: boolean;
  autoRestartOnCrash: boolean;
  updateCheckInterval: UpdateCheckInterval;
  logLevel: LogLevelSetting;
  proxy: ProxySettings;
  /** Advanced: an https:// or file:// engine mirror used instead of `remoteUrl`; null = default. */
  engineRemoteUrl: string | null;
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
  /** OpenTac's own settings; missing fields fill from defaults, schemaVersion stays 1. */
  app: AppSettings;
}
