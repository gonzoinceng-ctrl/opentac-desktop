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

/**
 * Lazily loads electron-log (main process only) and adapts it to a {@link LogSink}:
 * file level info, console level debug, 10 MB file rotation.
 */
export async function createElectronLogSink(): Promise<LogSink> {
  const mod = await import('electron-log/main.js');
  const log = mod.default;
  log.initialize?.();
  log.transports.file.level = 'info';
  log.transports.console.level = 'debug';
  log.transports.file.maxSize = LOG_FILE_MAX_BYTES;
  return {
    info: (msg) => log.info(msg),
    warn: (msg) => log.warn(msg),
    error: (msg) => log.error(msg),
    debug: (msg) => log.debug(msg),
  };
}
