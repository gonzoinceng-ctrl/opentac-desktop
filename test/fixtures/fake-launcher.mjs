#!/usr/bin/env node
// Fake OpenTac launcher for server.ts tests. Plain Node ESM, no dependencies.
// Also answers a minimal slice of the engine's key setup endpoints (GET /api/setup/status,
// POST /api/setup/keys) with two registry keys held in memory, so the Preferences screen can be
// driven end to end without the real engine.
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

// In-memory stand-in for the engine's key registry (two rows, like upstream's payload shape).
const fakeKeys = [
  {
    id: 'google-maps',
    title: 'GOOGLE MAPS',
    unlocks: 'The photorealistic 3D planet, place search + Street View',
    getUrl: 'https://developers.google.com/maps/documentation/tile/get-api-key',
    envVars: ['GOOGLE_MAPS_API_KEY'],
    tier: 'metered',
    clientExposed: true,
    set: false,
  },
  {
    id: 'aisstream',
    title: 'AISSTREAM',
    unlocks: 'Live ships, worldwide',
    getUrl: 'https://aisstream.io',
    envVars: ['AISSTREAM_API_KEY'],
    tier: 'free',
    clientExposed: false,
    set: false,
  },
];
const fakeValues = new Map();

function keyStatus() {
  const keys = fakeKeys.map((k) => {
    const set = k.envVars.every((v) => (fakeValues.get(v) ?? '') !== '');
    return { ...k, set, managed: set ? 'file' : null };
  });
  return { keys, setCount: keys.filter((k) => k.set).length, total: keys.length, store: 'env-file' };
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function handleSetup(req, res) {
  const origin = `http://${host}:${port}`;
  if (req.url === '/api/setup/status' && req.method === 'GET') return sendJson(res, 200, keyStatus());
  if (req.url === '/api/setup/keys' && req.method === 'POST') {
    // Same gate shape as upstream: exact local Origin and a JSON content type.
    if (req.headers.origin !== origin) return sendJson(res, 403, { error: 'origin', code: 'origin-required' });
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
      return sendJson(res, 415, { error: 'content-type', code: 'content-type' });
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let updates;
      try {
        updates = JSON.parse(body || '{}');
      } catch {
        return sendJson(res, 400, { error: 'json', code: 'invalid-json' });
      }
      const known = new Set(fakeKeys.flatMap((k) => k.envVars));
      for (const name of Object.keys(updates)) {
        if (!known.has(name)) return sendJson(res, 400, { error: `Unknown key: ${name}`, code: 'unknown-key' });
      }
      for (const [name, value] of Object.entries(updates)) fakeValues.set(name, value === null ? '' : value);
      // The real engine restarts itself ~250 ms later without the process exiting; nothing to do here.
      sendJson(res, 200, { ok: true, saved: Object.keys(updates), status: keyStatus(), restarting: true });
    });
    return undefined;
  }
  return false;
}

if (mode === 'slow') {
  setInterval(() => {}, 1000);
} else {
  server = createServer((req, res) => {
    if (typeof req.url === 'string' && req.url.startsWith('/api/setup/')) {
      if (handleSetup(req, res) !== false) return;
    }
    res.writeHead(req.url === '/' ? 200 : 404, { 'content-type': 'text/html' });
    res.end('<html><canvas></canvas>');
  });
  server.listen(port, host, () => {
    console.log(`\n  VITE v0 ready\n\n  ➜  Local:   http://${host}:${port}/`);
    console.log(`[OpenTac] Ready at http://${host}:${port}/`);
    if (mode === 'crash-after-ready') setTimeout(() => process.exit(3), 300);
  });
}
