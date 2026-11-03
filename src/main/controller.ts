/**
 * The OpenTac app controller: the phase state machine of docs/SHELL-DESIGN.md section 2 plus the
 * boot sequence, port pinning (section 6), AI gateway lifecycle (section 10), crash policy and the
 * engine update apply / rollback flow (section 3).
 *
 * This module never imports electron. Everything it needs from the windows layer, the secrets
 * store and the shell updater arrives through {@link ControllerDeps}, so it is unit-testable.
 *
 * Notes for the layers around it:
 * - `action('showLogs')` is a no-op here: the IPC layer intercepts it and opens the logs folder.
 * - `action('quit')` calls `deps.requestQuit` when one is given (index.ts wires `app.quit`).
 * - The controller pushes every PublicState to `ui.pushState` itself and also to `onState`
 *   subscribers; wire only one of them to the setup window.
 * - Deviations from the transition list in section 2, both required by section 3 and the
 *   round-two decision "if npm ci fails after the checkout, roll the checkout back":
 *   `INSTALLING -> ROLLING_BACK` (a failed install during an update) and
 *   `RESTARTING -> INSTALLING` (Reinstall Dependencies from a running engine). Every edge into
 *   ROLLING_BACK needs a rollback marker (`state.rollbackCommit`).
 * - OPENTAC_FAIL_START_ONCE is read from `deps.env` at construction and passed to exactly one
 *   `server.start()`: the first one made while a rollback marker exists (a post-update start),
 *   so a boot start can never consume it.
 */
import { randomBytes } from 'node:crypto';
import { copyFile, readFile, rm, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ActionName,
  AiPrefsPublic,
  AiTestResultPublic,
  Disclosure,
  Phase,
  Prefs,
  Progress,
  PublicState,
  SetAiKeyPayload,
  SetAiPayload,
  UserError,
  Versions,
} from '../shared/ipc.js';
import type { AiProvider, ShellState } from '../shared/types.js';
import type { AiGateway, AiGatewayConfig } from './aiGateway.js';
import type { CheckoutManager, ResolvedTarget } from './checkout.js';
import type { ControllerApi, SecretsApi, ShellUi, ShellUpdaterApi } from './contracts.js';
import { envFileHasKey as realEnvFileHasKey } from './envFile.js';
import {
  MIN_FREE_BYTES,
  ShellError,
  crashUserError,
  toUserError,
  type ErrorContext,
} from './errors.js';
import { GitError, redactRemoteUrl } from './git.js';
import type { InstallManager } from './install.js';
import type { Logger } from './logger.js';
import type { Paths } from './paths.js';
import { findFreePort, isPortFree } from './ports.js';
import type { RingBuffer } from './ringBuffer.js';
import { ServerError, type ServerHandle, type ServerManager, type ServerStartOptions } from './server.js';
import { updateState } from './state.js';
import { createUpdateManager, labelFor, type UpdateCheck, type UpdateManager } from './update.js';

/** The line every About / setup surface must carry (docs/brief/01). */
export const ATTRIBUTION =
  "OpenTac is an unofficial desktop app for God's Eye View by Bilawal Sidhu (MIT)";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** First port tried on a fresh install; the chosen port is then pinned in state. */
export const DEFAULT_PORT = 4173;
/** Delay before the first automatic update check after RUNNING. */
export const LAUNCH_CHECK_DELAY_MS = 20_000;
/** Delay before the shell (app) update check after RUNNING. */
export const SHELL_CHECK_DELAY_MS = 30_000;
/** Interval of in-session engine update checks, and the rate limit between any two checks. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** After an offline result, background checks (focus, resume, interval) wait this long. */
export const OFFLINE_BACKOFF_MS = 15 * 60 * 1000;
/** A check this close to the limit still counts as due (the interval fires just under 6 h). */
export const CHECK_RATE_TOLERANCE_MS = 60_000;
/** Two automatic crash restarts must be at least this far apart. */
export const AUTO_RESTART_GUARD_MS = 60_000;
/** Delay before the single automatic retry after EADDRINUSE. */
export const EADDRINUSE_RETRY_MS = 1000;
/** Progress ticks are pushed to the UI at most this often. */
export const PUSH_THROTTLE_MS = 100;
/** Cap on how long the upstream setup doctor may delay the start. */
export const DOCTOR_WAIT_MS = 10_000;
/** Timeout of the Ollama model listing. */
export const OLLAMA_TIMEOUT_MS = 10_000;
/** Default Ollama host. */
export const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';
/** Notices kept for the setup window. */
export const MAX_NOTICES = 5;

// ---------------------------------------------------------------------------
// Phase machine
// ---------------------------------------------------------------------------

/** Allowed phase transitions (docs/SHELL-DESIGN.md section 2). Anything else throws. */
export const TRANSITIONS: Readonly<Record<Phase, readonly Phase[]>> = {
  BOOT: ['CLONING', 'INSTALLING', 'STARTING', 'ERROR'],
  CLONING: ['INSTALLING', 'ERROR'],
  // INSTALLING -> ROLLING_BACK: a failed `npm ci` after the checkout moved (round-two decision).
  INSTALLING: ['STARTING', 'ERROR', 'ROLLING_BACK'],
  STARTING: ['RUNNING', 'ERROR', 'ROLLING_BACK'],
  RUNNING: ['CHECKING', 'CRASHED', 'RESTARTING', 'ERROR'],
  CHECKING: ['RUNNING', 'DISCLOSING', 'ERROR'],
  DISCLOSING: ['RUNNING', 'UPDATING'],
  UPDATING: ['INSTALLING', 'STARTING', 'ROLLING_BACK', 'ERROR'],
  // RESTARTING -> INSTALLING: Reinstall Dependencies from a running engine.
  RESTARTING: ['STARTING', 'ERROR', 'INSTALLING'],
  ROLLING_BACK: ['INSTALLING', 'STARTING', 'ERROR'],
  CRASHED: ['STARTING', 'INSTALLING', 'ERROR'],
  ERROR: ['BOOT', 'CLONING', 'INSTALLING', 'STARTING'],
};

/** True when the table lists `from -> to`. */
export function isAllowedTransition(from: Phase, to: Phase): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Thrown by {@link PhaseMachine.transition}; always a programming error. */
export class IllegalTransitionError extends Error {
  readonly from: Phase;
  readonly to: Phase;

  constructor(from: Phase, to: Phase, why: string) {
    super(`Illegal phase transition ${from} -> ${to}: ${why}`);
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.to = to;
  }
}

/** Holds the current phase and enforces {@link TRANSITIONS}. */
export interface PhaseMachine {
  phase(): Phase;
  /** Moves to `to` or throws {@link IllegalTransitionError}; logs every move. */
  transition(to: Phase, reason: string): Phase;
}

/** Options of {@link createPhaseMachine}. */
export interface PhaseMachineOptions {
  initial?: Phase;
  log: Logger;
  /** Entering ROLLING_BACK is only legal while a rollback marker exists. */
  hasRollbackMarker: () => boolean;
}

/** Creates the machine. `transition` returns the phase it left. */
export function createPhaseMachine(opts: PhaseMachineOptions): PhaseMachine {
  let current: Phase = opts.initial ?? 'BOOT';
  return {
    phase: () => current,
    transition(to, reason) {
      const from = current;
      if (!isAllowedTransition(from, to)) {
        throw new IllegalTransitionError(from, to, 'not in the transition table');
      }
      if (to === 'ROLLING_BACK' && !opts.hasRollbackMarker()) {
        throw new IllegalTransitionError(from, to, 'no rollback marker exists');
      }
      current = to;
      opts.log.info(`phase ${from} -> ${to}: ${reason}`);
      return from;
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Replacements the caller applies to Paths when the app is not packaged. */
export type DevOverrides = Partial<Pick<Paths, 'launcherScript' | 'nodeBin' | 'npmCli'>>;

/**
 * OPENTAC_LAUNCHER_OVERRIDE, OPENTAC_NODE_OVERRIDE and OPENTAC_NPM_CLI_OVERRIDE, honoured only
 * when the app is not packaged. index.ts applies the result when it builds Paths; the controller
 * only logs it.
 */
export function resolveDevOverrides(env: NodeJS.ProcessEnv, isPackaged: boolean): DevOverrides {
  if (isPackaged) return {};
  const out: DevOverrides = {};
  const launcher = env['OPENTAC_LAUNCHER_OVERRIDE'];
  const node = env['OPENTAC_NODE_OVERRIDE'];
  const npm = env['OPENTAC_NPM_CLI_OVERRIDE'];
  if (launcher !== undefined && launcher !== '') out.launcherScript = launcher;
  if (node !== undefined && node !== '') out.nodeBin = node;
  if (npm !== undefined && npm !== '') out.npmCli = npm;
  return out;
}

/** OPENTAC_ENGINE_REMOTE / OPENTAC_ENGINE_REF (CI overrides, honoured in every build). */
export function resolveEngineOverrides(env: NodeJS.ProcessEnv): {
  remoteUrl?: string;
  ref?: string;
} {
  const out: { remoteUrl?: string; ref?: string } = {};
  const remote = env['OPENTAC_ENGINE_REMOTE']?.trim();
  const ref = env['OPENTAC_ENGINE_REF']?.trim();
  if (remote !== undefined && remote !== '') out.remoteUrl = remote;
  if (ref !== undefined && ref !== '' && !ref.startsWith('-')) out.ref = ref;
  return out;
}

/** True when an automatic check may run: never checked, or the last one is old enough. */
export function isAutomaticCheckDue(lastUpdateCheck: string | null, nowMs: number): boolean {
  if (lastUpdateCheck === null) return true;
  const last = Date.parse(lastUpdateCheck);
  if (Number.isNaN(last)) return true;
  return nowMs - last >= CHECK_INTERVAL_MS - CHECK_RATE_TOLERANCE_MS;
}

/**
 * True when a found update must stay quiet: the user skipped exactly this commit and the check
 * is automatic and the update is not a security release.
 */
export function isQuietlySkipped(
  skippedCommit: string | null,
  targetCommit: string,
  interactive: boolean,
  severity: Disclosure['severity'],
): boolean {
  return skippedCommit === targetCommit && !interactive && severity !== 'security';
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** Timer functions, injectable so tests drive time by hand. Handles are opaque. */
export interface ControllerTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** Everything {@link createController} needs. */
export interface ControllerDeps {
  paths: Paths;
  log: Logger;
  initialState: ShellState;
  saveState: (s: ShellState) => Promise<void>;
  checkout: CheckoutManager;
  install: InstallManager;
  server: ServerManager;
  /** Shared with the server manager; the controller also writes clone and install output to it. */
  ring: RingBuffer;
  gatewayFactory: (cfg: { getConfig: () => AiGatewayConfig; authToken: string }) => AiGateway;
  secrets: SecretsApi;
  ui: ShellUi;
  shellUpdater: ShellUpdaterApi;
  appVersion: string;
  electronVersion: string;
  chromiumVersion: string;
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
  now?: (() => number) | undefined;
  timers?: ControllerTimers | undefined;
  /** Free bytes on the volume of `dir`; default `fs.statfs`. */
  diskFree?: ((dir: string) => Promise<number>) | undefined;
  /** Default: the real dotenv scanner. */
  envFileHasKey?: ((file: string, key: string) => Promise<boolean>) | undefined;
  /** Port probes, default the real ones in ports.ts. */
  ports?:
    | {
        isPortFree: (port: number) => Promise<boolean>;
        findFreePort: (opts: { preferred?: number; rangeStart?: number; rangeEnd?: number }) => Promise<number>;
      }
    | undefined;
  /** Replaces the real update manager (tests). */
  update?: UpdateManager | undefined;
  fetchImpl?: typeof fetch | undefined;
  /** Called by the `quit` action; index.ts passes `() => app.quit()`. */
  requestQuit?: (() => void) | undefined;
}

/** The controller plus the hooks the app shell needs beyond {@link ControllerApi}. */
export interface ShellController extends ControllerApi {
  /** powerMonitor `resume`: a rate-limited background update check. */
  notifyResume(): void;
  /** Main window focus: a rate-limited background update check. */
  notifyMainFocus(): void;
  openAbout(): void;
  closeAbout(): void;
}

const PHASE_MESSAGES: Readonly<Record<Phase, string>> = {
  BOOT: 'Starting OpenTac…',
  CLONING: "Downloading the God's Eye View source from GitHub…",
  INSTALLING: 'Installing dependencies…',
  STARTING: "Starting God's Eye View…",
  RUNNING: "God's Eye View is running.",
  CRASHED: "God's Eye View stopped unexpectedly.",
  CHECKING: 'Checking for engine updates…',
  DISCLOSING: 'An engine update is available.',
  UPDATING: "Updating God's Eye View…",
  RESTARTING: "Restarting God's Eye View…",
  ROLLING_BACK: 'Going back to the previous version…',
  ERROR: 'Something went wrong.',
};

const CLONE_LABELS: Readonly<Record<string, string>> = {
  counting: 'Counting objects',
  compressing: 'Compressing objects',
  receiving: "Downloading the God's Eye View source",
  resolving: 'Unpacking the download',
  updating: 'Preparing files',
};

function defaultTimers(): ControllerTimers {
  return {
    setTimeout: (fn, ms) => {
      const h = setTimeout(fn, ms);
      h.unref();
      return h;
    },
    clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
    setInterval: (fn, ms) => {
      const h = setInterval(fn, ms);
      h.unref();
      return h;
    },
    clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
  };
}

async function defaultDiskFree(dir: string): Promise<number> {
  const s = await statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/** Creates the controller. Nothing happens until `start()` is called. */
export function createController(deps: ControllerDeps): ShellController {
  const log = deps.log.scope('controller');
  const { checkout, install, server, ring, ui, secrets, paths } = deps;
  const now = deps.now ?? Date.now;
  const timers = deps.timers ?? defaultTimers();
  const diskFree = deps.diskFree ?? defaultDiskFree;
  const hasEnvKey = deps.envFileHasKey ?? realEnvFileHasKey;
  const ports = deps.ports ?? { isPortFree: (p: number) => isPortFree(p), findFreePort };
  const fetchImpl: typeof fetch = deps.fetchImpl ?? ((input, init) => fetch(input, init));

  let state: ShellState = deps.initialState;
  const machine = createPhaseMachine({ log, hasRollbackMarker: () => state.rollbackCommit !== null });

  const engineOverrides = resolveEngineOverrides(deps.env);
  const refOverride = engineOverrides.ref;
  const effectiveRemote = (): string => engineOverrides.remoteUrl ?? state.remoteUrl;

  const updater: UpdateManager =
    deps.update ??
    createUpdateManager({
      checkout,
      install,
      log: deps.log,
      appVersion: deps.appVersion,
      remoteUrl: effectiveRemote,
      channel: () => state.channel,
      refOverride,
    });

  // ---- mutable view state ----
  let progress: Progress | null = null;
  let message: string = PHASE_MESSAGES.BOOT;
  let error: UserError | null = null;
  let pending: { target: ResolvedTarget | null; disclosure: Disclosure } | null = null;
  let notices: string[] = [];
  let preferencesOpen = false;
  let aboutOpen = false;
  let versionsCache: Versions | null = null;
  let aiStatus: Pick<AiPrefsPublic, 'hasOpenRouterKey' | 'hasXaiKey' | 'encryptionAvailable'> = {
    hasOpenRouterKey: false,
    hasXaiKey: false,
    encryptionAvailable: false,
  };
  let runningPort: number | null = null;
  let mainUrl: string | null = null;

  // ---- lifecycle bookkeeping ----
  const listeners = new Set<(s: PublicState) => void>();
  const abort = new AbortController();
  let started = false;
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;
  let unsubscribeServer: (() => void) | null = null;
  let lastEmitAt = Number.NEGATIVE_INFINITY;
  let tickTimer: unknown = null;
  let launchTimer: unknown = null;
  let shellTimer: unknown = null;
  let checkInterval: unknown = null;
  let backgroundScheduled = false;
  const sleepers = new Set<{ handle: unknown; resolve: () => void }>();
  let saveQueue: Promise<void> = Promise.resolve();
  let lastAutoRestartAt: number | null = null;
  let installedSinceStart = false;
  /** Provider the running (or last started) engine was launched with; null before the first launch. */
  let launchedProvider: AiProvider | null = null;
  /** Unexpected exit seen while the phase was CHECKING or DISCLOSING; handled when RUNNING resumes. */
  let missedCrash: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  /** In-memory back-off: no background check before this time after an offline result. */
  let offlineUntil = 0;
  let updateInFlight: string | null = null;
  let pendingFailOnce = deps.env['OPENTAC_FAIL_START_ONCE'] === '1';

  // ---- gateway ----
  let gateway: AiGateway | null = null;
  let gatewayKey: string | null = null;

  // -------------------------------------------------------------------------
  // Publishing
  // -------------------------------------------------------------------------

  function aiPublic(): AiPrefsPublic {
    return {
      provider: state.ai.provider,
      model: state.ai.model,
      ollamaHost: state.ai.ollamaHost,
      ...aiStatus,
    };
  }

  function buildPublicState(): PublicState {
    return {
      phase: machine.phase(),
      progress,
      message,
      logTail: ring.tail(200),
      disclosure: machine.phase() === 'DISCLOSING' ? (pending?.disclosure ?? null) : null,
      error,
      port: runningPort ?? state.lastPort,
      prefs: { channel: state.channel, updateCheckOnLaunch: state.updateCheckOnLaunch },
      ai: aiPublic(),
      versions: versionsCache,
      notices: [...notices],
      preferencesOpen,
      aboutOpen,
    };
  }

  function emitNow(): void {
    if (tickTimer !== null) {
      timers.clearTimeout(tickTimer);
      tickTimer = null;
    }
    lastEmitAt = now();
    const snapshot = buildPublicState();
    try {
      ui.pushState(snapshot);
    } catch (err) {
      log.warn(`ui.pushState threw: ${errText(err)}`);
    }
    for (const cb of [...listeners]) {
      try {
        cb(snapshot);
      } catch (err) {
        log.warn(`state listener threw: ${errText(err)}`);
      }
    }
  }

  /** Throttled push for progress and log ticks. */
  function tick(): void {
    if (shuttingDown) return;
    const since = now() - lastEmitAt;
    if (since >= PUSH_THROTTLE_MS) {
      emitNow();
    } else if (tickTimer === null) {
      tickTimer = timers.setTimeout(() => {
        tickTimer = null;
        emitNow();
      }, PUSH_THROTTLE_MS - since);
    }
  }

  function setProgress(label: string, pct: number | null = null): void {
    progress = { pct, label };
    tick();
  }

  function addNotice(text: string): void {
    notices = [...notices, text].slice(-MAX_NOTICES);
    emitNow();
  }

  function transition(to: Phase, reason: string): void {
    const from = machine.transition(to, reason);
    if (from === 'ERROR' || from === 'CRASHED') error = null;
    if (from === 'DISCLOSING') pending = null;
    progress = null;
    message = to === 'ERROR' && error !== null ? error.message : PHASE_MESSAGES[to];
    if (to !== 'RUNNING' && to !== 'CHECKING') {
      preferencesOpen = false;
      aboutOpen = false;
    }
    emitNow();
  }

  // -------------------------------------------------------------------------
  // Small utilities
  // -------------------------------------------------------------------------

  async function persist(patch: Partial<ShellState>): Promise<void> {
    state = updateState(state, patch);
    const snapshot = state;
    saveQueue = saveQueue
      .catch(() => undefined)
      .then(() => deps.saveState(snapshot))
      .catch((err: unknown) => {
        log.error(`could not save state: ${errText(err)}`);
      });
    await saveQueue;
  }

  function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const entry = { handle: null as unknown, resolve };
      entry.handle = timers.setTimeout(() => {
        sleepers.delete(entry);
        resolve();
      }, ms);
      sleepers.add(entry);
    });
  }

  async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
    let handle: unknown = null;
    const timeout = new Promise<undefined>((resolve) => {
      handle = timers.setTimeout(() => resolve(undefined), ms);
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      if (handle !== null) timers.clearTimeout(handle);
    }
  }

  function fail(err: unknown, ctx: ErrorContext): void {
    if (shuttingDown) {
      log.info(`ignoring ${ctx} failure during shutdown: ${errText(err)}`);
      return;
    }
    log.error(err instanceof Error ? err : String(err));
    const canRollback =
      state.rollbackCommit !== null && (ctx === 'start' || ctx === 'install' || ctx === 'update');
    error = toUserError(err, ctx, { canRollback });
    runningPort = server.isRunning() ? runningPort : null;
    transition('ERROR', `${ctx} failed: ${error.code}`);
    ui.showSetup();
  }

  /** Runs `fn`; on failure reports it through {@link fail} and returns undefined. */
  async function guarded<T>(ctx: ErrorContext, fn: () => Promise<T>): Promise<{ value: T } | null> {
    try {
      return { value: await fn() };
    } catch (err) {
      fail(err, ctx);
      return null;
    }
  }

  function engineOrigin(p: number): string {
    return `http://127.0.0.1:${p}`;
  }

  async function refreshAiStatus(): Promise<void> {
    try {
      const [hasOpenRouterKey, hasXaiKey, encryptionAvailable] = await Promise.all([
        secrets.has('openrouter'),
        secrets.has('xai'),
        secrets.available(),
      ]);
      aiStatus = { hasOpenRouterKey, hasXaiKey, encryptionAvailable };
    } catch (err) {
      log.warn(`could not read secret status: ${errText(err)}`);
    }
  }

  async function refreshGatewayKey(): Promise<void> {
    const provider = state.ai.provider;
    if (provider !== 'openrouter' && provider !== 'xai') {
      gatewayKey = null;
      return;
    }
    try {
      gatewayKey = await secrets.get(provider);
    } catch (err) {
      gatewayKey = null;
      log.warn(`could not read the ${provider} key: ${errText(err)}`);
    }
  }

  function gatewayConfig(): AiGatewayConfig {
    return {
      provider: state.ai.provider,
      model: state.ai.model,
      ollamaHost: state.ai.ollamaHost,
      apiKey: gatewayKey,
    };
  }

  async function stopGateway(): Promise<void> {
    const g = gateway;
    gateway = null;
    if (g === null) return;
    try {
      await g.stop();
    } catch (err) {
      log.warn(`gateway stop failed: ${errText(err)}`);
    }
  }

  /** Starts a fresh gateway (new token) when a non-OpenAI provider is selected; else none. */
  async function prepareGateway(): Promise<{ url: string; token: string } | null> {
    await stopGateway();
    if (state.ai.provider === 'openai') return null;
    await refreshGatewayKey();
    const token = randomBytes(32).toString('hex');
    const g = deps.gatewayFactory({ getConfig: gatewayConfig, authToken: token });
    try {
      const { url } = await g.start();
      gateway = g;
      log.info(`AI gateway for ${state.ai.provider} listening at ${url}`);
      return { url, token };
    } catch (err) {
      log.error(`AI gateway failed to start: ${errText(err)}`);
      addNotice(
        'The AI summary provider could not start, so HUD summaries are off until you restart or change provider.',
      );
      return null;
    }
  }

  async function stopServer(): Promise<void> {
    runningPort = null;
    try {
      await server.stop();
    } catch (err) {
      log.warn(`server stop failed: ${errText(err)}`);
    }
  }

  async function refreshVersions(): Promise<void> {
    try {
      versionsCache = await buildVersions();
      emitNow();
    } catch (err) {
      log.debug(`could not refresh versions: ${errText(err)}`);
    }
  }

  async function buildVersions(): Promise<Versions> {
    let commit: string | null = state.installedCommit;
    try {
      commit = await checkout.head();
    } catch {
      // No checkout yet: fall back to the recorded commit.
    }
    let upstreamTag: string | null = null;
    let stableTag: string | null = null;
    if (commit !== null) {
      try {
        const t = await checkout.resolveTarget(state.channel, commit);
        upstreamTag = t.upstreamTag;
        stableTag = t.stableTag;
      } catch {
        // Tags are cosmetic.
      }
    }
    let bundledNode = 'unknown';
    try {
      bundledNode = await install.bundledNodeVersion();
    } catch {
      // Keep 'unknown'.
    }
    return {
      app: deps.appVersion,
      electron: deps.electronVersion,
      chromium: deps.chromiumVersion,
      bundledNode,
      engine: {
        commit,
        short: commit === null ? null : commit.slice(0, 7),
        upstreamTag,
        stableTag,
        channel: state.channel,
        remote: redactRemoteUrl(effectiveRemote()),
      },
      dataDir: paths.dataDir,
    };
  }

  // -------------------------------------------------------------------------
  // Provisioning steps (clone, checkout, install)
  // -------------------------------------------------------------------------

  async function checkoutTarget(): Promise<void> {
    const target = await checkout.resolveTarget(state.channel, refOverride);
    log.info(`checking out ${labelFor(target)} (${target.commit.slice(0, 7)}) for channel ${state.channel}`);
    await checkout.checkoutDetached(target.commit);
  }

  async function syncRemote(): Promise<void> {
    try {
      const want = effectiveRemote();
      const have = await checkout.remoteUrl();
      if (have !== want) {
        log.info(`origin is ${redactRemoteUrl(have)}; pointing it at ${redactRemoteUrl(want)}`);
        await checkout.setRemoteUrl(want);
      }
    } catch (err) {
      log.warn(`could not check the origin URL: ${errText(err)}`);
    }
  }

  const envBackup = (): string => join(paths.dataDir, 'env.backup');

  async function backUpEnv(): Promise<void> {
    try {
      const data = await readFile(paths.envFile);
      await writeFile(envBackup(), data, { mode: 0o600 });
    } catch {
      // No .env to keep.
    }
  }

  async function restoreEnv(): Promise<void> {
    try {
      await readFile(envBackup());
    } catch {
      return;
    }
    try {
      await readFile(paths.envFile);
    } catch {
      await copyFile(envBackup(), paths.envFile);
      log.info('restored the engine .env after the re-download');
    }
    await rm(envBackup(), { force: true });
  }

  async function cloneAndCheckout(): Promise<void> {
    ring.clear();
    setProgress("Downloading the God's Eye View source from GitHub…");
    await checkout.clone(effectiveRemote(), (p) => {
      setProgress(CLONE_LABELS[p.phase] ?? 'Downloading', p.pct);
    });
    await restoreEnv();
    await checkoutTarget();
  }

  /** Runs `npm ci` (phase already INSTALLING) and records what was installed. */
  async function runInstall(): Promise<void> {
    ring.clear();
    setProgress('Installing dependencies…');
    // `npm ci` wipes node_modules first. Forget the recorded install so a failure or abort
    // leaves needsInstall() true and a rollback reinstalls instead of starting on a broken tree.
    await persist({ installedLockHash: null, installedNodeVersion: null });
    const result = await install.install(
      (p) => {
        ring.push(p.line);
        tick();
      },
      { signal: abort.signal },
    );
    await persist({
      installedLockHash: result.lockHash,
      installedNodeVersion: result.nodeVersion,
      installedCommit: await checkout.head(),
    });
    installedSinceStart = true;
    try {
      const doctor = await withTimeout(install.runDoctor(), DOCTOR_WAIT_MS);
      if (doctor === undefined) log.warn('setup doctor still running; not waiting for it');
      else log.info(`setup doctor: ready=${String(doctor.ready)} exit=${doctor.exitCode}`);
    } catch (err) {
      log.warn(`setup doctor failed to run: ${errText(err)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Starting the server
  // -------------------------------------------------------------------------

  async function pickDifferentPort(exclude: number | null): Promise<number> {
    for (let p = DEFAULT_PORT; p <= DEFAULT_PORT + 100; p += 1) {
      if (p !== exclude && (await ports.isPortFree(p))) return p;
    }
    const p = await ports.findFreePort({ rangeStart: DEFAULT_PORT + 101, rangeEnd: DEFAULT_PORT + 400 });
    return p;
  }

  /** Port pinning (docs/SHELL-DESIGN.md section 6). */
  async function choosePort(): Promise<number> {
    if (state.lastPort === null) {
      return ports.findFreePort({ preferred: DEFAULT_PORT });
    }
    if (await ports.isPortFree(state.lastPort)) return state.lastPort;
    throw new ShellError('PORT_IN_USE', `Port ${state.lastPort} is already in use.`, {
      detail: `Port ${state.lastPort} is not free on 127.0.0.1.`,
    });
  }

  async function launchServer(): Promise<ServerHandle> {
    setProgress("Starting God's Eye View…");
    const port = await choosePort();
    launchedProvider = state.ai.provider;
    const gw = await prepareGateway();
    const extraEnv: Record<string, string> = {};
    if (gw !== null) extraEnv['OPENTAC_AI_GATEWAY_TOKEN'] = gw.token;
    const opts: ServerStartOptions = {
      port,
      firstRun: state.lastSuccessfulStart === null || installedSinceStart,
      shellVersion: deps.appVersion,
      signal: abort.signal,
    };
    if (gw !== null) {
      opts.aiGatewayUrl = gw.url;
      opts.injectPlaceholderOpenAiKey = !(await hasEnvKey(paths.envFile, 'OPENAI_API_KEY'));
    }
    const retryEnv = { ...extraEnv };
    if (pendingFailOnce && state.rollbackCommit !== null) {
      pendingFailOnce = false;
      extraEnv['OPENTAC_FAIL_START_ONCE'] = '1';
      log.warn('OPENTAC_FAIL_START_ONCE: this start will be made to fail once');
    }
    if (Object.keys(extraEnv).length > 0) opts.extraEnv = extraEnv;
    try {
      return await server.start(opts);
    } catch (err) {
      if (!(err instanceof ServerError) || err.code !== 'EADDRINUSE' || shuttingDown) throw err;
      log.warn(`port ${port} was taken between the probe and the start; retrying once in 1 s`);
      await sleep(EADDRINUSE_RETRY_MS);
      if (shuttingDown) throw err;
      const retry: ServerStartOptions = { ...opts };
      if (Object.keys(retryEnv).length > 0) retry.extraEnv = retryEnv;
      else delete retry.extraEnv;
      return server.start(retry);
    }
  }

  function isRollbackEligible(err: unknown): boolean {
    return err instanceof ServerError && err.code !== 'EADDRINUSE' && err.code !== 'ABORTED';
  }

  function enterRunning(handle: ServerHandle, reason: string): void {
    runningPort = handle.port;
    missedCrash = null;
    transition('RUNNING', reason);
    ui.setEngineOrigin(engineOrigin(handle.port));
    if (ui.hasMain() && mainUrl === handle.url) {
      ui.setMainEnabled(true);
      ui.reloadMain();
    } else {
      mainUrl = handle.url;
      ui.showMain(handle.url);
      ui.setMainEnabled(true);
    }
    ui.hideSetup();
    scheduleBackgroundChecks();
    void refreshVersions();
  }

  /**
   * Phase is STARTING. Starts the server and, on success, records it and enters RUNNING.
   * On failure: rolls back when allowed and a marker exists, else goes to ERROR.
   */
  async function startAndRun(
    ctx: 'start' | 'rollback',
    allowRollback: boolean,
    reason: string,
  ): Promise<boolean> {
    let handle: ServerHandle;
    try {
      handle = await launchServer();
    } catch (err) {
      if (shuttingDown) return false;
      if (allowRollback && state.rollbackCommit !== null && isRollbackEligible(err)) {
        await performRollback(err);
        return false;
      }
      const isPort =
        err instanceof ShellError || (err instanceof ServerError && err.code === 'EADDRINUSE');
      fail(err, ctx === 'rollback' ? 'rollback' : isPort ? 'port' : 'start');
      return false;
    }
    if (shuttingDown) return false;
    let head: string | null = null;
    try {
      head = await checkout.head();
    } catch (err) {
      log.warn(`could not read HEAD after start: ${errText(err)}`);
    }
    await persist({
      lastSuccessfulStart: new Date(now()).toISOString(),
      lastPort: handle.port,
      rollbackCommit: null,
      ...(head !== null ? { installedCommit: head } : {}),
    });
    installedSinceStart = false;
    enterRunning(handle, reason);
    await settleRunning();
    return true;
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  function logDevOverrides(): void {
    const dev = resolveDevOverrides(deps.env, deps.isPackaged);
    for (const [k, v] of Object.entries(dev)) log.warn(`dev override active: ${k} = ${String(v)}`);
    if (deps.isPackaged) {
      for (const name of [
        'OPENTAC_LAUNCHER_OVERRIDE',
        'OPENTAC_NODE_OVERRIDE',
        'OPENTAC_NPM_CLI_OVERRIDE',
      ]) {
        if ((deps.env[name] ?? '') !== '') log.warn(`${name} is ignored in a packaged build`);
      }
    }
    if (engineOverrides.remoteUrl !== undefined) {
      log.warn(`OPENTAC_ENGINE_REMOTE overrides the remote for this run: ${redactRemoteUrl(engineOverrides.remoteUrl)}`);
    }
    if (refOverride !== undefined) log.warn(`OPENTAC_ENGINE_REF overrides channel resolution: ${refOverride}`);
  }

  async function runBoot(): Promise<void> {
    ui.showSetup();
    logDevOverrides();
    // A retry can arrive while an engine from before the failure is still running
    // (for example after a tag-drift error raised during an update check).
    if (server.isRunning()) await stopServer();

    let free: number | null = null;
    try {
      free = await diskFree(paths.dataDir);
      log.info(`free disk space on the data volume: ${(free / 1024 ** 3).toFixed(1)} GB`);
    } catch (err) {
      log.warn(`could not read free disk space: ${errText(err)}`);
    }
    const lowDisk = free !== null && free < MIN_FREE_BYTES;
    const diskError = (): ShellError =>
      new ShellError('DISK_SPACE', 'There is not enough free disk space.', {
        ...(free !== null ? { freeBytes: free } : {}),
        detail: `${free === null ? '?' : Math.floor(free / 1024 ** 2)} MB free; at least ${MIN_FREE_BYTES / 1024 ** 2} MB needed.`,
      });

    if (lowDisk) return fail(diskError(), 'disk');

    const exists = await checkout.exists();
    let mustInstall = false;
    if (!exists) {
      transition('CLONING', 'no engine checkout yet');
      if ((await guarded('clone', cloneAndCheckout)) === null) return;
      mustInstall = true;
    } else {
      await syncRemote();
      if (state.installedCommit === null) {
        log.info('checkout exists but was never installed; checking out the channel target');
        if ((await guarded('clone', checkoutTarget)) === null) return;
        mustInstall = true;
      }
    }

    if (!mustInstall) {
      const need = await guarded('install', () => install.needsInstall(state));
      if (need === null) return;
      mustInstall = need.value.needed;
      log.info(`needsInstall: ${need.value.needed ? 'yes' : 'no'} (${need.value.reason})`);
    }

    if (mustInstall) {
      transition('INSTALLING', exists ? 'dependencies need installing' : 'fresh checkout');
      if ((await guarded('install', runInstall)) === null) return;
      transition('STARTING', 'install finished');
    } else {
      transition('STARTING', 'checkout and dependencies are current');
    }
    await startAndRun('start', true, 'engine is ready');
  }

  // -------------------------------------------------------------------------
  // Crash handling, restarts
  // -------------------------------------------------------------------------

  async function handleCrash(exit: { code: number | null; signal: NodeJS.Signals | null }): Promise<void> {
    if (shuttingDown) return;
    const phaseNow = machine.phase();
    if (phaseNow === 'CHECKING' || phaseNow === 'DISCLOSING') {
      log.error(`the engine server exited while ${phaseNow}; handling it when the app returns to running`);
      missedCrash = exit;
      return;
    }
    if (phaseNow !== 'RUNNING') return;
    missedCrash = null;
    log.error(`the engine server exited unexpectedly (code=${String(exit.code)}, signal=${String(exit.signal)})`);
    runningPort = null;
    error = crashUserError(exit, ring.tail(1)[0] ?? null);
    transition('CRASHED', 'server exited unexpectedly');
    ui.setMainEnabled(false);
    ui.showSetup();
    const t = now();
    if (lastAutoRestartAt === null || t - lastAutoRestartAt > AUTO_RESTART_GUARD_MS) {
      lastAutoRestartAt = t;
      log.info('restarting the server automatically (once)');
      transition('STARTING', 'automatic restart after a crash');
      await startAndRun('start', false, 'restarted after a crash');
    } else {
      log.warn('not restarting automatically: the previous automatic restart was under 60 s ago');
    }
  }

  async function restartEngine(why: string): Promise<void> {
    const from = machine.phase();
    if (from === 'RUNNING') {
      transition('RESTARTING', why);
      ui.setMainEnabled(false);
      ui.showSetup();
      await stopServer();
      if (shuttingDown) return;
      transition('STARTING', 'restart: server stopped');
    } else if (from === 'CRASHED') {
      transition('STARTING', why);
      ui.showSetup();
      await stopServer();
    } else if (from === 'ERROR') {
      let ok = false;
      try {
        ok = await checkout.exists();
      } catch {
        ok = false;
      }
      if (!ok || machine.phase() !== 'ERROR') {
        log.warn('restartServer ignored: there is no engine checkout to start');
        return;
      }
      transition('STARTING', why);
      ui.showSetup();
      await stopServer();
    } else {
      log.info(`restartServer ignored in phase ${from}`);
      return;
    }
    await startAndRun('start', false, why);
  }

  async function reinstall(): Promise<void> {
    const from = machine.phase();
    if (from === 'RUNNING') {
      transition('RESTARTING', 'reinstall requested');
      ui.setMainEnabled(false);
      ui.showSetup();
      await stopServer();
      transition('INSTALLING', 'reinstall requested');
    } else if (from === 'CRASHED' || from === 'ERROR') {
      await stopServer();
      transition('INSTALLING', 'reinstall requested');
      ui.showSetup();
    } else {
      log.info(`reinstall ignored in phase ${from}`);
      return;
    }
    if ((await guarded('install', runInstall)) === null) return;
    transition('STARTING', 'reinstall finished');
    await startAndRun('start', false, 'reinstalled');
  }

  async function changePort(): Promise<void> {
    if (machine.phase() !== 'ERROR' || (error?.code !== 'PORT_IN_USE' && error?.code !== 'EADDRINUSE')) {
      log.info('changePort ignored: no port problem to fix');
      return;
    }
    const next = await guarded('port', () => pickDifferentPort(state.lastPort));
    if (next === null) return;
    log.warn(`moving the engine from port ${String(state.lastPort)} to ${next.value}`);
    await persist({ lastPort: next.value });
    transition('STARTING', 'user chose a different port');
    ui.showSetup();
    await startAndRun('start', true, 'started on a new port');
  }

  async function resetCheckout(): Promise<void> {
    if (machine.phase() !== 'ERROR') {
      log.info(`resetCheckout ignored in phase ${machine.phase()}`);
      return;
    }
    const yes = await ui.confirm({
      title: 'Download the engine again?',
      message:
        "OpenTac will delete its copy of the God's Eye View files and download them again. Your saved API keys (the engine .env file) are kept.",
      confirmLabel: 'Download again',
      destructive: true,
    });
    if (!yes || machine.phase() !== 'ERROR') return;
    transition('CLONING', 'user reset the checkout');
    ui.showSetup();
    if (
      (await guarded('clone', async () => {
        await stopServer();
        await backUpEnv();
        await rm(paths.checkoutDir, { recursive: true, force: true });
        await persist({
          installedCommit: null,
          installedLockHash: null,
          installedNodeVersion: null,
          rollbackCommit: null,
        });
        await cloneAndCheckout();
      })) === null
    ) {
      return;
    }
    transition('INSTALLING', 'fresh checkout');
    if ((await guarded('install', runInstall)) === null) return;
    transition('STARTING', 'install finished');
    await startAndRun('start', false, 'engine re-downloaded');
  }

  // -------------------------------------------------------------------------
  // Update flow
  // -------------------------------------------------------------------------

  function scheduleBackgroundChecks(): void {
    if (backgroundScheduled || shuttingDown) return;
    backgroundScheduled = true;
    launchTimer = timers.setTimeout(() => {
      launchTimer = null;
      void backgroundUpdateCheck('launch');
    }, LAUNCH_CHECK_DELAY_MS);
    shellTimer = timers.setTimeout(() => {
      shellTimer = null;
      if (shuttingDown) return;
      deps.shellUpdater.check({ interactive: false }).catch((err: unknown) => {
        log.warn(`app update check failed: ${errText(err)}`);
      });
    }, SHELL_CHECK_DELAY_MS);
    checkInterval = timers.setInterval(() => {
      void backgroundUpdateCheck('interval');
    }, CHECK_INTERVAL_MS);
  }

  async function backgroundUpdateCheck(why: string): Promise<void> {
    if (shuttingDown || machine.phase() !== 'RUNNING') return;
    if (!state.updateCheckOnLaunch) {
      log.debug(`${why} update check skipped: automatic checks are off`);
      return;
    }
    if (now() < offlineUntil) {
      log.debug(`${why} update check skipped: GitHub was unreachable a moment ago`);
      return;
    }
    if (!isAutomaticCheckDue(state.lastUpdateCheck, now())) {
      log.debug(`${why} update check skipped: last check was ${String(state.lastUpdateCheck)}`);
      return;
    }
    await runUpdateCheck({ interactive: false });
  }

  async function runUpdateCheck(opts: { interactive: boolean }): Promise<void> {
    if (machine.phase() !== 'RUNNING') {
      log.info(`update check ignored in phase ${machine.phase()}`);
      return;
    }
    const { interactive } = opts;
    notices = [];
    transition('CHECKING', interactive ? 'user asked for an update check' : 'background update check');
    let result: UpdateCheck;
    try {
      result = await updater.check({ interactive });
    } catch (err) {
      if (shuttingDown) return;
      log.error(err instanceof Error ? err : String(err));
      transition('RUNNING', 'update check failed');
      if (interactive) {
        ui.showSetup();
        addNotice("The check for engine updates didn't work. The log has the details.");
      }
      await settleRunning();
      return;
    }
    if (shuttingDown) return;

    if (result.kind !== 'offline') {
      await persist({ lastUpdateCheck: new Date(now()).toISOString() });
    }

    switch (result.kind) {
      case 'offline':
        transition('RUNNING', "couldn't reach GitHub");
        if (interactive) {
          ui.showSetup();
          addNotice("Couldn't reach GitHub. The installed version keeps working.");
        } else {
          log.info("update check: couldn't reach GitHub");
        }
        offlineUntil = now() + OFFLINE_BACKOFF_MS;
        await settleRunning();
        return;
      case 'tag-drift':
        fail(new GitError('TAG_DRIFT', 'A release tag on the remote changed.', result.detail), 'fetch');
        return;
      case 'up-to-date':
        transition('RUNNING', 'engine is up to date');
        if (interactive) {
          void ui.notify({
            title: "God's Eye View is up to date",
            message: `You have ${result.label}, the newest version on this channel.`,
          });
        }
        await settleRunning();
        return;
      case 'blocked-by-shell': {
        const d = result.disclosure;
        if (isQuietlySkipped(state.skippedCommit, d.toCommit, interactive, d.severity)) {
          transition('RUNNING', 'skipped update needs a newer app');
          await settleRunning();
          return;
        }
        pending = { target: null, disclosure: d };
        transition('DISCLOSING', 'engine update needs a newer OpenTac');
        ui.showSetup();
        return;
      }
      case 'available': {
        const d = result.disclosure;
        if (isQuietlySkipped(state.skippedCommit, result.target.commit, interactive, d.severity)) {
          log.info(`update ${d.toLabel} was skipped by the user; staying quiet`);
          transition('RUNNING', 'update skipped by the user');
          await settleRunning();
          return;
        }
        pending = { target: result.target, disclosure: d };
        transition('DISCLOSING', `update available: ${d.fromLabel} -> ${d.toLabel}`);
        ui.showSetup();
        return;
      }
    }
  }

  /** After returning to RUNNING without a restart: apply a provider change that waited. */
  async function settleRunning(): Promise<void> {
    if (shuttingDown || machine.phase() !== 'RUNNING') return;
    if (!server.isRunning()) {
      // The engine died while a check or a disclosure was open; route it through the crash path.
      const exit = missedCrash ?? { code: null, signal: null };
      missedCrash = null;
      await handleCrash(exit);
      return;
    }
    if (launchedProvider !== null && launchedProvider !== state.ai.provider) {
      await restartEngine('summary provider changed');
    }
  }

  async function performRollback(cause: unknown): Promise<void> {
    const back = state.rollbackCommit;
    if (back === null) {
      fail(cause, 'update');
      return;
    }
    log.warn(`rolling back to ${back.slice(0, 7)} because: ${errText(cause)}`);
    const attempted = updateInFlight;
    transition('ROLLING_BACK', `update failed: ${errText(cause)}`);
    ui.showSetup();
    setProgress('Going back to the previous version…');
    const restored = await guarded('rollback', async () => {
      await stopServer();
      await checkout.checkoutDetached(back);
      if ((await install.needsInstall(state)).needed) {
        transition('INSTALLING', 'rollback: dependencies differ from the previous version');
        await runInstall();
      }
      transition('STARTING', 'rollback: previous version restored');
    });
    if (restored === null) return;
    if (attempted !== null) await persist({ skippedCommit: attempted });
    const ok = await startAndRun('rollback', false, 'rolled back to the previous version');
    if (ok) {
      const text = "The update didn't start, so OpenTac went back to the previous version of God's Eye View.";
      addNotice(text);
      void ui.notify({ title: 'Update rolled back', message: text });
      void refreshVersions();
    }
  }

  async function applyUpdate(target: ResolvedTarget, reset: boolean): Promise<void> {
    transition('UPDATING', reset ? 'user confirmed (reset)' : 'user confirmed');
    updateInFlight = target.commit;
    ui.setMainEnabled(false);
    ui.showSetup();
    setProgress('Preparing the update…');
    let from: string;
    try {
      from = await checkout.head();
      await persist({ rollbackCommit: from });
    } catch (err) {
      updateInFlight = null;
      fail(err, 'update');
      return;
    }
    try {
      await stopServer();
      setProgress('Applying the update…');
      if (reset) await checkout.resetToTarget(target.commit);
      else await checkout.checkoutDetached(target.commit);
    } catch (err) {
      if (!shuttingDown) await performRollback(err);
      updateInFlight = null;
      return;
    }
    if (shuttingDown) return;
    let needInstall = false;
    try {
      needInstall =
        (await checkout.lockfileChanged(from, target.commit)) || (await install.needsInstall(state)).needed;
    } catch (err) {
      await performRollback(err);
      updateInFlight = null;
      return;
    }
    if (needInstall) {
      transition('INSTALLING', 'dependencies changed with the update');
      try {
        await runInstall();
      } catch (err) {
        if (!shuttingDown) await performRollback(err);
        updateInFlight = null;
        return;
      }
    }
    if (shuttingDown) return;
    transition('STARTING', 'update applied');
    const ok = await startAndRun('start', true, 'updated');
    if (ok) {
      await persist({ skippedCommit: null });
      void refreshVersions();
    }
    updateInFlight = null;
  }

  function isCleanForPlainUpdate(d: Disclosure): boolean {
    return !d.needsReset && d.dirty.modified.length === 0 && d.dirty.untracked.length === 0;
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async function action(name: ActionName): Promise<void> {
    const phase = machine.phase();
    log.info(`action ${name} in phase ${phase}`);
    switch (name) {
      case 'retry':
        if (phase === 'ERROR') {
          transition('BOOT', 'retry');
          await runBoot();
        } else if (phase === 'CRASHED') {
          await restartEngine('retry after a crash');
        } else {
          log.info(`retry ignored in phase ${phase}`);
        }
        return;
      case 'confirmUpdate':
        if (phase === 'DISCLOSING' && pending?.target && isCleanForPlainUpdate(pending.disclosure)) {
          await applyUpdate(pending.target, false);
        } else {
          log.info('confirmUpdate ignored: nothing to confirm, or the tree needs a reset first');
        }
        return;
      case 'resetAndUpdate':
        if (phase === 'DISCLOSING' && pending?.target && !isCleanForPlainUpdate(pending.disclosure)) {
          await applyUpdate(pending.target, true);
        } else {
          log.info('resetAndUpdate ignored: nothing to reset');
        }
        return;
      case 'laterUpdate':
        if (phase === 'DISCLOSING') {
          transition('RUNNING', 'user chose later');
          ui.hideSetup();
          await settleRunning();
        }
        return;
      case 'skipUpdate':
        if (phase === 'DISCLOSING' && pending !== null) {
          const commit = pending.disclosure.toCommit;
          await persist({ skippedCommit: commit });
          transition('RUNNING', 'user skipped this update');
          ui.hideSetup();
          await settleRunning();
        }
        return;
      case 'restartServer':
        await restartEngine('restart requested');
        return;
      case 'reinstall':
        await reinstall();
        return;
      case 'rollback':
        if ((phase === 'ERROR' || phase === 'CRASHED') && state.rollbackCommit !== null) {
          transition('STARTING', 'user asked to roll back');
          ui.showSetup();
          await performRollback(new Error('The previous version was requested by the user.'));
        } else {
          log.info('rollback ignored: there is no rollback marker or the phase does not allow it');
        }
        return;
      case 'changePort':
        await changePort();
        return;
      case 'resetCheckout':
        await resetCheckout();
        return;
      case 'checkForUpdates':
        await controller.checkForEngineUpdates();
        return;
      case 'checkForAppUpdates':
        await controller.checkForAppUpdates();
        return;
      case 'openPreferences':
        preferencesOpen = true;
        aboutOpen = false;
        ui.showSetup();
        emitNow();
        return;
      case 'closePreferences':
        // Closes whichever overlay is open (Preferences or About) so one action serves both panels.
        preferencesOpen = false;
        aboutOpen = false;
        if (machine.phase() === 'RUNNING') ui.hideSetup();
        emitNow();
        return;
      case 'showLogs':
        // The IPC layer intercepts this and opens the logs folder; nothing to do here.
        return;
      case 'quit':
        if (deps.requestQuit !== undefined) deps.requestQuit();
        else log.info('quit requested but no quit handler is installed');
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Preferences and AI
  // -------------------------------------------------------------------------

  async function setPrefs(patch: Partial<Prefs>): Promise<void> {
    const channelChanged = patch.channel !== undefined && patch.channel !== state.channel;
    const change: Partial<ShellState> = {};
    if (patch.channel !== undefined) change.channel = patch.channel;
    if (patch.updateCheckOnLaunch !== undefined) change.updateCheckOnLaunch = patch.updateCheckOnLaunch;
    if (Object.keys(change).length === 0) return;
    await persist(change);
    emitNow();
    if (channelChanged) {
      log.info(`channel is now ${state.channel}`);
      if (machine.phase() === 'RUNNING') await runUpdateCheck({ interactive: true });
    }
  }

  async function setAi(payload: SetAiPayload): Promise<void> {
    const previous = state.ai.provider;
    await persist({
      ai: { provider: payload.provider, model: payload.model, ollamaHost: payload.ollamaHost },
    });
    await refreshGatewayKey();
    emitNow();
    if (payload.provider === previous) return;
    log.info(`summary provider changed: ${previous} -> ${payload.provider}`);
    // Outside RUNNING the change is picked up by the next launch, or by settleRunning()
    // when the app returns to RUNNING with an engine launched on the old provider.
    if (machine.phase() === 'RUNNING') await restartEngine('summary provider changed');
  }

  async function setAiKey(payload: SetAiKeyPayload): Promise<void> {
    if (!(await secrets.available())) {
      throw new Error(
        'Secure storage is not available on this Mac, so OpenTac cannot save an API key. Sign in to your Mac account normally and restart OpenTac.',
      );
    }
    await secrets.set(payload.provider, payload.key === '' ? null : payload.key);
    await refreshAiStatus();
    if (state.ai.provider === payload.provider) await refreshGatewayKey();
    emitNow();
  }

  async function testAi(): Promise<AiTestResultPublic> {
    if (state.ai.provider === 'openai') {
      return {
        ok: false,
        text: '',
        latencyMs: 0,
        finishReason: null,
        error:
          'OpenAI summaries are sent by the engine itself, so there is nothing to test here. Choose Ollama, OpenRouter or xAI to test a different provider.',
      };
    }
    await refreshGatewayKey();
    const g =
      gateway ??
      deps.gatewayFactory({ getConfig: gatewayConfig, authToken: randomBytes(32).toString('hex') });
    try {
      const r = await g.testPrompt(gatewayConfig());
      return {
        ok: r.ok,
        text: r.text,
        latencyMs: r.latencyMs,
        finishReason: r.finishReason,
        error: r.error,
      };
    } catch (err) {
      return {
        ok: false,
        text: '',
        latencyMs: 0,
        finishReason: null,
        error: `The test could not run: ${errText(err)}`,
      };
    }
  }

  async function listOllamaModels(): Promise<{ models: string[]; error: string | null }> {
    const raw = (state.ai.ollamaHost ?? '').trim() || DEFAULT_OLLAMA_HOST;
    const host = (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`).replace(/\/+$/, '');
    try {
      const res = await fetchImpl(`${host}/api/tags`, { signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS) });
      if (!res.ok) {
        return { models: [], error: `Ollama at ${host} answered with HTTP ${res.status}.` };
      }
      const body = (await res.json()) as { models?: Array<{ name?: unknown; model?: unknown }> };
      const models: string[] = [];
      for (const m of body.models ?? []) {
        const n = typeof m.name === 'string' ? m.name : typeof m.model === 'string' ? m.model : null;
        if (n !== null && n !== '') models.push(n);
      }
      return { models, error: null };
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return {
        models: [],
        error: timedOut
          ? `Ollama at ${host} didn't answer within 10 seconds.`
          : `Couldn't reach Ollama at ${host}. Make sure Ollama is running and the address is right.`,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  const controller: ShellController = {
    async start() {
      if (started) {
        log.info('start() called again; ignored');
        return;
      }
      started = true;
      unsubscribeServer = server.onEvent((e) => {
        if (e.type === 'line') {
          const p = machine.phase();
          if (p === 'STARTING' || p === 'RESTARTING') tick();
        } else if (e.type === 'exit' && !e.expected) {
          void handleCrash(e);
        }
      });
      await refreshAiStatus();
      log.info(`OpenTac ${deps.appVersion} controller starting (packaged=${String(deps.isPackaged)})`);
      emitNow();
      try {
        await runBoot();
      } catch (err) {
        fail(err, 'start');
      }
    },
    phase: () => machine.phase(),
    state: () => state,
    publicState: buildPublicState,
    action,
    setPrefs,
    setAi,
    setAiKey,
    testAi,
    listOllamaModels,
    async versions() {
      versionsCache = await buildVersions();
      return versionsCache;
    },
    engineUrl: () => (machine.phase() === 'RUNNING' && runningPort !== null ? `http://127.0.0.1:${runningPort}/` : null),
    shutdown() {
      shutdownPromise ??= (async () => {
        shuttingDown = true;
        abort.abort();
        for (const h of [launchTimer, shellTimer, tickTimer]) {
          if (h !== null) timers.clearTimeout(h);
        }
        if (checkInterval !== null) timers.clearInterval(checkInterval);
        launchTimer = shellTimer = tickTimer = checkInterval = null;
        for (const s of [...sleepers]) {
          timers.clearTimeout(s.handle);
          s.resolve();
        }
        sleepers.clear();
        unsubscribeServer?.();
        unsubscribeServer = null;
        await stopServer();
        await stopGateway();
        await saveQueue.catch(() => undefined);
        try {
          await deps.saveState(state);
        } catch (err) {
          log.error(`final state save failed: ${errText(err)}`);
        }
        listeners.clear();
        log.info('controller shut down');
      })();
      return shutdownPromise;
    },
    onState(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    async checkForEngineUpdates() {
      const p = machine.phase();
      if (p === 'RUNNING') await runUpdateCheck({ interactive: true });
      else if (p === 'DISCLOSING') ui.showSetup();
      else log.info(`checkForEngineUpdates ignored in phase ${p}`);
    },
    async checkForAppUpdates() {
      try {
        await deps.shellUpdater.check({ interactive: true });
      } catch (err) {
        log.warn(`app update check failed: ${errText(err)}`);
        addNotice("The check for OpenTac updates didn't work. The log has the details.");
      }
    },
    disclosure: () => (machine.phase() === 'DISCLOSING' ? (pending?.disclosure ?? null) : null),
    notifyResume() {
      void backgroundUpdateCheck('resume');
    },
    notifyMainFocus() {
      void backgroundUpdateCheck('focus');
    },
    openAbout() {
      aboutOpen = true;
      preferencesOpen = false;
      ui.showSetup();
      emitNow();
    },
    closeAbout() {
      aboutOpen = false;
      if (machine.phase() === 'RUNNING' && !preferencesOpen) ui.hideSetup();
      emitNow();
    },
  };
  return controller;
}
