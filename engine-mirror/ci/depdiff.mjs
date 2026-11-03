#!/usr/bin/env node
// Lockfile diff summary for the gate report.
// Usage: node ci/depdiff.mjs <oldPackageLock.json|-> <newPackageLock.json> [--json]
// "-" (or a missing file) means "no previous lockfile". Plain Node ESM, no dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function load(file) {
  if (!file || file === '-' || !fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** { name: version } for every node_modules/<name> entry (last path segment wins for nested copies). */
function flatten(lock) {
  const out = new Map();
  for (const [key, v] of Object.entries(lock?.packages ?? {})) {
    if (!key) continue;
    const name = key.replace(/^.*node_modules\//, '');
    const entry = out.get(name) ?? { versions: new Set(), install: false };
    entry.versions.add(v.version ?? '?');
    entry.install ||= Boolean(v.hasInstallScript);
    out.set(name, entry);
  }
  return out;
}

function topLevel(lock) {
  const root = lock?.packages?.[''] ?? {};
  return { ...(root.dependencies ?? {}), ...(root.devDependencies ?? {}), ...(root.optionalDependencies ?? {}) };
}

export function diffLocks(oldLock, newLock) {
  const a = flatten(oldLock);
  const b = flatten(newLock);
  const added = [];
  const removed = [];
  const changed = [];
  for (const [name, e] of b) {
    if (!a.has(name)) added.push({ name, version: [...e.versions].join(', '), install: e.install });
    else {
      const was = [...a.get(name).versions].sort().join(', ');
      const now = [...e.versions].sort().join(', ');
      if (was !== now) changed.push({ name, was, now });
    }
  }
  for (const name of a.keys()) if (!b.has(name)) removed.push(name);
  const ta = topLevel(oldLock);
  const tb = topLevel(newLock);
  const topAdded = Object.keys(tb).filter((n) => !(n in ta));
  const topRemoved = Object.keys(ta).filter((n) => !(n in tb));
  const topChanged = Object.keys(tb).filter((n) => n in ta && ta[n] !== tb[n]).map((n) => ({ name: n, was: ta[n], now: tb[n] }));
  return {
    before: a.size,
    after: b.size,
    added: added.sort((x, y) => x.name.localeCompare(y.name)),
    removed: removed.sort(),
    changed: changed.sort((x, y) => x.name.localeCompare(y.name)),
    topAdded: topAdded.sort(),
    topRemoved: topRemoved.sort(),
    topChanged,
    newInstallScripts: added.filter((p) => p.install).map((p) => p.name).sort(),
    changedAtAll: Boolean(added.length || removed.length || changed.length),
  };
}

export function toMarkdown(d, hadOld = true) {
  if (!hadOld) return `- No previous lockfile to compare against; ${d.after} packages in the candidate.`;
  const cap = (list, f, n = 15) => (list.length > n ? `${list.slice(0, n).map(f).join(', ')}, and ${list.length - n} more` : list.map(f).join(', '));
  const lines = [`- Packages: ${d.before} -> ${d.after} (${d.added.length} added, ${d.removed.length} removed, ${d.changed.length} version changes)`];
  lines.push(`- Dependencies changed: ${d.changedAtAll ? 'yes' : 'no'}`);
  if (d.topAdded.length) lines.push(`- New top-level dependencies: ${d.topAdded.join(', ')}`);
  if (d.topRemoved.length) lines.push(`- Removed top-level dependencies: ${d.topRemoved.join(', ')}`);
  if (d.topChanged.length) lines.push(`- Top-level range changes: ${cap(d.topChanged, (c) => `${c.name} ${c.was} -> ${c.now}`)}`);
  if (d.newInstallScripts.length) lines.push(`- New packages with install scripts (possible native code): ${d.newInstallScripts.join(', ')}`);
  if (d.added.length) lines.push(`- Added: ${cap(d.added, (p) => `${p.name}@${p.version}`)}`);
  if (d.changed.length) lines.push(`- Changed: ${cap(d.changed, (c) => `${c.name} ${c.was} -> ${c.now}`)}`);
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2).filter((a) => a !== '--json');
  const json = process.argv.includes('--json');
  if (args.length !== 2) {
    console.error('usage: node ci/depdiff.mjs <oldPackageLock.json|-> <newPackageLock.json> [--json]');
    process.exitCode = 64;
  } else {
    const oldLock = load(args[0]);
    const newLock = load(args[1]);
    if (!newLock) {
      console.error('depdiff: new lockfile not found');
      process.exitCode = 1;
    } else {
      const d = diffLocks(oldLock, newLock);
      console.log(json ? JSON.stringify(d) : toMarkdown(d, Boolean(oldLock)));
    }
  }
}
