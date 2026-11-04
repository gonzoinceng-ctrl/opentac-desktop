/**
 * Hand-written fakes for the controller and update-manager tests. No electron, no network.
 * Every fake appends to a shared `trace` so tests can assert the order of operations.
 */
import { createLogger } from '../../src/main/logger.js';
import type { Logger } from '../../src/main/logger.js';
import type { AiGateway, AiGatewayConfig, AiTestResult } from '../../src/main/aiGateway.js';
import type {
  CheckoutManager,
  CheckoutStatus,
  CommitInfo,
  DirtyReport,
  ResolvedTarget,
  TagAnnotation,
} from '../../src/main/checkout.js';
import type { ControllerTimers } from '../../src/main/controller.js';
import type { SecretsApi, ShellUi, ShellUpdaterApi } from '../../src/main/contracts.js';
import type { InstallManager, InstallProgress, InstallResult, NeedsInstall } from '../../src/main/install.js';
import {
  ServerError,
  type ServerEvent,
  type ServerHandle,
  type ServerManager,
  type ServerStartOptions,
} from '../../src/main/server.js';
import type { UpdateCheck, UpdateManager } from '../../src/main/update.js';
import type { PublicState } from '../../src/shared/ipc.js';
import { defaultState } from '../../src/main/state.js';
import type { ShellState } from '../../src/shared/types.js';

export const SHA_A = 'a'.repeat(40);
export const SHA_B = 'b'.repeat(40);
export const SHA_C = 'c'.repeat(40);

/** Logger that keeps every line in `out` ("level:message"). */
export function testLogger(): { log: Logger; out: string[] } {
  const out: string[] = [];
  const log = createLogger({
    info: (m) => out.push(`info:${m}`),
    warn: (m) => out.push(`warn:${m}`),
    error: (m) => out.push(`error:${m}`),
    debug: (m) => out.push(`debug:${m}`),
  });
  return { log, out };
}

/** Lets pending promise continuations run (several macrotask turns). */
export async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise<void>((r) => setImmediate(r));
}

/** Polls until `cond` holds; throws after `ms`. */
export async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---------------------------------------------------------------------------
// Fake timers and clock
// ---------------------------------------------------------------------------

export interface FakeClock {
  timers: ControllerTimers;
  now(): number;
  /** Advances the clock, firing due timers in order and letting promises settle between them. */
  advance(ms: number): Promise<void>;
  /** Number of timers/intervals still scheduled. */
  pending(): number;
  /** Delays (ms) of the scheduled timers, sorted. */
  pendingDelays(): number[];
}

export const BASE_TIME = Date.parse('2026-11-03T12:00:00.000Z');

export function createFakeClock(): FakeClock {
  let current = BASE_TIME;
  let nextId = 1;
  const entries = new Map<number, { at: number; fn: () => void; every: number | null; ms: number }>();
  const clock: FakeClock = {
    timers: {
      setTimeout(fn, ms) {
        const id = nextId++;
        entries.set(id, { at: current + ms, fn, every: null, ms });
        return id;
      },
      clearTimeout(h) {
        entries.delete(h as number);
      },
      setInterval(fn, ms) {
        const id = nextId++;
        entries.set(id, { at: current + ms, fn, every: ms, ms });
        return id;
      },
      clearInterval(h) {
        entries.delete(h as number);
      },
    },
    now: () => current,
    async advance(ms) {
      const target = current + ms;
      for (;;) {
        let nextId2: number | null = null;
        let nextAt = Infinity;
        for (const [id, e] of entries) {
          if (e.at <= target && e.at < nextAt) {
            nextAt = e.at;
            nextId2 = id;
          }
        }
        if (nextId2 === null) break;
        const e = entries.get(nextId2);
        if (e === undefined) break;
        current = Math.max(current, e.at);
        if (e.every !== null) e.at += e.every;
        else entries.delete(nextId2);
        e.fn();
        await flush();
      }
      current = target;
      await flush();
    },
    pending: () => entries.size,
    pendingDelays: () => [...entries.values()].map((e) => e.ms).sort((a, b) => a - b),
  };
  return clock;
}

// ---------------------------------------------------------------------------
// Fake checkout
// ---------------------------------------------------------------------------

export function target(commit: string, extra: Partial<ResolvedTarget> = {}): ResolvedTarget {
  return {
    channel: 'stable',
    ref: 'refs/remotes/origin/stable',
    commit,
    upstreamTag: null,
    stableTag: null,
    ...extra,
  };
}

export function cleanDirty(): DirtyReport {
  return { dirty: false, modified: [], untracked: [], raw: '' };
}

/** Configurable fake. Public fields are the knobs; `calls` records every method name. */
export class FakeCheckout implements CheckoutManager {
  calls: string[] = [];
  existsValue = true;
  headSha = SHA_A;
  targetSha = SHA_B;
  targetExtra: Partial<ResolvedTarget> = {};
  statusOverride: Partial<CheckoutStatus> | null = null;
  dirty: DirtyReport = cleanDirty();
  behind = 1;
  isAncestor = true;
  log: { commits: CommitInfo[]; truncated: boolean } = { commits: [], truncated: false };
  stat = '1 file changed';
  lockChanged = false;
  annotation: TagAnnotation | null = null;
  remote = 'https://github.com/o/r.git';
  lsRemoteResult: Record<string, string> | Error = { 'refs/heads/stable': SHA_B };
  fetchError: Error | null = null;
  cloneError: Error | null = null;
  checkoutError: Error | null = null;
  resolveTags: Record<string, Partial<ResolvedTarget>> = {};

  constructor(private readonly trace: string[] = []) {}

  private rec(name: string): void {
    this.calls.push(name);
    this.trace.push(`checkout.${name}`);
  }
  count(name: string): number {
    return this.calls.filter((c) => c === name).length;
  }

  async exists(): Promise<boolean> {
    this.rec('exists');
    return this.existsValue;
  }
  async clone(_remote: string, onProgress: (p: { phase: string; pct: number }) => void): Promise<void> {
    this.rec('clone');
    this.cloneRemotes.push(_remote);
    onProgress({ phase: 'receiving', pct: 50 });
    if (this.cloneError !== null) throw this.cloneError;
    this.existsValue = true;
  }
  cloneRemotes: string[] = [];
  async fetch(): Promise<void> {
    this.rec('fetch');
    if (this.fetchError !== null) throw this.fetchError;
  }
  async resolveTarget(channel: ResolvedTarget['channel'], override?: string): Promise<ResolvedTarget> {
    this.rec('resolveTarget');
    if (override !== undefined && this.resolveTags[override] !== undefined) {
      return target(override, { channel, ...this.resolveTags[override] });
    }
    return target(override !== undefined && /^[0-9a-f]{40}$/.test(override) ? override : this.targetSha, {
      channel,
      ...this.targetExtra,
    });
  }
  async head(): Promise<string> {
    this.rec('head');
    return this.headSha;
  }
  async status(t: ResolvedTarget): Promise<CheckoutStatus> {
    this.rec('status');
    return {
      head: this.headSha,
      target: t,
      behind: this.behind,
      ahead: 0,
      isAncestor: this.isAncestor,
      dirty: this.dirty,
      ...this.statusOverride,
    };
  }
  async dirtyReport(): Promise<DirtyReport> {
    this.rec('dirtyReport');
    return this.dirty;
  }
  async checkoutDetached(commit: string): Promise<void> {
    this.rec('checkoutDetached');
    if (this.checkoutError !== null) throw this.checkoutError;
    this.headSha = commit;
  }
  async resetToTarget(commit: string): Promise<void> {
    this.rec('resetToTarget');
    this.headSha = commit;
  }
  async commitLog(): Promise<{ commits: CommitInfo[]; truncated: boolean }> {
    this.rec('commitLog');
    return this.log;
  }
  /** Knob for the uncapped count; null means the length of `log.commits`. */
  countValue: number | null = null;
  async countCommits(): Promise<number> {
    this.rec('countCommits');
    return this.countValue ?? this.log.commits.length;
  }
  async diffStat(): Promise<string> {
    this.rec('diffStat');
    return this.stat;
  }
  async lockfileChanged(): Promise<boolean> {
    this.rec('lockfileChanged');
    return this.lockChanged;
  }
  async tagAnnotation(): Promise<TagAnnotation | null> {
    this.rec('tagAnnotation');
    return this.annotation;
  }
  async remoteUrl(): Promise<string> {
    this.rec('remoteUrl');
    return this.remote;
  }
  async setRemoteUrl(url: string): Promise<void> {
    this.rec('setRemoteUrl');
    this.remote = url;
  }
  lsRemoteRefs: string[][] = [];
  async lsRemote(_remoteUrl?: string, refs?: string[]): Promise<Record<string, string>> {
    this.rec('lsRemote');
    this.lsRemoteRefs.push(refs ?? []);
    if (this.lsRemoteResult instanceof Error) throw this.lsRemoteResult;
    return this.lsRemoteResult;
  }
  async repoSizeBytes(): Promise<number> {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Fake install
// ---------------------------------------------------------------------------

export class FakeInstall implements InstallManager {
  calls: string[] = [];
  needs: NeedsInstall = { needed: false, reason: 'up-to-date' };
  installError: Error | null = null;
  lock: string | null = 'lock-1';
  result: InstallResult = { durationMs: 1, lockHash: 'lock-1', nodeVersion: '24.22.2', attempts: 1 };
  doctorHangs = false;

  constructor(private readonly trace: string[] = []) {}

  async lockHash(): Promise<string | null> {
    return this.lock;
  }
  async bundledNodeVersion(): Promise<string> {
    return '24.22.2';
  }
  async needsInstall(
    state?: Pick<ShellState, 'installedLockHash' | 'installedNodeVersion' | 'installedCommit'>,
  ): Promise<NeedsInstall> {
    this.calls.push('needsInstall');
    // Like the real manager: no recorded install means an install is needed.
    if (state !== undefined && (state.installedLockHash === null || state.installedNodeVersion === null)) {
      return { needed: true, reason: 'never-installed' };
    }
    return this.needs;
  }
  async install(onProgress: (p: InstallProgress) => void): Promise<InstallResult> {
    this.calls.push('install');
    this.trace.push('install');
    onProgress({ line: 'added 1 package', stream: 'stdout' });
    if (this.installError !== null) throw this.installError;
    return this.result;
  }
  async runDoctor(): Promise<{ output: string; ready: boolean; exitCode: number }> {
    this.calls.push('runDoctor');
    if (this.doctorHangs) return new Promise(() => undefined);
    return { output: '', ready: true, exitCode: 0 };
  }
  count(name: string): number {
    return this.calls.filter((c) => c === name).length;
  }
}

// ---------------------------------------------------------------------------
// Fake server
// ---------------------------------------------------------------------------

export class FakeServer implements ServerManager {
  starts: ServerStartOptions[] = [];
  stops = 0;
  /** Results consumed one per start(); when empty every start succeeds. */
  startQueue: Array<Error | 'ok'> = [];
  private listeners = new Set<(e: ServerEvent) => void>();
  private current: ServerHandle | null = null;

  constructor(private readonly trace: string[] = []) {}

  async start(opts: ServerStartOptions): Promise<ServerHandle> {
    this.starts.push(opts);
    this.trace.push('server.start');
    if (this.current !== null) throw new ServerError('ALREADY_RUNNING', 'The server is already running or starting.');
    const next = this.startQueue.shift();
    if (next instanceof Error) throw next;
    this.current = { port: opts.port, url: `http://127.0.0.1:${opts.port}/`, pid: 4242 };
    return this.current;
  }
  /** When set, stop() waits for it (a slow shutdown). */
  stopGate: Promise<void> | null = null;
  async stop(): Promise<void> {
    this.stops += 1;
    this.trace.push('server.stop');
    if (this.stopGate !== null) await this.stopGate;
    this.current = null;
  }
  isRunning(): boolean {
    return this.current !== null;
  }
  handle(): ServerHandle | null {
    return this.current;
  }
  onEvent(cb: (e: ServerEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  logTail(): string[] {
    return [];
  }
  emit(e: ServerEvent): void {
    if (e.type === 'exit' && !e.expected) this.current = null;
    for (const cb of [...this.listeners]) cb(e);
  }
  listenerCount(): number {
    return this.listeners.size;
  }
}

// ---------------------------------------------------------------------------
// Fake UI, secrets, shell updater, gateway, update manager
// ---------------------------------------------------------------------------

export class FakeUi implements ShellUi {
  calls: string[] = [];
  pushed: PublicState[] = [];
  mainUrl: string | null = null;
  engineOrigin: string | null = null;
  confirmAnswer = true;
  constructor(private readonly trace: string[] = []) {}
  private rec(c: string): void {
    this.calls.push(c);
    this.trace.push(`ui.${c}`);
  }
  count(name: string): number {
    return this.calls.filter((c) => c === name || c.startsWith(`${name}:`)).length;
  }
  showSetup(): void {
    this.rec('showSetup');
  }
  hideSetup(): void {
    this.rec('hideSetup');
  }
  showMain(url: string): void {
    this.mainUrl = url;
    this.rec(`showMain:${url}`);
  }
  setMainEnabled(enabled: boolean): void {
    this.rec(`setMainEnabled:${String(enabled)}`);
  }
  reloadMain(): void {
    this.rec('reloadMain');
  }
  hasMain(): boolean {
    return this.mainUrl !== null;
  }
  pushState(state: PublicState): void {
    this.pushed.push(state);
  }
  setEngineOrigin(origin: string | null): void {
    this.engineOrigin = origin;
    this.rec(`setEngineOrigin:${String(origin)}`);
  }
  async confirm(): Promise<boolean> {
    this.rec('confirm');
    return this.confirmAnswer;
  }
  async notify(opts: { title: string }): Promise<void> {
    this.rec(`notify:${opts.title}`);
  }
}

export class FakeSecrets implements SecretsApi {
  store: Partial<Record<'openrouter' | 'xai', string>> = {};
  isAvailable = true;
  async available(): Promise<boolean> {
    return this.isAvailable;
  }
  async get(name: 'openrouter' | 'xai'): Promise<string | null> {
    return this.store[name] ?? null;
  }
  async set(name: 'openrouter' | 'xai', value: string | null): Promise<void> {
    if (value === null) delete this.store[name];
    else this.store[name] = value;
  }
  async has(name: 'openrouter' | 'xai'): Promise<boolean> {
    return this.store[name] !== undefined;
  }
}

export class FakeShellUpdater implements ShellUpdaterApi {
  checks: Array<{ interactive: boolean }> = [];
  async check(opts: { interactive: boolean }): Promise<void> {
    this.checks.push(opts);
  }
  pending(): boolean {
    return false;
  }
  quitAndInstall(): void {}
}

export class FakeGateway implements AiGateway {
  started = 0;
  stopped = 0;
  testConfigs: AiGatewayConfig[] = [];
  constructor(
    readonly getConfig: () => AiGatewayConfig,
    readonly authToken: string,
  ) {}
  async start(): Promise<{ port: number; url: string }> {
    this.started += 1;
    return { port: 5555, url: 'http://127.0.0.1:5555' };
  }
  async stop(): Promise<void> {
    this.stopped += 1;
  }
  url(): string | null {
    return this.started > this.stopped ? 'http://127.0.0.1:5555' : null;
  }
  async testPrompt(cfg?: AiGatewayConfig): Promise<AiTestResult> {
    this.testConfigs.push(cfg ?? this.getConfig());
    return {
      ok: true,
      text: 'OK',
      latencyMs: 12,
      finishReason: 'stop',
      error: null,
      provider: (cfg ?? this.getConfig()).provider,
      model: (cfg ?? this.getConfig()).model,
    };
  }
}

/** UpdateManager whose results are queued by the test. */
export class FakeUpdate implements UpdateManager {
  results: Array<UpdateCheck | Error> = [];
  checks: Array<{ interactive: boolean }> = [];
  fallback: UpdateCheck = { kind: 'up-to-date', label: 'v0.1.0' };
  async check(opts: { interactive: boolean }): Promise<UpdateCheck> {
    this.checks.push(opts);
    const next = this.results.shift() ?? this.fallback;
    if (next instanceof Error) throw next;
    return next;
  }
}

export function stateWith(patch: Partial<ShellState> = {}): ShellState {
  return { ...defaultState(), remoteUrl: 'https://github.com/o/r.git', ...patch };
}
