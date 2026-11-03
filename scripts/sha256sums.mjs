#!/usr/bin/env node
/**
 * Print `<sha256>  <basename>` (sha256sum / `shasum -a 256 -c` compatible) for each file argument.
 *   node scripts/sha256sums.mjs *.dmg *.zip > SHA256SUMS.txt
 * Exits 1 if no files are given or any file cannot be read (an unexpanded glob is therefore an error).
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('error', reject).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex')));
  });
}

export async function sha256Lines(files) {
  const lines = [];
  for (const f of files) lines.push(`${await sha256File(f)}  ${path.basename(f)}`);
  return lines;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('usage: sha256sums.mjs <file>... > SHA256SUMS.txt');
    process.exit(64);
  }
  try {
    for (const l of await sha256Lines(files)) console.log(l);
  } catch (e) {
    console.error(`[sha256sums] ${e.message}`);
    process.exit(1);
  }
}
