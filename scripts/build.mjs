#!/usr/bin/env node
/**
 * Build the shell:
 *   1. main process  — tsc (ESM, NodeNext) → dist/main, dist/shared
 *   2. preloads      — esbuild → dist/preload/*.cjs  (sandboxed preloads must be CommonJS, single file)
 *   3. setup renderer — esbuild → dist/renderer/setup/setup.js (+ copied index.html / styles.css)
 *   4. usb picker     — esbuild → dist/renderer/setup/usb-picker.js (+ copied usb-picker.html)
 * Fails loudly on the first error (esbuild throws, tsc exits non-zero, a missing input aborts). No watch mode; `npm run dev` rebuilds each time.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
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
    'preload/usb': 'src/preload/usb.ts',
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

console.log('[build] renderers (esbuild → esm)');
await build({
  entryPoints: {
    'renderer/setup/setup': 'src/renderer/setup/setup.ts',
    'renderer/setup/usb-picker': 'src/renderer/setup/usb-picker.ts',
  },
  outdir: dist,
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'chrome156',
  sourcemap: true,
  logLevel: 'error',
});
for (const f of ['index.html', 'styles.css', 'usb-picker.html']) {
  const from = path.join(root, 'src/renderer/setup', f);
  if (!existsSync(from)) {
    console.error(`[build] missing renderer asset: ${path.relative(root, from)}`);
    process.exit(1);
  }
  cpSync(from, path.join(dist, 'renderer/setup', f));
}

// Sanity checks: sandboxed preloads must be self-contained CommonJS.
for (const name of ['main', 'setup', 'usb']) {
  const file = path.join(dist, 'preload', `${name}.cjs`);
  if (!existsSync(file)) {
    console.error(`[build] expected preload was not produced: ${path.relative(root, file)}`);
    process.exit(1);
  }
  const code = readFileSync(file, 'utf8');
  if (/^\s*import\s/m.test(code) || /require\(["']node:/.test(code)) {
    console.error(`[build] preload ${name}.cjs contains an ESM import or a node: builtin`);
    process.exit(1);
  }
}
console.log('[build] done');
