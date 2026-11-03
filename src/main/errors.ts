/**
 * Maps module errors (GitError, InstallError, ServerError, AiGatewayError, plain errors) to
 * plain-sentence {@link UserError}s with the right action list (docs/SHELL-DESIGN.md section 2).
 * Pure: no electron, no I/O. Stacks never reach the UI; they go to the log.
 */
import type { ActionName, UserError } from '../shared/ipc.js';
import { AiGatewayError } from './aiGateway.js';
import { GitError, redactGitText } from './git.js';
import { InstallError } from './install.js';
import { ServerError } from './server.js';

/** Where in the lifecycle the error happened; it picks the wording and the buttons. */
export type ErrorContext =
  | 'clone'
  | 'install'
  | 'start'
  | 'update'
  | 'rollback'
  | 'fetch'
  | 'disk'
  | 'port';

/** Stable machine codes of every {@link UserError} this module can produce. */
export type UserErrorCode =
  | 'DISK_SPACE'
  | 'PORT_IN_USE'
  | 'NETWORK'
  | 'TAG_DRIFT'
  | 'NPM_FAILED'
  | 'DISK_FULL'
  | 'START_FAILED'
  | 'START_TIMEOUT'
  | 'VITE_MISSING'
  | 'EADDRINUSE'
  | 'CLONE_FAILED'
  | 'GIT_FAILED'
  | 'UNKNOWN';

/** Free space below which the first run refuses to start (docs/SHELL-DESIGN.md section 2, step 1). */
export const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;

/** Longest `detail` string handed to the UI. */
export const MAX_DETAIL_CHARS = 400;

/** Errors the controller raises itself (pre-flight checks), as opposed to module errors. */
export class ShellError extends Error {
  readonly code: 'DISK_SPACE' | 'PORT_IN_USE';
  readonly detail?: string;
  readonly freeBytes?: number;

  constructor(
    code: 'DISK_SPACE' | 'PORT_IN_USE',
    message: string,
    extra: { detail?: string; freeBytes?: number } = {},
  ) {
    super(message);
    this.name = 'ShellError';
    this.code = code;
    if (extra.detail !== undefined) this.detail = extra.detail;
    if (extra.freeBytes !== undefined) this.freeBytes = extra.freeBytes;
  }
}

/** Optional hints from the caller that change which buttons are offered. */
export interface ToUserErrorOptions {
  /** A rollback marker exists, so a "Go back to the previous version" button makes sense. */
  canRollback?: boolean;
}

function lastLines(text: string, n: number): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  return lines.slice(-n).join(' | ');
}

/** Redacted, single-line, length-capped version of the underlying error text (or null). */
export function errorDetail(err: unknown): string | null {
  let raw: string;
  if (
    err instanceof GitError ||
    err instanceof InstallError ||
    err instanceof ServerError ||
    err instanceof AiGatewayError ||
    err instanceof ShellError
  ) {
    raw = err.detail !== undefined && err.detail !== '' ? err.detail : err.message;
  } else if (err instanceof Error) {
    raw = err.message;
  } else if (err === undefined || err === null) {
    raw = '';
  } else {
    raw = String(err);
  }
  const clean = redactGitText(lastLines(raw, 3));
  if (clean === '') return null;
  return clean.length > MAX_DETAIL_CHARS ? `${clean.slice(0, MAX_DETAIL_CHARS - 1)}…` : clean;
}

function make(
  code: UserErrorCode,
  title: string,
  message: string,
  err: unknown,
  actions: ActionName[],
): UserError {
  return { code, title, message, detail: errorDetail(err), actions };
}

function gigabytes(bytes: number): string {
  return (bytes / (1024 * 1024 * 1024)).toFixed(1);
}

function fromShellError(err: ShellError): UserError {
  if (err.code === 'DISK_SPACE') return diskSpace(err, err.freeBytes);
  return portInUse(err);
}

function diskSpace(err: unknown, freeBytes?: number): UserError {
  const have =
    freeBytes !== undefined ? ` and this Mac has only ${gigabytes(freeBytes)} GB free` : '';
  return make(
    'DISK_SPACE',
    'Not enough free disk space',
    `OpenTac needs about 2 GB free to download and install God's Eye View${have}. Free up some space, then try again.`,
    err,
    ['retry', 'showLogs', 'quit'],
  );
}

function portInUse(err: unknown): UserError {
  return make(
    'PORT_IN_USE',
    'The usual port is already in use',
    "Another program is using the port God's Eye View was started on before. Close that program and try again, or use a different port. Saved layers, favourites and permissions are tied to the port, so they will appear reset on a new one.",
    err,
    ['retry', 'changePort', 'showLogs'],
  );
}

function fromGitError(err: GitError, context: ErrorContext): UserError {
  switch (err.code) {
    case 'NETWORK':
      if (context === 'clone') {
        return make(
          'NETWORK',
          "Couldn't download God's Eye View",
          "OpenTac couldn't reach GitHub to download the God's Eye View source. Check your internet connection and try again.",
          err,
          ['retry', 'showLogs', 'quit'],
        );
      }
      return make(
        'NETWORK',
        "Couldn't reach GitHub",
        "OpenTac couldn't reach GitHub. Check your internet connection and try again. The version already installed still works.",
        err,
        ['retry', 'showLogs'],
      );
    case 'TAG_DRIFT':
      return make(
        'TAG_DRIFT',
        'The update source changed unexpectedly',
        'A released version on GitHub now points to different code than the copy on this Mac. OpenTac stopped so that nothing changes without your say-so. The version already installed still works, and this is worth reporting to the OpenTac project.',
        err,
        ['restartServer', 'showLogs', 'quit'],
      );
    case 'CLONE_FAILED':
      return make(
        'CLONE_FAILED',
        "Couldn't download God's Eye View",
        "Downloading the God's Eye View source failed, so nothing was installed. You can try again.",
        err,
        ['retry', 'showLogs', 'quit'],
      );
    case 'NOT_A_REPO':
      return make(
        'GIT_FAILED',
        'The downloaded engine folder is damaged',
        "The God's Eye View folder is missing or isn't a valid git checkout. Downloading it again fixes this, and your saved API keys are kept.",
        err,
        ['resetCheckout', 'showLogs', 'quit'],
      );
    case 'BAD_REF':
      return make(
        'GIT_FAILED',
        'The expected version was not found',
        "OpenTac couldn't find the expected God's Eye View version in the downloaded copy. Trying again, or downloading it afresh, usually fixes this.",
        err,
        ['retry', 'resetCheckout', 'showLogs'],
      );
    case 'GIT_TIMEOUT':
      return make(
        'GIT_FAILED',
        'GitHub took too long to answer',
        'A download from GitHub took too long and was stopped. Check your internet connection and try again.',
        err,
        ['retry', 'showLogs'],
      );
    case 'GIT_FAILED':
    default:
      return make(
        'GIT_FAILED',
        context === 'update' ? "The update couldn't be applied" : 'A download step failed',
        "A git step failed while OpenTac was working on the God's Eye View files. The log has the details. Trying again, or downloading the files afresh, usually fixes this.",
        err,
        ['retry', 'resetCheckout', 'showLogs'],
      );
  }
}

function fromInstallError(err: InstallError): UserError {
  switch (err.code) {
    case 'DISK_FULL':
      return make(
        'DISK_FULL',
        'Your disk is full',
        "There isn't enough free space to install God's Eye View's dependencies. Free up about 1 GB, then try again.",
        err,
        ['retry', 'showLogs', 'quit'],
      );
    case 'NETWORK':
      return make(
        'NETWORK',
        "Couldn't download the dependencies",
        "OpenTac couldn't reach the npm registry to download God's Eye View's dependencies. Check your internet connection and try again.",
        err,
        ['retry', 'showLogs', 'quit'],
      );
    case 'TIMEOUT':
      return make(
        'NPM_FAILED',
        'Installing dependencies took too long',
        "Installing God's Eye View's dependencies took too long and was stopped. Try again; a second attempt is usually faster.",
        err,
        ['retry', 'showLogs', 'quit'],
      );
    case 'ABORTED':
      return make(
        'NPM_FAILED',
        'Installing dependencies was cancelled',
        'The install was stopped before it finished. Try again when you are ready.',
        err,
        ['retry', 'showLogs'],
      );
    case 'NO_LOCKFILE':
      return make(
        'NPM_FAILED',
        'The downloaded engine is incomplete',
        "The God's Eye View download has no dependency list, so its dependencies can't be installed. Downloading it again fixes this.",
        err,
        ['resetCheckout', 'showLogs', 'quit'],
      );
    case 'NPM_FAILED':
    default:
      return make(
        'NPM_FAILED',
        'Installing dependencies failed',
        "npm couldn't install God's Eye View's dependencies. The log has the details. Trying again often helps.",
        err,
        ['retry', 'showLogs', 'quit'],
      );
  }
}

function fromServerError(err: ServerError, context: ErrorContext): UserError {
  switch (err.code) {
    case 'EADDRINUSE':
      if (context === 'port') return portInUse(err);
      return make(
        'EADDRINUSE',
        'The port is already in use',
        "Another program is using the port God's Eye View needs. Close it and try again, or use a different port. Saved layers, favourites and permissions are tied to the port, so they will appear reset on a new one.",
        err,
        ['retry', 'changePort', 'showLogs'],
      );
    case 'START_TIMEOUT':
      return make(
        'START_TIMEOUT',
        "God's Eye View took too long to start",
        "The God's Eye View server didn't become ready in time. The first start after an install can be slow; trying again often works. The log has the details.",
        err,
        ['retry', 'reinstall', 'showLogs'],
      );
    case 'VITE_MISSING':
      return make(
        'VITE_MISSING',
        'A required piece is missing',
        "God's Eye View's dependencies are incomplete (its Vite dev server is missing). Reinstalling the dependencies fixes this.",
        err,
        ['reinstall', 'showLogs', 'quit'],
      );
    case 'ABORTED':
      return make(
        'START_FAILED',
        'Starting was cancelled',
        "The God's Eye View server was stopped before it finished starting.",
        err,
        ['retry', 'showLogs'],
      );
    case 'ALREADY_RUNNING':
      return make(
        'START_FAILED',
        'The server is already running',
        "A God's Eye View server is already running. Restart it to start again.",
        err,
        ['restartServer', 'showLogs'],
      );
    case 'START_FAILED':
    default:
      return make(
        'START_FAILED',
        "God's Eye View didn't start",
        "The God's Eye View server stopped before it was ready. The log has the details.",
        err,
        ['retry', 'reinstall', 'showLogs'],
      );
  }
}

function fromGatewayError(err: AiGatewayError): UserError {
  return make(
    'START_FAILED',
    "The summary provider isn't working",
    `The local AI summary gateway reported a problem: ${err.message}. Check the provider settings or switch back to OpenAI.`,
    err,
    ['openPreferences', 'retry', 'showLogs'],
  );
}

function fromPlainError(err: unknown, context: ErrorContext): UserError {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'ENOSPC') {
    return make(
      'DISK_FULL',
      'Your disk is full',
      'There is no free space left on this Mac for OpenTac to write to. Free up some space, then try again.',
      err,
      ['retry', 'showLogs', 'quit'],
    );
  }
  if (context === 'disk') return diskSpace(err);
  if (context === 'port') return portInUse(err);
  return make(
    'UNKNOWN',
    'Something went wrong',
    'OpenTac hit an unexpected problem. The log has the details, and trying again often helps.',
    err,
    ['retry', 'showLogs', 'quit'],
  );
}

function classify(err: unknown, context: ErrorContext): UserError {
  if (err instanceof ShellError) return fromShellError(err);
  if (err instanceof GitError) return fromGitError(err, context);
  if (err instanceof InstallError) return fromInstallError(err);
  if (err instanceof ServerError) return fromServerError(err, context);
  if (err instanceof AiGatewayError) return fromGatewayError(err);
  return fromPlainError(err, context);
}

/**
 * Converts any thrown value into a {@link UserError}. `context` picks the wording and the buttons.
 * In the `rollback` context the failure is reported as "could not go back" with the fixed action
 * set Retry, Reinstall, Show Logs, keeping the underlying code. `detail` is the redacted
 * underlying message (at most 400 characters).
 */
export function toUserError(
  err: unknown,
  context: ErrorContext,
  opts: ToUserErrorOptions = {},
): UserError {
  const base = classify(err, context);
  if (context === 'rollback') {
    return {
      ...base,
      title: "Couldn't go back to the previous version",
      message: `The update didn't work, and OpenTac could not restore the previous version either. ${base.message}`,
      actions: ['retry', 'reinstall', 'showLogs'],
    };
  }
  if (opts.canRollback === true && !base.actions.includes('rollback')) {
    const [first, ...rest] = base.actions;
    return { ...base, actions: first === undefined ? ['rollback'] : [first, 'rollback', ...rest] };
  }
  return base;
}

/** The setup-window error for a server that exited without being asked to. */
export function crashUserError(
  exit: { code: number | null; signal: string | null },
  lastLine: string | null,
): UserError {
  const how =
    exit.signal !== null
      ? `was stopped by signal ${exit.signal}`
      : `exited with code ${exit.code === null ? 'unknown' : String(exit.code)}`;
  return {
    code: 'START_FAILED',
    title: "God's Eye View stopped unexpectedly",
    message: `The God's Eye View server ${how}. You can restart it, look at the log, or reinstall its dependencies.`,
    detail: lastLine === null ? null : errorDetail(lastLine),
    actions: ['restartServer', 'showLogs', 'reinstall'],
  };
}
