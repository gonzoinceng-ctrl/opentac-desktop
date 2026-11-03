import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as sleep } from 'node:timers/promises';
import treeKill from 'tree-kill';
import { proxyEnvFor } from '../shared/appSettings.js';
import { redact } from '../shared/redact.js';
import type { ProxySettings } from '../shared/types.js';
import type { Logger } from './logger.js';
import type { RingBuffer } from './ringBuffer.js';

/** Stable error codes thrown by the server manager. */
export type ServerErrorCode =
  | 'EADDRINUSE'
  | 'START_FAILED'
  | 'START_TIMEOUT'
  | 'VITE_MISSING'
  | 'ABORTED'
  | 'ALREADY_RUNNING';

/** Error thrown by {@link ServerManager}; `message` is a plain sentence, `detail` carries raw output. */
export class ServerError extends Error {
  readonly code: ServerErrorCode;
  readonly detail?: string;
  readonly exitCode?: number;

  constructor(
    code: ServerErrorCode,
    message: string,
    extra: { detail?: string; exitCode?: number } = {},
  ) {
    super(message);
    this.name = 'ServerError';
    this.code = code;
    if (extra.detail !== undefined) this.detail = extra.detail;
    if (extra.exitCode !== undefined) this.exitCode = extra.exitCode;
  }
}

/** Events emitted by a {@link ServerManager}. */
export type ServerEvent =
  | { type: 'line'; stream: 'stdout' | 'stderr'; line: string }
  | { type: 'ready'; url: string; port: number; pid: number }
  | {
      type: 'exit';
      code: number | null;
      signal: NodeJS.Signals | null;
      expected: boolean;
    };

/** Options for {@link ServerManager.start}. */
export interface ServerStartOptions {
  port: number;
  firstRun: boolean;
  shellVersion: string;
  aiGatewayUrl?: string;
  injectPlaceholderOpenAiKey?: boolean;
  /** App settings proxy; becomes HTTPS_PROXY, HTTP_PROXY, NO_PROXY and NODE_USE_ENV_PROXY. */
  proxy?: ProxySettings;
  extraEnv?: Record<string, string>;
  signal?: AbortSignal;
  /** Overall readiness deadline; default 120000 when firstRun else 60000. */
  readinessTimeoutMs?: number;
}

/** A running, ready server. */
export interface ServerHandle {
  port: number;
  url: string;
  pid: number;
}

/** Spawns, watches and stops the upstream server through the OpenTac launcher. */
export interface ServerManager {
  /**
   * Spawns the launcher and resolves once the ready line was printed and the URL answers 200.
   * Throws {@link ServerError}; on any failure the child is already gone.
   */
  start(opts: ServerStartOptions): Promise<ServerHandle>;
  /** SIGTERM the process group, wait, SIGKILL the group, tree-kill as fallback. Idempotent. */
  stop(opts?: { timeoutMs?: number }): Promise<void>;
  /** True while a child that reached readiness is alive. */
  isRunning(): boolean;
  /** The ready server, or null. */
  handle(): ServerHandle | null;
  /** Subscribes to events; returns the unsubscribe function. */
  onEvent(cb: (e: ServerEvent) => void): () => void;
  /** The newest `n` (default 200) server output lines from the ring buffer. */
  logTail(n?: number): string[];
}

/** Dependencies of {@link createServerManager}; the last three exist for tests. */
export interface ServerManagerOptions {
  nodeBin: string;
  launcherScript: string;
  checkoutDir: string;
  log: Logger;
  ring: RingBuffer;
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof nodeSpawn;
  /** Signal sender, default process.kill (called with a negative pid for the process group). */
  killImpl?: (pid: number, signal: NodeJS.Signals) => void;
  /** Fallback tree killer, default the tree-kill package. */
  treeKillImpl?: (pid: number, signal: string, cb: (err?: Error) => void) => void;
}

/** Value placed in OPENAI_API_KEY so upstream does not short-circuit before its fetch. */
export const PLACEHOLDER_OPENAI_API_KEY = 'opentac-gateway-placeholder';

const DEFAULT_STOP_TIMEOUT_MS = 5000;
const DEFAULT_LOG_TAIL = 200;
const READINESS_TIMEOUT_FIRST_RUN_MS = 120_000;
const READINESS_TIMEOUT_MS = 60_000;
const HTTP_POLL_INTERVAL_MS = 250;
const HTTP_POLL_MAX_MS = 10_000;
const HTTP_ATTEMPT_TIMEOUT_MS = 2000;
const POST_KILL_WAIT_MS = 2000;
const CLOSE_GRACE_MS = 250;
const MAX_LINE_LENGTH = 64 * 1024;
const FAILURE_DETAIL_LINES = 20;
const READY_PREFIX = '[OpenTac] Ready at ';
const READY_LINE = /^\[OpenTac\] Ready at http:\/\/127\.0\.0\.1:(\d{1,5})\/\s*$/;
const RESERVED_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'HOST',
  'PORT',
  'NODE_ENV',
  'OPENTAC',
  'OPENTAC_VERSION',
  'BROWSER',
  'NO_COLOR',
  'FORCE_COLOR',
  'OPENTAC_AI_GATEWAY_URL',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'NODE_USE_ENV_PROXY',
]);

/** Options for {@link buildServerEnv}. */
export interface BuildServerEnvOptions {
  port: number;
  nodeBinDir: string;
  home: string;
  tmpdir: string;
  shellVersion: string;
  aiGatewayUrl?: string;
  placeholderOpenAiKey?: boolean;
  /** Proxy from App settings; the only proxy variables the child ever gets. */
  proxy?: ProxySettings;
  extra?: Record<string, string>;
}

/**
 * Builds the child environment from scratch (never from the parent's env). `extra` entries are
 * copied unless the key starts with ELECTRON_ or npm_config_ (any case) or is one of the keys
 * this function owns (PATH, HOST, PORT, ...), so a caller cannot widen the bind address.
 */
export function buildServerEnv(opts: BuildServerEnvOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(opts.extra ?? {})) {
    if (typeof value !== 'string') continue;
    if (/^(?:electron_|npm_config_)/i.test(key)) continue;
    if (RESERVED_ENV_KEYS.has(key)) continue;
    env[key] = value;
  }
  env['PATH'] = `${opts.nodeBinDir}:/usr/bin:/bin`;
  env['HOME'] = opts.home;
  env['TMPDIR'] = opts.tmpdir;
  env['LANG'] = 'en_US.UTF-8';
  env['HOST'] = '127.0.0.1';
  env['PORT'] = String(opts.port);
  env['NODE_ENV'] = 'development';
  env['OPENTAC'] = '1';
  env['OPENTAC_VERSION'] = opts.shellVersion;
  env['BROWSER'] = 'none';
  env['NO_COLOR'] = '1';
  env['FORCE_COLOR'] = '0';
  if (opts.aiGatewayUrl !== undefined && opts.aiGatewayUrl !== '') {
    env['OPENTAC_AI_GATEWAY_URL'] = opts.aiGatewayUrl;
  }
  if (opts.proxy !== undefined) Object.assign(env, proxyEnvFor(opts.proxy, { nodeEnvProxy: true }));
  if (opts.placeholderOpenAiKey === true) {
    // Unconditional: a real key from `extra` must never reach the local gateway.
    env['OPENAI_API_KEY'] = PLACEHOLDER_OPENAI_API_KEY;
  }
  return env;
}

/**
 * Parses the launcher's `[OpenTac] Ready at http://127.0.0.1:PORT/` line. Vite's own
 * `Local:` line carries the same URL but is deliberately not matched.
 */
export function parseReadyLine(line: string): { url: string; port: number } | null {
  if (!line.startsWith(READY_PREFIX)) return null;
  const match = READY_LINE.exec(line);
  if (match === null) return null;
  const port = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { url: `http://127.0.0.1:${port}/`, port };
}

/** Incremental line splitter for a byte stream. */
export interface LineSplitter {
  /** Feeds a chunk; calls the callback once per completed line (`\n` or `\r\n`). */
  write(chunk: Buffer | string): void;
  /** Emits any trailing partial line. */
  flush(): void;
}

/**
 * Creates a splitter that handles lines spanning chunk boundaries and multi-byte characters
 * split across chunks. A line longer than 64 KiB is emitted in pieces to bound memory.
 */
export function createLineSplitter(onLine: (line: string) => void): LineSplitter {
  const decoder = new StringDecoder('utf8');
  let pending = '';

  function consume(text: string): void {
    pending += text;
    let index = pending.indexOf('\n');
    while (index !== -1) {
      let line = pending.slice(0, index);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      pending = pending.slice(index + 1);
      onLine(line);
      index = pending.indexOf('\n');
    }
    while (pending.length > MAX_LINE_LENGTH) {
      onLine(pending.slice(0, MAX_LINE_LENGTH));
      pending = pending.slice(MAX_LINE_LENGTH);
    }
  }

  return {
    write(chunk) {
      consume(typeof chunk === 'string' ? chunk : decoder.write(chunk));
    },
    flush() {
      const rest = pending + decoder.end();
      pending = '';
      if (rest !== '') onLine(rest.endsWith('\r') ? rest.slice(0, -1) : rest);
    },
  };
}

type Phase = 'starting' | 'running' | 'exited';

interface Run {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly requestedPort: number;
  phase: Phase;
  /** True once the readiness check passed (an exit event is only owed after this). */
  wasReady: boolean;
  expected: boolean;
  stopRequested: boolean;
  finalized: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  sawAddrInUse: boolean;
  readyInfo: { url: string; port: number } | null;
  onReadyLine: ((info: { url: string; port: number }) => void) | null;
  readonly done: Promise<void>;
  resolveDone: () => void;
  stopPromise: Promise<void> | null;
  splitters: LineSplitter[];
  closeTimer: NodeJS.Timeout | null;
  handle: ServerHandle | null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Creates the server manager. See the module docs in 03-ARCHITECTURE.md section 4.3. */
export function createServerManager(opts: ServerManagerOptions): ServerManager {
  const log = opts.log.scope('server');
  const spawnImpl = opts.spawnImpl ?? nodeSpawn;
  const killImpl = opts.killImpl ?? ((pid, signal) => process.kill(pid, signal));
  const treeKillImpl =
    opts.treeKillImpl ??
    ((pid, signal, cb) => {
      treeKill(pid, signal, cb);
    });
  const listeners = new Set<(e: ServerEvent) => void>();
  let current: Run | null = null;

  function emit(event: ServerEvent): void {
    for (const cb of [...listeners]) {
      try {
        cb(event);
      } catch (err) {
        log.error(`event listener threw: ${errorText(err)}`);
      }
    }
  }

  function handleLine(run: Run, stream: 'stdout' | 'stderr', raw: string): void {
    const line = redact(raw);
    opts.ring.push(`[${stream}] ${line}`);
    log.debug(`[${stream}] ${line}`);
    if (/EADDRINUSE/.test(raw)) run.sawAddrInUse = true;
    emit({ type: 'line', stream, line });
    if (run.readyInfo === null && run.onReadyLine !== null) {
      const info = parseReadyLine(raw);
      if (info !== null) {
        run.readyInfo = info;
        run.onReadyLine(info);
      }
    }
  }

  function finalize(run: Run): void {
    if (run.finalized) return;
    run.finalized = true;
    if (run.closeTimer !== null) clearTimeout(run.closeTimer);
    for (const splitter of run.splitters) splitter.flush();
    run.child.stdout?.destroy();
    run.child.stderr?.destroy();
    run.child.stdin?.destroy();
    const wasRunning = run.phase === 'running';
    run.phase = 'exited';
    if (current === run) current = null;
    log.info(
      `launcher pid ${run.pid} exited (code ${run.exitCode ?? 'null'}, signal ${run.exitSignal ?? 'null'}, expected ${run.expected})`,
    );
    run.resolveDone();
    if (wasRunning) {
      emit({ type: 'exit', code: run.exitCode, signal: run.exitSignal, expected: run.expected });
    }
  }

  function signalGroup(run: Run, signal: NodeJS.Signals): void {
    // pid -1 means the spawn failed; never turn that into kill(1) or a broadcast.
    if (run.pid < 2) return;
    try {
      killImpl(-run.pid, signal);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH') log.warn(`signalling group -${run.pid} failed: ${errorText(err)}`);
    }
    try {
      run.child.kill(signal);
    } catch {
      // The child is already gone.
    }
  }

  /** Resolves true when the run finalised within `ms`, false on timeout. */
  async function waitDone(run: Run, ms: number): Promise<boolean> {
    const ac = new AbortController();
    try {
      return await Promise.race([
        run.done.then(() => true),
        sleep(ms, false, { signal: ac.signal }),
      ]);
    } finally {
      ac.abort();
    }
  }

  function runTreeKill(run: Run): Promise<void> {
    return new Promise((resolve) => {
      try {
        treeKillImpl(run.pid, 'SIGKILL', (err) => {
          if (err) log.warn(`tree-kill ${run.pid} failed: ${errorText(err)}`);
          resolve();
        });
      } catch (err) {
        log.warn(`tree-kill ${run.pid} threw: ${errorText(err)}`);
        resolve();
      }
    });
  }

  async function terminate(run: Run, timeoutMs: number): Promise<void> {
    run.expected = true;
    const stopped = log.time(`server stop (pid ${run.pid})`);
    try {
      if (!run.finalized) {
        log.info(`stopping launcher pid ${run.pid} (SIGTERM to group, ${timeoutMs}ms)`);
        signalGroup(run, 'SIGTERM');
        run.child.stdin?.end();
        if (!(await waitDone(run, timeoutMs))) {
          log.warn(`launcher pid ${run.pid} ignored SIGTERM; sending SIGKILL to group`);
          signalGroup(run, 'SIGKILL');
          if (!(await waitDone(run, POST_KILL_WAIT_MS))) {
            log.warn(`launcher pid ${run.pid} survived SIGKILL to group; tree-killing`);
            await runTreeKill(run);
            if (!(await waitDone(run, POST_KILL_WAIT_MS))) {
              log.error(`launcher pid ${run.pid} could not be killed; abandoning it`);
              finalize(run);
            }
          }
        }
      }
      // The leader may have exited while workers in its group live on.
      signalGroup(run, 'SIGKILL');
    } finally {
      stopped();
    }
  }

  function stopRun(run: Run, timeoutMs: number): Promise<void> {
    run.stopRequested = true;
    run.stopPromise ??= terminate(run, timeoutMs);
    return run.stopPromise;
  }

  function classifyExit(run: Run, requestedPort: number): ServerError {
    if (run.stopRequested) {
      return new ServerError('ABORTED', 'The server start was cancelled.');
    }
    const code = run.exitCode;
    const extra = code === null ? {} : { exitCode: code };
    const detail = opts.ring.tail(FAILURE_DETAIL_LINES).join('\n');
    if (code === 98) {
      return new ServerError(
        'VITE_MISSING',
        'The server could not start because its dependencies are not installed.',
        { ...extra, detail },
      );
    }
    if (code === 99 || run.sawAddrInUse) {
      return new ServerError('EADDRINUSE', `Port ${requestedPort} is already in use.`, {
        ...extra,
        detail,
      });
    }
    const how = code === null ? `was stopped by ${run.exitSignal ?? 'a signal'}` : `exited with code ${code}`;
    return new ServerError('START_FAILED', `The server ${how} before it became ready.`, {
      ...extra,
      detail,
    });
  }

  async function pollHttp(url: string, signal: AbortSignal, fetchImpl: typeof fetch): Promise<void> {
    const deadline = Date.now() + HTTP_POLL_MAX_MS;
    let last = 'no response';
    while (!signal.aborted) {
      try {
        const res = await fetchImpl(url, {
          signal: AbortSignal.any([AbortSignal.timeout(HTTP_ATTEMPT_TIMEOUT_MS), signal]),
        });
        await res.body?.cancel().catch(() => undefined);
        if (res.status === 200) return;
        last = `HTTP ${res.status}`;
      } catch (err) {
        last = errorText(err);
      }
      if (signal.aborted) break;
      if (Date.now() >= deadline) {
        throw new ServerError(
          'START_TIMEOUT',
          'The server printed its ready line but did not answer HTTP requests in time.',
          { detail: `GET ${url}: ${last}` },
        );
      }
      try {
        await sleep(HTTP_POLL_INTERVAL_MS, undefined, { signal });
      } catch {
        break;
      }
    }
    throw new ServerError('ABORTED', 'The server start was cancelled.');
  }

  function launch(startOpts: ServerStartOptions): Run {
    const env = buildServerEnv({
      port: startOpts.port,
      nodeBinDir: dirname(opts.nodeBin),
      home: process.env['HOME'] ?? homedir(),
      tmpdir: tmpdir(),
      shellVersion: startOpts.shellVersion,
      ...(startOpts.aiGatewayUrl !== undefined ? { aiGatewayUrl: startOpts.aiGatewayUrl } : {}),
      ...(startOpts.injectPlaceholderOpenAiKey !== undefined
        ? { placeholderOpenAiKey: startOpts.injectPlaceholderOpenAiKey }
        : {}),
      ...(startOpts.proxy !== undefined ? { proxy: startOpts.proxy } : {}),
      ...(startOpts.extraEnv !== undefined ? { extra: startOpts.extraEnv } : {}),
    });
    const child = spawnImpl(opts.nodeBin, [opts.launcherScript], {
      cwd: opts.checkoutDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const run: Run = {
      child,
      pid: child.pid ?? -1,
      requestedPort: startOpts.port,
      phase: 'starting',
      wasReady: false,
      expected: false,
      stopRequested: false,
      finalized: false,
      exitCode: null,
      exitSignal: null,
      sawAddrInUse: false,
      readyInfo: null,
      onReadyLine: null,
      done,
      resolveDone,
      stopPromise: null,
      splitters: [],
      closeTimer: null,
      handle: null,
    };
    current = run;

    // The launcher's watchdog exits when this pipe closes, so it stays open until stop().
    child.stdin?.on('error', () => undefined);
    for (const stream of ['stdout', 'stderr'] as const) {
      const splitter = createLineSplitter((line) => handleLine(run, stream, line));
      run.splitters.push(splitter);
      child[stream]?.on('data', (chunk: Buffer | string) => splitter.write(chunk));
      child[stream]?.on('error', () => undefined);
    }
    child.on('exit', (code, signal) => {
      run.exitCode = code;
      run.exitSignal = signal;
      // Output can still be in flight; 'close' finalises sooner, this timer is the backstop.
      run.closeTimer ??= setTimeout(() => finalize(run), CLOSE_GRACE_MS);
    });
    child.on('close', () => finalize(run));
    child.on('error', (err) => {
      log.error(`launcher process error: ${errorText(err)}`);
      if (child.pid === undefined) {
        opts.ring.push(`[stderr] ${redact(errorText(err))}`);
        run.exitCode = null;
        finalize(run);
      }
    });
    log.info(`spawned launcher pid ${run.pid} on port ${startOpts.port}`);
    return run;
  }

  async function awaitReady(run: Run, startOpts: ServerStartOptions): Promise<ServerHandle> {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const timeoutMs =
      startOpts.readinessTimeoutMs ??
      (startOpts.firstRun ? READINESS_TIMEOUT_FIRST_RUN_MS : READINESS_TIMEOUT_MS);
    const ac = new AbortController();
    let timer: NodeJS.Timeout | null = null;
    let onAbort: (() => void) | null = null;

    const readyLine = new Promise<{ url: string; port: number }>((resolve) => {
      run.onReadyLine = resolve;
    });
    const failures: Promise<never>[] = [
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new ServerError(
              'START_TIMEOUT',
              `The server did not become ready within ${Math.round(timeoutMs / 1000)} seconds.`,
              { detail: opts.ring.tail(FAILURE_DETAIL_LINES).join('\n') },
            ),
          );
        }, timeoutMs);
      }),
      run.done.then(() => {
        throw classifyExit(run, startOpts.port);
      }),
      new Promise<never>((_, reject) => {
        const signal = startOpts.signal;
        if (signal === undefined) return;
        onAbort = () => reject(new ServerError('ABORTED', 'The server start was cancelled.'));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ];
    const ready = (async () => {
      const info = await readyLine;
      log.info(`ready line seen: ${info.url}`);
      const httpDone = log.time(`server readiness GET ${info.url}`);
      try {
        await pollHttp(info.url, ac.signal, fetchImpl);
      } finally {
        httpDone();
      }
      return info;
    })();
    for (const p of [ready, ...failures]) p.catch(() => undefined);

    try {
      const info = await Promise.race([ready, ...failures]);
      if (run.finalized) throw classifyExit(run, startOpts.port);
      if (info.port !== startOpts.port) {
        log.warn(`launcher reported port ${info.port}, expected ${startOpts.port}`);
      }
      run.phase = 'running';
      run.wasReady = true;
      run.handle = { port: info.port, url: info.url, pid: run.pid };
      return run.handle;
    } finally {
      if (timer !== null) clearTimeout(timer);
      if (onAbort !== null) startOpts.signal?.removeEventListener('abort', onAbort);
      ac.abort();
      run.onReadyLine = null;
    }
  }

  return {
    async start(startOpts) {
      if (current !== null) {
        throw new ServerError('ALREADY_RUNNING', 'The server is already running or starting.');
      }
      if (startOpts.signal?.aborted === true) {
        throw new ServerError('ABORTED', 'The server start was cancelled.');
      }
      const elapsed = log.time(`server start (port ${startOpts.port})`);
      let run: Run;
      try {
        run = launch(startOpts);
      } catch (err) {
        current = null;
        elapsed();
        throw new ServerError('START_FAILED', 'The server process could not be launched.', {
          detail: errorText(err),
        });
      }
      try {
        const handle = await awaitReady(run, startOpts);
        emit({ type: 'ready', url: handle.url, port: handle.port, pid: handle.pid });
        return handle;
      } catch (err) {
        log.warn(`server start failed: ${errorText(err)}`);
        await stopRun(run, DEFAULT_STOP_TIMEOUT_MS);
        throw err;
      } finally {
        elapsed();
      }
    },

    async stop(stopOpts) {
      const run = current;
      if (run === null) return;
      await stopRun(run, stopOpts?.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
    },

    isRunning: () => current !== null && current.phase === 'running',

    handle: () => (current !== null && current.phase === 'running' ? current.handle : null),

    onEvent(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    logTail: (n = DEFAULT_LOG_TAIL) => opts.ring.tail(n),
  };
}
