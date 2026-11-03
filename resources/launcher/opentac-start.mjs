#!/usr/bin/env node
/**
 * OpenTac engine launcher.
 *
 * Runs inside the upstream God's Eye View checkout under OpenTac's bundled
 * Node. Mirrors upstream's scripts/pinokio-start.mjs:
 *   1. environment is final BEFORE Vite is imported (Vite snapshots process.env)
 *   2. optional AI-gateway fetch interceptor is installed BEFORE Vite (see 07-AI-PROVIDERS.md)
 *   3. createServer({ root: cwd, server: { host: 127.0.0.1, port, strictPort } })
 *   4. print a ready line the shell can parse
 *   5. exit cleanly on SIGTERM/SIGINT; exit non-zero on any failure
 *
 * Dependency-free on purpose: it may only import from the checkout's own
 * node_modules (resolved via createRequire on the checkout's package.json).
 */
import { createRequire } from 'node:module';
import { fstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const READY_PREFIX = '[OpenTac] Ready at ';

function fail(message, code = 1) {
  console.error(`[OpenTac] ${message}`);
  process.exit(code);
}

const checkout = realpathSync(process.cwd());
const port = Number.parseInt(process.env.PORT ?? '', 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) fail('PORT missing or invalid.');
const host = process.env.HOST || '127.0.0.1';
if (host !== '127.0.0.1' && host !== 'localhost') fail(`Refusing to bind ${host}; OpenTac is local-only.`);

// Dev/test hook: simulate a failed start to exercise the rollback path.
if (process.env.OPENTAC_FAIL_START_ONCE === '1') fail('Simulated start failure (OPENTAC_FAIL_START_ONCE).', 97);

// Optional AI gateway: rewrite upstream's hard-coded OpenAI text endpoint to
// OpenTac's local gateway. Voice (Realtime) is deliberately NOT rewritten.
if (process.env.OPENTAC_AI_GATEWAY_URL) {
  const gateway = process.env.OPENTAC_AI_GATEWAY_URL.replace(/\/$/, '');
  const REWRITES = new Map([
    ['https://api.openai.com/v1/responses', `${gateway}/v1/responses`],
  ]);
  // Per-launch shared secret so only this engine process can spend the gateway's provider keys.
  const token = process.env.OPENTAC_AI_GATEWAY_TOKEN || '';
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    const target = url && REWRITES.get(url);
    if (!target) return realFetch(input, init);
    console.log(`[OpenTac] AI gateway: ${url} -> ${target}`);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.delete('authorization'); // the gateway holds its own backend key; never forward the engine's
    if (token) headers.set('x-opentac-gateway-token', token);
    const nextInit = { ...(init ?? {}), headers };
    return realFetch(typeof input === 'string' || input instanceof URL ? target : new Request(target, input), nextInit);
  };
}

// Watchdog: the shell spawns us with stdin as a pipe it holds open. If the shell
// is SIGKILLed we are reparented and the pipe closes → exit. Only arm this when
// stdin really is a pipe/socket; with a TTY or /dev/null (manual runs, tests)
// 'end' would fire immediately and we would exit before serving anything.
// OPENTAC_NO_STDIN_WATCHDOG=1 disables it explicitly.
function stdinIsPipe() {
  try { const st = fstatSync(0); return st.isFIFO() || st.isSocket(); } catch { return false; }
}
if (process.env.OPENTAC_NO_STDIN_WATCHDOG !== '1' && !process.stdin.isTTY && stdinIsPipe()) {
  process.stdin.on('end', () => shutdown('stdin closed'));
  process.stdin.on('error', () => shutdown('stdin error'));
  process.stdin.resume();
}

let server = null;
let shuttingDown = false;
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[OpenTac] Shutting down (${reason}).`);
  try { if (server) await server.close(); } catch {}
  process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => shutdown(signal));

async function main() {
  const require = createRequire(path.join(checkout, 'package.json'));
  let vitePath;
  try {
    vitePath = require.resolve('vite');
  } catch {
    fail('vite is not installed in the checkout (run dependency install).', 98);
  }
  const { createServer } = await import(pathToFileURL(vitePath).href);
  server = await createServer({
    root: checkout,
    server: { host, port, strictPort: true },
  });
  await server.listen();
  server.printUrls();
  console.log(`${READY_PREFIX}http://${host}:${port}/`);
}

main().catch((error) => {
  const message = error?.message || String(error);
  // Vite with strictPort rejects with 'Port N is already in use' (no EADDRINUSE in the text).
  if (/already in use|EADDRINUSE/i.test(message)) fail(`EADDRINUSE: port ${port} is in use.`, 99);
  fail(`Start failed: ${message}`);
});
