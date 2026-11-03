#!/usr/bin/env node
/**
 * Build the shell:
 *   1. main process  — tsc (ESM, NodeNext) → dist/main, dist/shared
 *   2. preloads      — esbuild → dist/preload/*.cjs  (sandboxed preloads must be CommonJS, single file)
 *   3. setup renderer — esbuild → dist/renderer/setup/setup.js (+ copied index.html / styles.css)
 * Fails on the first error. No watch mode; `npm run dev` rebuilds each time.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dist = path.join(root, 'dist');

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

console.log('[build] main (tsc)');
run(path.join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.main.json']);

console.log('[build] preloads (esbuild → cjs)');
await build({
  entryPoints: {
    'preload/main': 'src/preload/main.ts',
    'preload/setup': 'src/preload/setup.ts',
  },
  outdir: dist,
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'error',
});

console.log('[build] setup renderer (esbuild → esm)');
await build({
  entryPoints: { 'renderer/setup/setup': 'src/renderer/setup/setup.ts' },
  outdir: dist,
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'chrome156',
  sourcemap: true,
  logLevel: 'error',
});
for (const f of ['index.html', 'styles.css']) {
  const from = path.join(root, 'src/renderer/setup', f);
  if (existsSync(from)) cpSync(from, path.join(dist, 'renderer/setup', f));
}
console.log('[build] done');
