import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  satisfies,
  parseVersion,
  viteLoadsAfterEnv,
  extractFunctionSource,
  gitignoreCovers,
  stripComments,
  runContracts,
} from '../contracts.mjs';

const UPSTREAM_RANGE = '>=24.14.0 <25 || >=26 <27';

test('semver: the upstream engines range', () => {
  assert.equal(satisfies('24.22.2', UPSTREAM_RANGE), true);
  assert.equal(satisfies('24.14.0', UPSTREAM_RANGE), true);
  assert.equal(satisfies('24.13.9', UPSTREAM_RANGE), false);
  assert.equal(satisfies('25.0.0', UPSTREAM_RANGE), false);
  assert.equal(satisfies('25.9.9', UPSTREAM_RANGE), false);
  assert.equal(satisfies('26.0.0', UPSTREAM_RANGE), true);
  assert.equal(satisfies('26.3.1', UPSTREAM_RANGE), true);
  assert.equal(satisfies('27.0.0', UPSTREAM_RANGE), false);
  assert.equal(satisfies('v24.22.2', UPSTREAM_RANGE), true);
});

test('semver: other forms', () => {
  assert.equal(satisfies('24.1.0', '24'), true);
  assert.equal(satisfies('25.0.0', '24'), false);
  assert.equal(satisfies('24.2.0', '^24.1.0'), true);
  assert.equal(satisfies('25.0.0', '^24.1.0'), false);
  assert.equal(satisfies('24.1.5', '~24.1.0'), true);
  assert.equal(satisfies('24.2.0', '~24.1.0'), false);
  assert.equal(satisfies('24.9.0', '<=24'), true);
  assert.equal(satisfies('25.0.0', '<=24'), false);
  assert.equal(satisfies('24.0.1', '>24.0.0'), true);
  assert.equal(satisfies('24.0.0', '>24.0.0'), false);
  assert.equal(satisfies('30.0.0', '>= 24'), true);
  assert.equal(satisfies('1.2.3', '*'), true);
  assert.throws(() => satisfies('24.0.0', '>=lol'));
  assert.deepEqual(parseVersion('24.14'), { v: [24, 14, 0], given: 2 });
  assert.equal(parseVersion('nope'), null);
});

const GOOD_LAUNCHER = `
import { applyPinokioEnvironment } from './pinokio-environment.mjs';
export async function loadViteFromCanonicalRoot(root, loadVite = () => import('vite')) {
  return loadVite();
}
async function start() {
  applyPinokioEnvironment();
  const { createServer } = await loadViteFromCanonicalRoot();
}
`;

test('launcher order: upstream shape passes', () => {
  assert.equal(viteLoadsAfterEnv(GOOD_LAUNCHER).ok, true);
});

test('launcher order: static vite import fails', () => {
  const src = `import { createServer } from 'vite';\n${GOOD_LAUNCHER}`;
  const r = viteLoadsAfterEnv(src);
  assert.equal(r.ok, false);
  assert.match(r.why, /statically/);
});

test('launcher order: vite loaded before env is applied fails', () => {
  const src = `
import { applyPinokioEnvironment } from './env.mjs';
async function start() {
  const vite = await import('vite');
  applyPinokioEnvironment();
}`;
  const r = viteLoadsAfterEnv(src);
  assert.equal(r.ok, false);
  assert.match(r.why, /before the environment/);
});

test('launcher order: helper called before env fails, missing apply fails', () => {
  const early = GOOD_LAUNCHER.replace(
    'applyPinokioEnvironment();\n  const { createServer } = await loadViteFromCanonicalRoot();',
    'const { createServer } = await loadViteFromCanonicalRoot();\n  applyPinokioEnvironment();',
  );
  assert.equal(viteLoadsAfterEnv(early).ok, false);
  const noApply = GOOD_LAUNCHER.replace('applyPinokioEnvironment();', '');
  const r = viteLoadsAfterEnv(noApply);
  assert.equal(r.ok, false);
});

test('helpers: extractFunctionSource, gitignoreCovers, stripComments', () => {
  const src = 'x;\nfunction f(a) { if (a) { return 1; } return 2; }\nfunction g() {}';
  assert.equal(extractFunctionSource(src, 'f'), 'function f(a) { if (a) { return 1; } return 2; }');
  assert.equal(extractFunctionSource(src, 'zzz'), null);

  const lines = ['# comment', 'node_modules', '/dist/', '.env', '.env.*', '!.env.example', '.gev-cache/'];
  assert.equal(gitignoreCovers(lines, '.env'), true);
  assert.equal(gitignoreCovers(lines, 'dist'), true);
  assert.equal(gitignoreCovers(lines, '.gev-cache'), true);
  assert.equal(gitignoreCovers(lines, '.gev-logs'), false);
  assert.equal(gitignoreCovers(['.env.*'], '.env'), false);
  assert.equal(gitignoreCovers(['.env*'], '.env'), true);

  assert.equal(stripComments('a // x\nb /* y */ c').replace(/\s+/g, ' ').trim(), 'a b c');
});

function fixtureEngine(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contracts-'));
  const files = {
    'package.json': JSON.stringify({ engines: { node: UPSTREAM_RANGE }, devDependencies: { vite: '^6.4.4' } }),
    'scripts/pinokio-start.mjs': `${GOOD_LAUNCHER}\nconst o = { strictPort: true };\nconsole.log('[Pinokio] Ready at http://127.0.0.1:1/');`,
    'server/standalone/key-setup.js': `const L = process.env.GEV_LAUNCHER; const p = (sourceRoot) => path.join(sourceRoot, '.env');\n const plugin = { apply: (_c, { command, isPreview }) => command === 'serve' && !isPreview };`,
    '.gitignore': '.env\n.gev-cache\n.gev-logs\nnode_modules\ndist\n',
    'build/allowedHosts.js': "export const D = ['localhost', '127.0.0.1'];",
    'server/providers/openai/hud-summary.js': `function extractOpenAiResponseText(data) {\n  if (typeof data?.output_text === 'string') return data.output_text.trim();\n  return (data.output || []).flatMap((i) => i.content || []).map((p) => p.text || p.output_text || '').join(' ').trim();\n}\nawait fetch('https://api.openai.com/v1/responses', {});`,
    'server/providers/space/celestrak.js': "server.middlewares.use('/api/celestrak', () => {});",
    'src/voice/a.js': 'new RTCPeerConnection(); navigator.mediaDevices.getUserMedia({});',
    'src/sdr/a.js': 'navigator.usb.getDevices();',
    ...overrides,
  };
  for (const [rel, text] of Object.entries(files)) {
    if (text === null) continue;
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return dir;
}

const failures = (results) => results.filter((r) => r.status === 'fail').map((r) => r.name);

test('contracts: fixture engine passes', async () => {
  const results = await runContracts(fixtureEngine(), { nodeVersion: '24.22.2' });
  assert.deepEqual(failures(results), []);
});

test('contracts: each regression is named and fails', async () => {
  const cases = [
    ['engines-node', { 'package.json': JSON.stringify({ engines: { node: '>=26 <27' } }) }],
    ['launcher-exists', { 'scripts/pinokio-start.mjs': null }],
    ['launcher-strict-port', { 'scripts/pinokio-start.mjs': `${GOOD_LAUNCHER}\nconsole.log('Ready at http://127.0.0.1:1/')` }],
    ['launcher-ready-line', { 'scripts/pinokio-start.mjs': `${GOOD_LAUNCHER}\nconst o = {strictPort: true}; console.log('listening')` }],
    ['key-setup-dev-only', { 'server/standalone/key-setup.js': "const L = process.env.GEV_LAUNCHER; const p = (sourceRoot) => '.env'; const plugin = { apply: 'build' };" }],
    ['key-setup-writes-root-env', { 'server/standalone/key-setup.js': "const plugin = { apply: (_c, {isPreview}) => !isPreview };" }],
    ['gitignore-entries', { '.gitignore': 'node_modules\ndist\n' }],
    ['allowed-hosts', { 'build/allowedHosts.js': "export const D = ['localhost'];" }],
    ['hud-summary-url', { 'server/providers/openai/hud-summary.js': "function extractOpenAiResponseText(d){return d.output_text}\nawait fetch('https://api.openai.com/v1/chat/completions', {});" }],
    ['hud-summary-extract', { 'server/providers/openai/hud-summary.js': "function extractOpenAiResponseText(d){return ''}\nawait fetch('https://api.openai.com/v1/responses', {});" }],
    ['celestrak-route', { 'server/providers/space/celestrak.js': '// gone' }],
    // Comment-only / parameter-only matches must not satisfy a contract.
    ['key-setup-writes-root-env', { 'server/standalone/key-setup.js': "/** writes `.env` */\nconst L = process.env.GEV_LAUNCHER; const p = (sourceRoot) => path.join(sourceRoot, 'secrets.txt');\nconst plugin = { apply: (_c, { command, isPreview }) => command === 'serve' && !isPreview };" }],
    ['key-setup-writes-root-env', { 'server/standalone/key-setup.js': "/** writes `.env` */\nconst L = process.env.GEV_LAUNCHER; const sourceRoot = 1; const p = pinokioManaged() ? ['pinokio', 'ENVIRONMENT'] : ['.env.local'];\nconst plugin = { apply: (_c, { command, isPreview }) => command === 'serve' && !isPreview };" }],
    ['key-setup-dev-only', { 'server/standalone/key-setup.js': "const L = process.env.GEV_LAUNCHER; const p = (sourceRoot) => path.join(sourceRoot, '.env');\nconst plugin = { apply: (_c, { command, isPreview }) => true };" }],
    ['launcher-strict-port', { 'scripts/pinokio-start.mjs': `${GOOD_LAUNCHER}\n// strictPort: true,\nconsole.log('Ready at http://127.0.0.1:1/')` }],
    ['launcher-ready-line', { 'scripts/pinokio-start.mjs': `${GOOD_LAUNCHER}\nconst o = {strictPort: true};\n// console.log(\`[Pinokio] Ready at http://127.0.0.1:\${port}/\`)` }],
    ['hud-summary-url', { 'server/providers/openai/hud-summary.js': "function extractOpenAiResponseText(d){return d.output_text}\n// await fetch('https://api.openai.com/v1/responses', {});\nawait fetch('https://example.com/x', {});" }],
  ];
  for (const [name, override] of cases) {
    const results = await runContracts(fixtureEngine(override), { nodeVersion: '24.22.2' });
    assert.ok(failures(results).includes(name), `${name} should fail, got ${JSON.stringify(failures(results))}`);
  }
});

test('contracts: informational checks warn but never fail', async () => {
  const dir = fixtureEngine({ 'src/voice/a.js': '// nothing', 'src/sdr/a.js': '// nothing' });
  const results = await runContracts(dir, { nodeVersion: '24.22.2' });
  assert.deepEqual(failures(results), []);
  assert.equal(results.find((r) => r.name === 'client-voice-apis').status, 'warn');
  assert.equal(results.find((r) => r.name === 'client-usb-api').status, 'warn');
});

// The live upstream clone. Set UPSTREAM_DIR, or the scratch clone path below is tried.
const UPSTREAM_DIR =
  process.env.UPSTREAM_DIR ||
  '/private/tmp/claude-501/-Users-simontucker-Projects--DEVELOPMENT-ASSISTANT/daeb13cb-8722-47bf-95c8-c357ce2aa7d2/scratchpad/upstream/gods-eye-view';

test('contracts: upstream HEAD passes every contract', { skip: !fs.existsSync(path.join(UPSTREAM_DIR, 'package.json')) && 'no upstream clone (set UPSTREAM_DIR)' }, async () => {
  const results = await runContracts(UPSTREAM_DIR, { nodeVersion: '24.22.2' });
  assert.deepEqual(
    results.filter((r) => r.status === 'fail'),
    [],
  );
  assert.ok(results.filter((r) => r.status === 'pass').length >= 12);
});
