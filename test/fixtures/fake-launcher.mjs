#!/usr/bin/env node
// Fake OpenTac launcher for server.ts tests. Plain Node ESM, no dependencies.
// FAKE_MODE: ok | eaddrinuse | eaddrinuse-exit1 | fail | crash-after-ready | slow |
//            vite-missing | no-stdin-exit | stubborn
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fstatSync } from 'node:fs';

const mode = process.env.FAKE_MODE || 'ok';
const port = Number.parseInt(process.env.PORT ?? '', 10);
const host = '127.0.0.1';

function stdinIsPipe() {
  try {
    const st = fstatSync(0);
    return st.isFIFO() || st.isSocket();
  } catch {
    return false;
  }
}

if (mode === 'eaddrinuse') {
  console.error(`[OpenTac] EADDRINUSE: port ${port} is in use.`);
  process.exit(99);
}
if (mode === 'eaddrinuse-exit1') {
  console.error(`Error: listen EADDRINUSE: address already in use ${host}:${port}`);
  process.exit(1);
}
if (mode === 'fail') {
  console.log('some stdout before failing');
  console.error('[OpenTac] Start failed: boom');
  process.exit(1);
}
if (mode === 'vite-missing') {
  console.error('[OpenTac] vite is not installed in the checkout (run dependency install).');
  process.exit(98);
}
if (mode === 'no-stdin-exit' && !stdinIsPipe()) process.exit(0);

let server = null;
function shutdown() {
  if (server) server.close();
  process.exit(0);
}

if (mode === 'stubborn') {
  // Ignores SIGTERM and has a worker in the same process group; only SIGKILL to the group ends it.
  process.on('SIGTERM', () => console.log('[fake] ignoring SIGTERM'));
  const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  console.log(`[fake] worker pid ${worker.pid}`);
  setInterval(() => {}, 1000);
} else {
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  // Mirror the real launcher's watchdog: exit when the stdin pipe closes.
  if (stdinIsPipe()) {
    process.stdin.on('end', shutdown);
    process.stdin.on('error', shutdown);
    process.stdin.resume();
  }
}

console.log(`[fake] cwd ${process.cwd()}`);
console.log(`[fake] env-keys ${Object.keys(process.env).sort().join(',')}`);

if (mode === 'slow') {
  setInterval(() => {}, 1000);
} else {
  server = createServer((req, res) => {
    res.writeHead(req.url === '/' ? 200 : 404, { 'content-type': 'text/html' });
    res.end('<html><canvas></canvas>');
  });
  server.listen(port, host, () => {
    console.log(`\n  VITE v0 ready\n\n  ➜  Local:   http://${host}:${port}/`);
    console.log(`[OpenTac] Ready at http://${host}:${port}/`);
    if (mode === 'crash-after-ready') setTimeout(() => process.exit(3), 300);
  });
}
