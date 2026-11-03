import { existsSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, createWriteStream } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { dirname } from 'node:path';

import { redact } from '../shared/redact.js';

/** Minimal destination for log lines (electron-log adapter, array fake in tests, ...). */
export interface LogSink {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

/** Message accepted by logger methods; Errors are rendered with their stack. */
export type LogMessage = string | Error;

/** Redacting, scope-aware logger built on a {@link LogSink}. */
export interface Logger {
  info(msg: LogMessage): void;
  warn(msg: LogMessage): void;
  error(msg: LogMessage): void;
  debug(msg: LogMessage): void;
  /** Returns a child logger whose lines are prefixed `[parent:name] `. */
  scope(name: string): Logger;
  /** Starts a timer; the returned stop function logs `label took Nms` at info. */
  time(label: string): () => void;
}

/** Options for {@link createLogger}. */
export interface LoggerOptions {
  /** Run every message through redact(); default true. */
  redact?: boolean;
  /** Initial scope; lines are prefixed `[scope] `. */
  scope?: string;
  /** Millisecond clock, injectable for tests; default performance.now. */
  now?: () => number;
}

function render(msg: LogMessage): string {
  if (msg instanceof Error) {
    return msg.stack ? `${msg.message}\n${msg.stack}` : msg.message;
  }
  return msg;
}

/** Wraps `sink` so every message is rendered, optionally redacted, and scope-prefixed. */
export function createLogger(sink: LogSink, opts: LoggerOptions = {}): Logger {
  const shouldRedact = opts.redact ?? true;
  const scopeName = opts.scope;
  const now = opts.now ?? (() => performance.now());
  const prefix = scopeName ? `[${scopeName}] ` : '';

  function format(msg: LogMessage): string {
    const text = render(msg);
    return prefix + (shouldRedact ? redact(text) : text);
  }

  const logger: Logger = {
    info: (msg) => sink.info(format(msg)),
    warn: (msg) => sink.warn(format(msg)),
    error: (msg) => sink.error(format(msg)),
    debug: (msg) => sink.debug(format(msg)),
    scope: (name) =>
      createLogger(sink, {
        redact: shouldRedact,
        scope: scopeName ? `${scopeName}:${name}` : name,
        now,
      }),
    time(label) {
      const startedAt = now();
      return () => {
        logger.info(`${label} took ${Math.round(now() - startedAt)}ms`);
      };
    },
  };
  return logger;
}

/** Maximum size of a log file before electron-log rotates it. */
const LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** Severity names accepted by OPENTAC_LOG_LEVEL. */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug'];

/** Transport levels used by {@link createElectronLogSink}. */
export interface LogLevels {
  fileLevel: LogLevel;
  consoleLevel: LogLevel;
}

/**
 * Pure: picks the file and console log levels. OPENTAC_LOG_LEVEL (error|warn|info|debug,
 * case-insensitive; anything else is ignored) sets both. Defaults: file `info`; console `debug`
 * when unpackaged, `warn` when packaged.
 */
export function resolveLogLevels(env: NodeJS.ProcessEnv, isPackaged: boolean): LogLevels {
  const raw = env['OPENTAC_LOG_LEVEL']?.trim().toLowerCase();
  const override = LOG_LEVELS.find((l) => l === raw);
  if (override !== undefined) return { fileLevel: override, consoleLevel: override };
  return { fileLevel: 'info', consoleLevel: isPackaged ? 'warn' : 'debug' };
}

/**
 * Lazily loads electron-log (main process only) and adapts it to a {@link LogSink}:
 * 10 MB file rotation; transport levels from `opts` (default file info, console debug).
 */
export async function createElectronLogSink(opts?: { fileLevel?: LogLevel; consoleLevel?: LogLevel }): Promise<LogSink> {
  const mod = await import('electron-log/main.js');
  const log = mod.default;
  log.initialize?.();
  log.transports.file.level = opts?.fileLevel ?? 'info';
  log.transports.console.level = opts?.consoleLevel ?? 'debug';
  log.transports.file.maxSize = LOG_FILE_MAX_BYTES;
  return {
    info: (msg) => log.info(msg),
    warn: (msg) => log.warn(msg),
    error: (msg) => log.error(msg),
    debug: (msg) => log.debug(msg),
  };
}

/** Options for {@link createServerLogWriter}. */
export interface ServerLogWriterOptions {
  /** Absolute path of the live log file; archives are `file.1` ... `file.<keep>`. */
  file: string;
  /** Rotate when the live file would exceed this many bytes; default 10 MiB. */
  maxBytes?: number;
  /** Number of archives to keep; default 5. */
  keep?: number;
  /** Clock for the timestamp prefix, injectable for tests; default `new Date()`. */
  now?: () => Date;
}

/** Appending, rotating, redacting writer for server.log. */
export interface ServerLogWriter {
  /** Appends one line (callers include the stream tag, e.g. `[gev:stdout] ...`), redacted and prefixed with an ISO timestamp. Never throws. */
  write(line: string): void;
  /** Flushes pending data and closes the file; later writes are ignored. Idempotent. */
  close(): Promise<void>;
}

/**
 * Creates the server.log tee: each line is redacted, prefixed with an ISO timestamp
 * (`2026-11-03T20:00:00.000Z [gev:stdout] ...`, the tag being part of the line the caller passes) and appended; when the file would exceed `maxBytes`
 * it is renamed to `file.1` (older archives shift up, `file.<keep>` is dropped). I/O failures are
 * swallowed: logging must never take the shell down.
 */
export function createServerLogWriter(opts: ServerLogWriterOptions): ServerLogWriter {
  const { file } = opts;
  const maxBytes = opts.maxBytes ?? LOG_FILE_MAX_BYTES;
  const now = opts.now ?? (() => new Date());
  const keep = Math.max(0, Math.floor(opts.keep ?? 5));
  let stream: WriteStream | null = null;
  let size = 0;
  let closed = false;
  let closing: Promise<void> | null = null;

  function open(): void {
    try {
      mkdirSync(dirname(file), { recursive: true });
      // Open synchronously so a rotation rename can never race the stream's own open.
      const fd = openSync(file, 'a');
      size = statSync(file).size;
      const s = createWriteStream(file, { fd, flags: 'a', autoClose: true });
      s.on('error', () => undefined);
      stream = s;
    } catch {
      stream = null;
    }
  }

  /** Ends the current stream (its queued writes still land in the renamed inode). */
  function endStream(): Promise<void> {
    const s = stream;
    stream = null;
    if (s === null) return Promise.resolve();
    return new Promise<void>((resolve) => {
      s.once('close', () => resolve());
      s.once('error', () => resolve());
      s.end();
    });
  }

  function rotate(): void {
    // The old stream keeps its fd, so renaming under it is safe; it drains into file.1.
    const old = endStream();
    pendingEnds.push(old);
    try {
      if (keep === 0) {
        unlinkSync(file);
      } else {
        const last = `${file}.${keep}`;
        if (existsSync(last)) unlinkSync(last);
        for (let i = keep - 1; i >= 1; i--) {
          if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
        }
        renameSync(file, `${file}.1`);
      }
    } catch {
      // Best effort: keep appending to whatever is there.
    }
    open();
  }

  const pendingEnds: Promise<void>[] = [];
  open();

  return {
    write(line) {
      if (closed) return;
      if (stream === null) open();
      if (stream === null) return;
      const body = redact(`${now().toISOString()} ${line.replace(/\r?\n$/, '')}`);
      const text = `${body}\n`;
      const bytes = Buffer.byteLength(text);
      if (size > 0 && size + bytes > maxBytes) rotate();
      if (stream === null) return;
      size += bytes;
      stream.write(text);
    },
    close() {
      closing ??= (async () => {
        closed = true;
        await endStream();
        await Promise.all(pendingEnds);
      })();
      return closing;
    },
  };
}
