#!/usr/bin/env node
/**
 * Download, verify and unpack the bundled Node runtime for both macOS arches.
 * Idempotent. Version and SHA-256 values come from scripts/node-version.json
 * (update that file from https://nodejs.org/dist/v<ver>/SHASUMS256.txt). The build MUST fail on mismatch.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Single source of truth shared with the engine mirror's gate (08-STAGED-UPDATES).
const spec = JSON.parse(readFileSync(new URL('./node-version.json', import.meta.url), 'utf8'));
const NODE_VERSION = spec.version;
const SHA256 = spec.sha256;

const vendor = path.resolve('vendor/node');
mkdirSync(vendor, { recursive: true });

for (const [target, expected] of Object.entries(SHA256)) {
  const dest = path.join(vendor, target);
  const marker = path.join(dest, '.version');
  if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === NODE_VERSION) {
    console.log(`[fetch-node] ${target} already at ${NODE_VERSION}`);
    continue;
  }
  const file = `node-v${NODE_VERSION}-${target}.tar.gz`;
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${file}`;
  console.log(`[fetch-node] downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const actual = createHash('sha256').update(buf).digest('hex');
  if (expected === 'FILL_ME_IN' || actual !== expected) {
    throw new Error(`[fetch-node] SHA-256 mismatch for ${file}: expected ${expected}, got ${actual}`);
  }
  const tgz = path.join(vendor, file);
  writeFileSync(tgz, buf);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const prefix = `node-v${NODE_VERSION}-${target}`;
  const tar = spawnSync('tar', ['-xzf', tgz, '-C', dest, '--strip-components=1',
    `${prefix}/bin/node`, `${prefix}/lib/node_modules/npm`, `${prefix}/LICENSE`], { stdio: 'inherit' });
  if (tar.status !== 0) throw new Error('[fetch-node] tar failed');
  rmSync(tgz);
  writeFileSync(marker, `${NODE_VERSION}\n`);
  console.log(`[fetch-node] ${target} ready`);
}
