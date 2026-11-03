/**
 * Main-process internal contracts between the controller, the windows layer and the IPC layer,
 * so that each can be implemented and tested independently (docs/SHELL-DESIGN.md).
 * No electron import here: implementations inject what they need.
 */
import type {
  ActionName,
  AiTestResultPublic,
  Disclosure,
  Phase,
  PublicState,
  SetAiKeyPayload,
  SetAiPayload,
  Prefs,
  Versions,
} from '../shared/ipc.js';
import type { ShellState } from '../shared/types.js';

/** What the controller needs from the windows layer. Implemented by src/main/windows.ts. */
export interface ShellUi {
  /** Show the setup window (progress / disclosure / crash / error / prefs host). */
  showSetup(): void;
  /** Hide (not destroy) the setup window. */
  hideSetup(): void;
  /** Create or focus the main window and load the engine URL. */
  showMain(url: string): void;
  /** Block or unblock interaction with the main window (used while RESTARTING). */
  setMainEnabled(enabled: boolean): void;
  /** Reload the main window after an engine restart. */
  reloadMain(): void;
  /** Whether a main window currently exists. */
  hasMain(): boolean;
  /** Push a fresh PublicState to the setup renderer (and the USB picker if open). */
  pushState(state: PublicState): void;
  /** Inform the permissions layer of the engine origin for this run. */
  setEngineOrigin(origin: string | null): void;
  /** Native confirm dialog. Resolves true when the user chose the confirming button. */
  confirm(opts: { title: string; message: string; detail?: string; confirmLabel: string; destructive?: boolean }): Promise<boolean>;
  /** Native info dialog (non-blocking from the controller's point of view). */
  notify(opts: { title: string; message: string; detail?: string }): Promise<void>;
}

/** The controller's public surface. Implemented by src/main/controller.ts. */
export interface ControllerApi {
  /** Begin the BOOT sequence. Resolves when the first terminal-ish phase (RUNNING or ERROR) is reached. */
  start(): Promise<void>;
  phase(): Phase;
  state(): ShellState;
  publicState(): PublicState;
  /** Dispatch a renderer/menu action by name. Unknown or inapplicable actions are logged and ignored. */
  action(name: ActionName): Promise<void>;
  setPrefs(patch: Partial<Prefs>): Promise<void>;
  setAi(payload: SetAiPayload): Promise<void>;
  setAiKey(payload: SetAiKeyPayload): Promise<void>;
  testAi(): Promise<AiTestResultPublic>;
  listOllamaModels(): Promise<{ models: string[]; error: string | null }>;
  versions(): Promise<Versions>;
  /** Engine URL while RUNNING, else null. */
  engineUrl(): string | null;
  /** Stop the engine server and the gateway, flush state. Safe to call twice. */
  shutdown(): Promise<void>;
  /** Subscribe to PublicState changes. */
  onState(cb: (s: PublicState) => void): () => void;
  /** Force a check now (menu). */
  checkForEngineUpdates(): Promise<void>;
  checkForAppUpdates(): Promise<void>;
  /** Current disclosure if DISCLOSING, else null. */
  disclosure(): Disclosure | null;
}

/** Minimal shell-updater surface the controller drives (src/main/shellUpdate.ts). */
export interface ShellUpdaterApi {
  /** Check GitHub Releases; prompts the user through ShellUi dialogs. No-op when not packaged. */
  check(opts: { interactive: boolean }): Promise<void>;
  /** True when a downloaded update is waiting for quit-and-install. */
  pending(): boolean;
  /** Quit and install a pending update after the engine has been stopped. */
  quitAndInstall(): void;
}

/** Secret storage surface (src/main/secrets.ts). */
export interface SecretsApi {
  available(): Promise<boolean>;
  get(name: 'openrouter' | 'xai'): Promise<string | null>;
  set(name: 'openrouter' | 'xai', value: string | null): Promise<void>;
  has(name: 'openrouter' | 'xai'): Promise<boolean>;
}
