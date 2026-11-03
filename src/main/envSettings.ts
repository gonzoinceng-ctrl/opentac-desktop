/**
 * Engine settings written by the shell into the engine's `.env` (docs/SHELL-DESIGN.md section 14).
 *
 * This deliberately mirrors upstream's own writer (`upsertDotenvValues` in src/keySetupCore.mjs):
 * the LAST active assignment of a key is replaced in place, else the last commented-out one is
 * uncommented in place, else the line is appended under one header; clearing comments every
 * active assignment out as `# KEY=`. Every other line, comment and blank survives byte for byte.
 * The file is replaced atomically (temp file 0600 in the same directory, fsync, rename).
 *
 * The shell never writes the 11 API-key registry variables (the engine's own endpoint owns them),
 * HOST, PORT or VITE_*, and it never logs a value. Secret-typed settings are read back as ''.
 */
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import {
  catalogKeys,
  findSetting,
  isForbiddenSettingKey,
  validateSetting,
} from '../shared/engineSettingsCatalog.js';
import type { SettingCheckResult } from '../shared/engineSettingsCatalog.js';
import type { EngineSettingsPublic } from '../shared/ipc.js';

export * from '../shared/engineSettingsCatalog.js';

/** Header written above settings the shell appends to a `.env` file. */
export const SETTINGS_APPEND_HEADER = '# Settings added by OpenTac Preferences';

/** Thrown by {@link writeEngineSettings} when nothing was written. `message` is a plain sentence. */
export class EnvSettingsError extends Error {
  /** Variable name to reason, for each refused entry. */
  readonly invalid: Record<string, string>;
  constructor(message: string, invalid: Record<string, string> = {}) {
    super(message);
    this.name = 'EnvSettingsError';
    this.invalid = invalid;
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

/** Reads the file; ENOENT is an empty file, any other failure aborts so nothing is overwritten. */
async function readText(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if (isNotFound(err)) return '';
    throw new EnvSettingsError('OpenTac could not read the engine .env file, so nothing was changed.');
  }
}

/** Value of an active assignment's right-hand side, with quotes and an inline comment removed. */
function parseRhs(rhs: string): string {
  const text = rhs.trim();
  const q = text[0];
  if (q === '"' || q === "'" || q === '`') {
    const end = text.indexOf(q, 1);
    if (end !== -1) return text.slice(1, end);
  }
  const hash = text.search(/(^|\s)#/);
  return (hash === -1 ? text : text.slice(0, hash)).trim();
}

function activeRegex(key: string): RegExp {
  return new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=(.*)$`);
}

/** Pure: catalogue values found in dotenv text. The last active assignment of a key wins. */
export function parseEngineSettings(text: string): { values: Record<string, string>; set: Record<string, boolean> } {
  const values: Record<string, string> = {};
  const set: Record<string, boolean> = {};
  const lines = text.split(/\r?\n/);
  for (const key of catalogKeys()) {
    const re = activeRegex(key);
    let found: string | null = null;
    for (const line of lines) {
      const m = re.exec(line);
      if (m !== null) found = parseRhs(m[1] ?? '');
    }
    if (found === null) continue;
    const def = findSetting(key);
    if (def?.type === 'secret') {
      if (found !== '') set[key] = true;
      continue;
    }
    values[key] = found;
    set[key] = found !== '' || def?.emptyDisables === true;
  }
  return { values, set };
}

/**
 * Reads the catalogue's settings from the `.env` file: only catalogue keys, and secret-typed
 * values are never returned (use {@link readEngineSettingsPublic} for their `set` flag).
 */
export async function readEngineSettings(envFile: string): Promise<Record<string, string>> {
  return parseEngineSettings(await readText(envFile)).values;
}

/** Values plus per-key `set` flags, in the shape the setup window receives. */
export async function readEngineSettingsPublic(envFile: string): Promise<EngineSettingsPublic> {
  return parseEngineSettings(await readText(envFile));
}

function quoteIfNeeded(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

/**
 * Pure: upserts `KEY=value` lines (and `# KEY=` for null) into dotenv text, disturbing nothing
 * else. `updates` must already be validated.
 */
export function upsertSettingLines(text: string, updates: Record<string, string | null>): string {
  const lines = text.length > 0 ? text.split(/\r?\n/) : [];
  const additions: string[] = [];
  for (const [name, value] of Object.entries(updates)) {
    const active = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
    const commented = new RegExp(`^\\s*#\\s*(?:export\\s+)?${name}\\s*=`);
    if (value === null) {
      lines.forEach((line, index) => {
        if (active.test(line)) lines[index] = `# ${name}=`;
      });
      continue;
    }
    const assignment = `${name}=${quoteIfNeeded(value)}`;
    let lastActive = -1;
    let lastCommented = -1;
    lines.forEach((line, index) => {
      if (active.test(line)) lastActive = index;
      else if (commented.test(line)) lastCommented = index;
    });
    if (lastActive >= 0) lines[lastActive] = assignment;
    else if (lastCommented >= 0) lines[lastCommented] = assignment;
    else additions.push(assignment);
  }
  if (additions.length > 0) {
    while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') lines.pop();
    if (!lines.some((line) => line.trim() === SETTINGS_APPEND_HEADER)) {
      if (lines.length > 0) lines.push('');
      lines.push(SETTINGS_APPEND_HEADER);
    }
    lines.push(...additions);
  }
  const joined = lines.join('\n');
  if (joined === '') return '';
  return joined.endsWith('\n') ? joined : `${joined}\n`;
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true });
  try {
    if ((await lstat(file)).isSymbolicLink()) {
      throw new EnvSettingsError('The engine .env file is a symbolic link, so OpenTac will not write through it.');
    }
  } catch (err) {
    if (err instanceof EnvSettingsError) throw err;
    if (!isNotFound(err)) throw new EnvSettingsError('OpenTac could not check the engine .env file, so nothing was changed.');
  }
  const tmp = join(dir, `.${basename(file)}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    if (err instanceof EnvSettingsError) throw err;
    throw new EnvSettingsError('OpenTac could not write the engine .env file, so nothing was changed.');
  }
}

let writeChain: Promise<unknown> = Promise.resolve();

/**
 * Validates a patch and applies it to the `.env` file. A string sets (the value is validated and
 * normalised per type), null removes by commenting the line out. All entries are checked first:
 * if any is refused nothing is written and an {@link EnvSettingsError} lists them. Writes are
 * serialised so two saves cannot interleave.
 */
export function writeEngineSettings(envFile: string, patch: Record<string, string | null>): Promise<void> {
  const run = writeChain.then(async () => {
    const invalid: Record<string, string> = {};
    const clean: Record<string, string | null> = {};
    for (const [key, raw] of Object.entries(patch)) {
      if (isForbiddenSettingKey(key)) {
        invalid[key] = 'OpenTac does not change this setting.';
        continue;
      }
      if (findSetting(key) === undefined) {
        invalid[key] = 'OpenTac does not manage that setting.';
        continue;
      }
      if (raw === null) {
        clean[key] = null;
        continue;
      }
      const checked: SettingCheckResult = validateSetting(key, raw);
      if (checked.ok) clean[key] = checked.value;
      else invalid[key] = checked.reason;
    }
    if (Object.keys(invalid).length > 0) {
      const first = Object.values(invalid)[0] ?? 'A value is not valid.';
      throw new EnvSettingsError(`Nothing was saved. ${first}`, invalid);
    }
    if (Object.keys(clean).length === 0) return;
    const text = await readText(envFile);
    await writeAtomic(envFile, upsertSettingLines(text, clean));
  });
  writeChain = run.catch(() => undefined);
  return run;
}
