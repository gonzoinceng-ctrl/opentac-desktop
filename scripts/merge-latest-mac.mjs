#!/usr/bin/env node
/**
 * Merge the per-arch `latest-mac.yml` files electron-builder writes (one per native build job)
 * into the single `latest-mac.yml` electron-updater expects on the GitHub release.
 *
 *   node scripts/merge-latest-mac.mjs latest-mac-arm64.yml latest-mac-x64.yml > latest-mac.yml
 *
 * Why: both jobs publish a file with the same name; whichever uploads last would silently drop the
 * other architecture. electron-updater (MacUpdater) picks the zip whose url contains "arm64" on
 * Apple Silicon and the other zip on Intel, so the merged `files` list must carry both.
 *
 * No YAML dependency: this is a minimal parser for exactly the shape app-builder-lib's
 * serializeToYaml() produces for update info (see docs/RELEASE.md):
 *
 *   version: 0.1.0
 *   files:
 *     - url: OpenTac-0.1.0-arm64-mac.zip
 *       sha512: <base64>
 *       size: 123
 *       blockMapSize: 456
 *   path: OpenTac-0.1.0-arm64-mac.zip
 *   sha512: <base64>
 *   releaseDate: '2026-11-03T12:00:00.000Z'
 *
 * Anything outside that shape (nested maps, block scalars such as multi-line releaseNotes) is a hard error
 * rather than a silent mis-merge.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** @typedef {{ raw: string, value: string }} Scalar */

/** Decode a YAML scalar's textual form (plain, 'single' or "double" quoted). */
function decodeScalar(text) {
  const t = text.trim();
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\(["\\/nrt])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t' })[c] ?? c);
  }
  return t;
}

/** @returns {Scalar} */
function scalar(text) {
  const raw = text.trim();
  if (raw === '' || raw === '|' || raw === '>' || /^[|>][-+0-9]*$/.test(raw) || raw.startsWith('{') || raw.startsWith('[')) {
    throw new Error(`unsupported YAML value: "${raw}"`);
  }
  return { raw, value: decodeScalar(raw) };
}

/**
 * Parse update-info YAML.
 * @param {string} text
 * @returns {{ top: Map<string, Scalar>, files: Map<string, Scalar>[] }}
 */
export function parseLatestMac(text) {
  const top = new Map();
  const files = [];
  let inFiles = false;
  let current = null;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(#.*)?$/.test(line) || line === '---') continue;
    const where = `line ${i + 1}`;
    if (/^\S/.test(line)) {
      const m = /^([A-Za-z0-9_]+):(?:\s+(.*))?$/.exec(line);
      if (!m) throw new Error(`${where}: cannot parse "${line}"`);
      const [, key, rest] = m;
      if (key === 'files') {
        if (rest != null && rest.trim() !== '') throw new Error(`${where}: "files" must be a block list`);
        inFiles = true;
        current = null;
        continue;
      }
      inFiles = false;
      current = null;
      if (top.has(key)) throw new Error(`${where}: duplicate key "${key}"`);
      try {
        top.set(key, scalar(rest ?? ''));
      } catch (e) {
        throw new Error(`${where}: key "${key}": ${e.message}`);
      }
      continue;
    }
    if (!inFiles) throw new Error(`${where}: unexpected indented line "${line}"`);
    let m = /^\s*-\s+([A-Za-z0-9_]+):\s+(.*)$/.exec(line);
    if (m) {
      current = new Map();
      files.push(current);
    } else {
      m = /^\s+([A-Za-z0-9_]+):\s+(.*)$/.exec(line);
      if (!m || !current) throw new Error(`${where}: cannot parse file entry "${line}"`);
    }
    try {
      current.set(m[1], scalar(m[2]));
    } catch (e) {
      throw new Error(`${where}: key "${m[1]}": ${e.message}`);
    }
  }
  return { top, files };
}

function emitScalar(s) {
  return s.raw;
}

/** Zip entry that electron-updater's legacy `path`/`sha512` should point at: the x64 (non-arm64) zip. */
function isX64Zip(file) {
  const url = file.get('url')?.value ?? '';
  return url.endsWith('.zip') && !/arm64/i.test(url);
}

/**
 * Merge parsed update-info documents. Version and releaseDate come from the first; `files` are concatenated
 * and de-duplicated by url (first occurrence wins); path/sha512 are re-pointed at the x64 zip.
 * @param {ReturnType<typeof parseLatestMac>[]} docs
 */
export function mergeLatestMac(docs) {
  if (docs.length < 1) throw new Error('nothing to merge');
  const first = docs[0];
  const version = first.top.get('version');
  if (!version) throw new Error('first input has no "version"');
  for (const [i, d] of docs.entries()) {
    const v = d.top.get('version');
    if (!v || v.value !== version.value) throw new Error(`input ${i + 1} version "${v?.value}" differs from "${version.value}"`);
    if (d.files.length === 0) throw new Error(`input ${i + 1} has no files`);
  }
  const seen = new Set();
  const files = [];
  for (const d of docs) {
    for (const f of d.files) {
      const url = f.get('url')?.value;
      if (!url) throw new Error('file entry without "url"');
      if (!f.get('sha512')) throw new Error(`file entry "${url}" without "sha512"`);
      if (seen.has(url)) continue;
      seen.add(url);
      files.push(f);
    }
  }
  const x64Zip = files.find(isX64Zip);
  if (!x64Zip) throw new Error('no x64 zip (a .zip url without "arm64") among the merged files');
  const top = new Map();
  top.set('version', version);
  // Remaining top-level keys of the first document (e.g. releaseName), minus the ones we recompute.
  const skip = new Set(['version', 'path', 'sha512', 'releaseDate']);
  const extras = [...first.top].filter(([k]) => !skip.has(k));
  return { version, files, path: x64Zip.get('url'), sha512: x64Zip.get('sha512'), extras, releaseDate: first.top.get('releaseDate') ?? null };
}

/** Serialize a merge result in the same layout electron-builder writes. */
export function serializeLatestMac(m) {
  const out = [`version: ${emitScalar(m.version)}`, 'files:'];
  for (const f of m.files) {
    let first = true;
    for (const [k, v] of f) {
      out.push(`${first ? '  - ' : '    '}${k}: ${emitScalar(v)}`);
      first = false;
    }
  }
  out.push(`path: ${emitScalar(m.path)}`);
  out.push(`sha512: ${emitScalar(m.sha512)}`);
  for (const [k, v] of m.extras) out.push(`${k}: ${emitScalar(v)}`);
  if (m.releaseDate) out.push(`releaseDate: ${emitScalar(m.releaseDate)}`);
  return `${out.join('\n')}\n`;
}

export function mergeFiles(paths) {
  const docs = paths.map((p) => {
    try {
      return parseLatestMac(readFileSync(p, 'utf8'));
    } catch (e) {
      throw new Error(`${p}: ${e.message}`);
    }
  });
  return serializeLatestMac(mergeLatestMac(docs));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('usage: merge-latest-mac.mjs <latest-mac-arm64.yml> <latest-mac-x64.yml> [...] > latest-mac.yml');
    process.exit(64);
  }
  try {
    process.stdout.write(mergeFiles(args));
  } catch (e) {
    console.error(`[merge-latest-mac] ${e.message}`);
    process.exit(1);
  }
}
