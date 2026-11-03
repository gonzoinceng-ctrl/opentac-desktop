#!/usr/bin/env node
// Upstream tag manifest (DECISIONS correction 7).
//
// manifest/tags.json records, for every mirrored upstream `v*` tag, the tag
// object SHA and (for annotated tags) the peeled commit SHA. The watcher
// compares `git ls-remote --tags` of upstream against it BEFORE fetching and
// fails loudly if any recorded tag was deleted, moved, or re-annotated.
//
// Usage:
//   node ci/manifest.mjs check  <upstreamUrl> [--manifest <file>] [--json] [--ls-remote-file <file>]
//   node ci/manifest.mjs update <upstreamUrl> [--manifest <file>] [--json] [--ls-remote-file <file>] [--init]
//
// check:  exit 0 = no drift (new tags may exist, they are reported),
//         exit 2 = drift (deleted or changed tags), exit 1 = other error.
// update: appends NEW tags only; refuses (exit 2) when there is drift, so a
//         rewritten tag can never be silently re-recorded. --init allows
//         creating the manifest when the file does not exist yet.
//
// Plain Node ESM, no dependencies.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MANIFEST = path.join(HERE, '..', 'manifest', 'tags.json');
export const TAG_FILTER = /^v\d/; // only v<digit>... tags are mirrored

/**
 * Parse `git ls-remote --tags` output into { tag: { object, peeled } }.
 * Lines look like "<sha>\trefs/tags/v1.0.0" and, for annotated tags, an extra
 * "<sha>\trefs/tags/v1.0.0^{}" line carrying the peeled commit.
 */
export function parseLsRemote(text, filter = TAG_FILTER) {
  const tags = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([0-9a-f]{40,64})\s+refs\/tags\/(.+)$/.exec(line.trim());
    if (!m) continue;
    const [, sha, rawName] = m;
    const peeled = rawName.endsWith('^{}');
    const name = peeled ? rawName.slice(0, -3) : rawName;
    if (filter && !filter.test(name)) continue;
    tags[name] ??= { object: null, peeled: null };
    if (peeled) tags[name].peeled = sha;
    else tags[name].object = sha;
  }
  return tags;
}

/** Compare recorded tags to remote tags. Both are { tag: {object, peeled} }. */
export function diffManifest(recorded, remote) {
  const added = [];
  const deleted = [];
  const changed = [];
  for (const [tag, rec] of Object.entries(recorded)) {
    const now = remote[tag];
    if (!now) {
      deleted.push(tag);
      continue;
    }
    if (now.object !== rec.object) {
      changed.push({ tag, field: 'object', was: rec.object, now: now.object });
    }
    if ((now.peeled ?? null) !== (rec.peeled ?? null)) {
      changed.push({ tag, field: 'peeled', was: rec.peeled ?? null, now: now.peeled ?? null });
    }
  }
  for (const tag of Object.keys(remote)) {
    if (!(tag in recorded)) added.push(tag);
  }
  added.sort();
  deleted.sort();
  return { added, deleted, changed, drift: deleted.length > 0 || changed.length > 0 };
}

export function readManifest(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (data.schema !== 1 || typeof data.tags !== 'object' || data.tags === null) {
    throw new Error(`${file}: not a schema 1 tag manifest`);
  }
  return data;
}

export function writeManifest(file, data) {
  const sorted = Object.fromEntries(
    Object.entries(data.tags).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })),
  );
  const out = { schema: 1, upstream: data.upstream, tags: sorted };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
}

function lsRemoteTags(url, file) {
  if (file) return fs.readFileSync(file, 'utf8');
  // Without --refs, ls-remote also prints the peeled "^{}" line of annotated tags.
  return execFileSync('git', ['ls-remote', '--tags', '--quiet', url], {
    encoding: 'utf8',
    timeout: 60_000,
  });
}

function report(diff) {
  const lines = [];
  for (const t of diff.deleted) lines.push(`DELETED  ${t}: recorded tag no longer exists upstream`);
  for (const c of diff.changed) {
    lines.push(`CHANGED  ${c.tag}: ${c.field} ${c.was ?? 'none'} -> ${c.now ?? 'none'}`);
  }
  for (const t of diff.added) lines.push(`NEW      ${t}`);
  if (lines.length === 0) lines.push('no drift, no new tags');
  return lines;
}

function parseArgs(argv) {
  const out = { _: [], flags: {}, opts: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json' || a === '--init') out.flags[a.slice(2)] = true;
    else if (a === '--manifest' || a === '--ls-remote-file') out.opts[a.slice(2)] = argv[(i += 1)];
    else out._.push(a);
  }
  return out;
}

export function main(argv) {
  const { _, flags, opts } = parseArgs(argv);
  const [cmd, url] = _;
  if (!['check', 'update'].includes(cmd) || !url) {
    console.error('usage: node ci/manifest.mjs check|update <upstreamUrl> [--manifest f] [--json] [--ls-remote-file f] [--init]');
    return 64;
  }
  const file = opts.manifest || DEFAULT_MANIFEST;
  let manifest;
  if (fs.existsSync(file)) manifest = readManifest(file);
  else if (cmd === 'update' && flags.init) manifest = { schema: 1, upstream: url, tags: {} };
  else {
    console.error(`manifest not found: ${file}`);
    return 1;
  }
  const remote = parseLsRemote(lsRemoteTags(url, opts['ls-remote-file']));
  const diff = diffManifest(manifest.tags, remote);
  const emit = (extra = {}) => {
    if (flags.json) console.log(JSON.stringify({ ...diff, ...extra }));
    else for (const l of report(diff)) console.log(l);
  };
  if (cmd === 'check') {
    emit();
    return diff.drift ? 2 : 0;
  }
  // update
  if (diff.drift) {
    emit({ updated: [] });
    console.error('refusing to update the manifest while recorded tags have drifted');
    return 2;
  }
  for (const tag of diff.added) {
    if (!remote[tag].object) throw new Error(`tag ${tag} has no object SHA in ls-remote output`);
    manifest.tags[tag] = { object: remote[tag].object, peeled: remote[tag].peeled };
  }
  if (diff.added.length > 0 || !fs.existsSync(file)) writeManifest(file, manifest);
  if (flags.json) console.log(JSON.stringify({ ...diff, updated: diff.added }));
  else for (const t of diff.added) console.log(`recorded ${t}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`manifest.mjs: ${e.message}`);
    process.exitCode = 1;
  }
}
