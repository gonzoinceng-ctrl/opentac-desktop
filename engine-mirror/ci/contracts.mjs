#!/usr/bin/env node
// OpenTac engine contract checks (08-STAGED-UPDATES.md section 3.3).
//
// Usage: node ci/contracts.mjs <engineDir> [--json] [--md] [--node <version>]
//
// Plain Node ESM, no dependencies. Every contract is a named check with a
// one-line failure message that says what changed upstream. Exit code 1 if any
// check fails, 0 otherwise. Checks marked "warn" and "info" never fail.
//
// The Node version used for the engines.node check comes from, in order:
// --node, env OPENTAC_NODE_VERSION, the running Node.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Tiny semver-range matcher. Supports the forms engines.node uses:
//   ">=24.14.0 <25 || >=26 <27", plus =, >, <=, <, ^, ~ and x/partial versions.
// ---------------------------------------------------------------------------

/** Parse "24", "24.14", "24.14.0", "v24.14.0-rc.1" into { v: [maj,min,pat], given }. */
export function parseVersion(text) {
  const m = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:[-+].*)?$/.exec(
    String(text).trim(),
  );
  if (!m) return null;
  const parts = [m[1], m[2], m[3]];
  const nums = [];
  let given = 0;
  for (const p of parts) {
    if (p === undefined || /^[xX*]$/.test(p)) break;
    nums.push(Number(p));
    given += 1;
  }
  while (nums.length < 3) nums.push(0);
  return { v: nums, given };
}

function cmp(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** First version strictly above every version matching a partial ("24" -> 25.0.0). */
function bump(p) {
  const v = [...p.v];
  if (p.given <= 1) return [v[0] + 1, 0, 0];
  if (p.given === 2) return [v[0], v[1] + 1, 0];
  return [v[0], v[1], v[2] + 1];
}

/** Expand one comparator into a list of [op, [maj,min,pat]] bounds that must all hold. */
function comparatorBounds(token) {
  const m = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(token);
  if (!m) throw new Error(`bad comparator: ${token}`);
  const op = m[1] || '=';
  const p = parseVersion(m[2]);
  if (!p) throw new Error(`bad version in comparator: ${token}`);
  const lo = p.v;
  switch (op) {
    case '>=':
      return [['>=', lo]];
    case '>':
      return p.given === 3 ? [['>', lo]] : [['>=', bump(p)]];
    case '<':
      return [['<', lo]];
    case '<=':
      return p.given === 3 ? [['<=', lo]] : [['<', bump(p)]];
    case '=':
      return [
        ['>=', lo],
        ['<', bump(p)],
      ];
    case '~': {
      const up = p.given <= 1 ? [lo[0] + 1, 0, 0] : [lo[0], lo[1] + 1, 0];
      return [
        ['>=', lo],
        ['<', up],
      ];
    }
    case '^': {
      let up;
      if (lo[0] > 0 || p.given <= 1) up = [lo[0] + 1, 0, 0];
      else if (lo[1] > 0 || p.given === 2) up = [0, lo[1] + 1, 0];
      else up = [0, 0, lo[2] + 1];
      return [
        ['>=', lo],
        ['<', up],
      ];
    }
    default:
      throw new Error(`bad operator: ${op}`);
  }
}

/** True if `version` satisfies `range`. Throws on syntax this matcher does not know. */
export function satisfies(version, range) {
  const pv = parseVersion(version);
  if (!pv) throw new Error(`bad version: ${version}`);
  const v = pv.v;
  const alternatives = String(range).split('||');
  return alternatives.some((alt) => {
    const text = alt.trim();
    if (text === '' || text === '*') return true;
    // Glue "op version" written with a space (">= 24") back together.
    const tokens = text
      .replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1')
      .split(/\s+/)
      .filter(Boolean);
    return tokens.every((tok) =>
      comparatorBounds(tok).every(([op, bound]) => {
        const c = cmp(v, bound);
        if (op === '>=') return c >= 0;
        if (op === '>') return c > 0;
        if (op === '<') return c < 0;
        if (op === '<=') return c <= 0;
        return false;
      }),
    );
  });
}

// ---------------------------------------------------------------------------
// Source analysis helpers (exported so tests can feed synthetic sources).
// ---------------------------------------------------------------------------

/** Index of the bracket matching the opener at `open` (same kind), or -1. */
function matchClose(src, open) {
  const o = src[open];
  const c = { '(': ')', '{': '}' }[o];
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === o) depth += 1;
    else if (src[i] === c) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Spans [start, end) of every `function NAME(params) { body }` whose text mentions import('vite'). */
function viteHelperSpans(src) {
  const spans = [];
  const re = /(?:async\s+)?function\s+(\w+)\s*\(/g;
  for (const m of src.matchAll(re)) {
    const paren = m.index + m[0].length - 1;
    const closeParen = matchClose(src, paren);
    if (closeParen < 0) continue;
    const brace = src.indexOf('{', closeParen);
    if (brace < 0) continue;
    const closeBrace = matchClose(src, brace);
    if (closeBrace < 0) continue;
    const text = src.slice(m.index, closeBrace + 1);
    // A function that also applies the environment is the caller, not a loader helper.
    if (/import\(\s*['"]vite['"]\s*\)/.test(text) && !/\bapply\w*Environment\s*\(/.test(text)) {
      spans.push({ name: m[1], start: m.index, end: closeBrace + 1 });
    }
  }
  return spans;
}

/**
 * Does the launcher load Vite only after the environment has been applied?
 * Heuristic, documented: there must be no static `import ... from 'vite'`; a
 * call to an `apply*Environment(` function must exist; every invocation that
 * loads Vite must come after it. An invocation is either a direct
 * `import('vite')` that is not a deferred `() => import('vite')`, or a call to
 * a helper function whose definition contains `import('vite')` (such as
 * `loadViteFromCanonicalRoot`). Text inside the helper's own definition is not
 * an invocation.
 */
export function viteLoadsAfterEnv(src) {
  if (/^\s*import\s[^;]*?\sfrom\s+['"]vite['"]/m.test(src)) {
    return { ok: false, why: 'imports vite statically at the top of the file' };
  }
  if (/^\s*import\s+['"]vite['"]/m.test(src)) {
    return { ok: false, why: 'side-effect imports vite at the top of the file' };
  }
  const apply = /\bapply\w*Environment\s*\(/.exec(src);
  if (!apply) {
    return { ok: false, why: 'no longer calls an apply*Environment() function' };
  }
  const helpers = viteHelperSpans(src);
  const inHelper = (i) => helpers.some((h) => i >= h.start && i < h.end);
  const invocations = [];
  for (const h of helpers) {
    const callRe = new RegExp(`\\b${h.name}\\s*\\(`, 'g');
    for (const m of src.matchAll(callRe)) {
      if (!inHelper(m.index)) invocations.push(m.index);
    }
  }
  for (const m of src.matchAll(/import\(\s*['"]vite['"]\s*\)/g)) {
    if (inHelper(m.index)) continue;
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    if (/=>\s*$/.test(src.slice(lineStart, m.index))) continue; // deferred loader
    invocations.push(m.index);
  }
  if (invocations.length === 0) {
    return { ok: false, why: "never loads vite (no import('vite') call or helper call found)" };
  }
  if (invocations.some((i) => i < apply.index)) {
    return { ok: false, why: 'loads vite before the environment is applied' };
  }
  return { ok: true };
}

/** Remove // and /* *\/ comments (naive; fine for pattern checks, not for parsing). */
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** Extract `function name(...) { ... }` source by brace matching, or null. */
export function extractFunctionSource(src, name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) return null;
  const open = src.indexOf('{', src.indexOf(')', m.index));
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(m.index, i + 1);
    }
  }
  return null;
}

/** Does a .gitignore (as lines) ignore the plain path `name`? */
export function gitignoreCovers(lines, name) {
  const active = lines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'));
  return active.some((raw) => {
    const pat = raw.replace(/^\//, '').replace(/\/$/, '').replace(/\/\*\*?$/, '');
    if (pat === name) return true;
    if (!pat.includes('*')) return false;
    const re = new RegExp(
      `^${pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`,
    );
    return re.test(name);
  });
}

// ---------------------------------------------------------------------------
// The contracts.
// ---------------------------------------------------------------------------

const read = (dir, rel) => {
  try {
    return fs.readFileSync(path.join(dir, rel), 'utf8');
  } catch {
    return null;
  }
};

const KNOWN_NATIVE = [
  'sharp',
  'canvas',
  'better-sqlite3',
  'sqlite3',
  'node-gyp',
  'node-pty',
  'puppeteer',
  'esbuild',
  'fsevents',
  'bufferutil',
  'utf-8-validate',
  'serialport',
  'usb',
];

const pass = (name, message) => ({ name, status: 'pass', message });
const fail = (name, message) => ({ name, status: 'fail', message });
const warn = (name, message) => ({ name, status: 'warn', message });
const info = (name, message) => ({ name, status: 'info', message });

/** Walk <root>/<rel> looking for a regex in source files; returns first relative path or null. */
function findInTree(root, rel, regex, limit = 4000) {
  const stack = [path.join(root, rel)];
  let seen = 0;
  while (stack.length && seen < limit) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && e.name !== 'testSupport') stack.push(full);
      } else if (/\.(m?js|ts|tsx|jsx)$/.test(e.name) && !/\.(test|spec|diag\.test)\./.test(e.name)) {
        seen += 1;
        try {
          if (regex.test(fs.readFileSync(full, 'utf8'))) {
            return path.relative(root, full);
          }
        } catch {
          /* unreadable file: skip */
        }
      }
    }
  }
  return null;
}

export async function runContracts(engineDir, { nodeVersion } = {}) {
  const dir = path.resolve(engineDir);
  const results = [];
  const node = nodeVersion || process.env.OPENTAC_NODE_VERSION || process.versions.node;

  // package.json ---------------------------------------------------------
  let pkg = null;
  const pkgText = read(dir, 'package.json');
  if (pkgText === null) {
    results.push(fail('engines-node', 'package.json is missing from the engine checkout'));
  } else {
    try {
      pkg = JSON.parse(pkgText);
    } catch {
      results.push(fail('engines-node', 'package.json is no longer valid JSON'));
    }
  }
  if (pkg) {
    const range = pkg.engines?.node;
    if (!range) {
      results.push(
        warn('engines-node', 'package.json no longer declares engines.node (any Node accepted)'),
      );
    } else {
      try {
        if (satisfies(node, range)) {
          results.push(pass('engines-node', `engines.node "${range}" accepts bundled Node ${node}`));
        } else {
          results.push(
            fail(
              'engines-node',
              `engines.node is now "${range}", which excludes bundled Node ${node}; the shell must bump its Node first`,
            ),
          );
        }
      } catch (e) {
        results.push(
          fail(
            'engines-node',
            `engines.node "${range}" uses range syntax the gate cannot evaluate (${e.message})`,
          ),
        );
      }
    }
  }

  // scripts/pinokio-start.mjs -------------------------------------------
  const launcher = read(dir, 'scripts/pinokio-start.mjs');
  if (launcher === null) {
    results.push(
      fail(
        'launcher-exists',
        'scripts/pinokio-start.mjs was removed or renamed; the shell launcher mirrors it',
      ),
    );
  } else {
    results.push(pass('launcher-exists', 'scripts/pinokio-start.mjs exists'));
    const order = viteLoadsAfterEnv(launcher);
    results.push(
      order.ok
        ? pass('launcher-vite-after-env', 'Vite is loaded after the environment is applied')
        : fail(
            'launcher-vite-after-env',
            `scripts/pinokio-start.mjs ${order.why}; Vite snapshots process.env, so the env the shell sets up would be lost`,
          ),
    );
    const launcherCode = stripComments(launcher);
    results.push(
      /strictPort\s*:\s*true/.test(launcherCode)
        ? pass('launcher-strict-port', 'launcher passes strictPort: true')
        : fail(
            'launcher-strict-port',
            'scripts/pinokio-start.mjs no longer sets strictPort: true; Vite could move off the port the shell allocated',
          ),
    );
    results.push(
      /Ready at http:\/\/127\.0\.0\.1:/.test(launcherCode)
        ? pass('launcher-ready-line', 'launcher prints a "Ready at http://127.0.0.1:" line')
        : fail(
            'launcher-ready-line',
            'scripts/pinokio-start.mjs no longer prints "Ready at http://127.0.0.1:PORT"; the shell parses that line for readiness',
          ),
    );
  }

  // server/standalone/key-setup.js --------------------------------------
  const keySetup = read(dir, 'server/standalone/key-setup.js');
  if (keySetup === null) {
    results.push(
      fail(
        'key-setup-writes-root-env',
        'server/standalone/key-setup.js was removed or renamed; in-app key entry would disappear',
      ),
    );
    results.push(
      fail('key-setup-dev-only', 'server/standalone/key-setup.js is missing, cannot verify its dev-only registration'),
    );
  } else {
    // Comment-stripped: a doc comment mentioning `.env` must not satisfy the check.
    const keySetupCode = stripComments(keySetup);
    const writesRootEnv =
      (/pinokioManaged\(\)\s*\?[^:]*:\s*\[\s*['"]\.env['"]\s*\]/.test(keySetupCode) ||
        /path\.join\([^)]*['"]\.env['"]\s*\)/.test(keySetupCode)) &&
      /GEV_LAUNCHER/.test(keySetup) &&
      /sourceRoot|defaultSourceRoot/.test(keySetup);
    results.push(
      writesRootEnv
        ? pass('key-setup-writes-root-env', 'key-setup writes <root>/.env unless GEV_LAUNCHER selects another store')
        : fail(
            'key-setup-writes-root-env',
            'server/standalone/key-setup.js no longer writes <root>/.env keyed on GEV_LAUNCHER; saved keys may land somewhere the shell does not read',
          ),
    );
    // The predicate body must test command === 'serve' (or be apply: 'serve');
    // a bare `isPreview` in the destructured parameters does not count.
    results.push(
      /\bapply\s*:\s*(?:['"]serve['"]|\([^)]*\)\s*=>\s*[^,]*command\s*===?\s*['"]serve['"])/.test(keySetupCode)
        ? pass('key-setup-dev-only', 'key-setup plugin registers only for the dev server (apply predicate)')
        : fail(
            'key-setup-dev-only',
            'key-setup plugin no longer has an apply predicate on command === "serve" / isPreview; key entry could be exposed outside dev',
          ),
    );
  }

  // .gitignore ------------------------------------------------------------
  const gi = read(dir, '.gitignore');
  if (gi === null) {
    results.push(
      fail('gitignore-entries', '.gitignore was removed; the user checkout would show secrets and caches as untracked'),
    );
  } else {
    const lines = gi.split(/\r?\n/);
    const required = ['.env', '.gev-cache', '.gev-logs', 'node_modules', 'dist'];
    const missing = required.filter((n) => !gitignoreCovers(lines, n));
    results.push(
      missing.length === 0
        ? pass('gitignore-entries', `.gitignore covers ${required.join(', ')}`)
        : fail(
            'gitignore-entries',
            `.gitignore no longer ignores ${missing.join(', ')}; the shell's dirty-checkout test would see them and block updates`,
          ),
    );
  }

  // build/allowedHosts.js -------------------------------------------------
  const hosts = read(dir, 'build/allowedHosts.js');
  if (hosts === null) {
    results.push(fail('allowed-hosts', 'build/allowedHosts.js was removed or moved; cannot verify the Host allowlist'));
  } else {
    const ok = /['"]127\.0\.0\.1['"]/.test(hosts) && /['"]localhost['"]/.test(hosts);
    results.push(
      ok
        ? pass('allowed-hosts', 'allowedHosts accepts 127.0.0.1 and localhost')
        : fail(
            'allowed-hosts',
            'build/allowedHosts.js no longer lists 127.0.0.1 and localhost; the app window (http://127.0.0.1:PORT) would get 403',
          ),
    );
  }

  // server/providers/openai/hud-summary.js -------------------------------
  const hudRel = 'server/providers/openai/hud-summary.js';
  const hud = read(dir, hudRel);
  if (hud === null) {
    results.push(fail('hud-summary-url', `${hudRel} was removed or moved; the gateway interceptor has nothing to match`));
    results.push(fail('hud-summary-extract', `${hudRel} is missing, cannot run extractOpenAiResponseText`));
  } else {
    results.push(
      /fetch\(\s*(['"`])https:\/\/api\.openai\.com\/v1\/responses\1/.test(stripComments(hud))
        ? pass('hud-summary-url', 'HUD summary posts to https://api.openai.com/v1/responses')
        : fail(
            'hud-summary-url',
            `${hudRel} no longer fetches the exact literal https://api.openai.com/v1/responses; the launcher's single-URL interceptor would miss it`,
          ),
    );
    results.push(await checkExtract(dir, hudRel, hud));
  }

  // celestrak ---------------------------------------------------------------
  const cel = read(dir, 'server/providers/space/celestrak.js');
  results.push(
    cel !== null && /middlewares\.use\(\s*['"`]\/api\/celestrak['"`]/.test(cel)
      ? pass('celestrak-route', '/api/celestrak is still registered (keyless gate smoke endpoint)')
      : fail(
          'celestrak-route',
          'server/providers/space/celestrak.js no longer registers /api/celestrak; the gate smoke needs a new keyless endpoint',
        ),
  );

  // informational: browser APIs the shell grants permission for -------------
  const rtc = findInTree(dir, 'src/voice', /RTCPeerConnection/);
  const gum = findInTree(dir, 'src/voice', /getUserMedia/);
  results.push(
    rtc && gum
      ? info('client-voice-apis', `voice client still uses RTCPeerConnection (${rtc}) and getUserMedia (${gum})`)
      : warn(
          'client-voice-apis',
          `voice client no longer references ${[!rtc && 'RTCPeerConnection', !gum && 'getUserMedia'].filter(Boolean).join(' + ')} in src/voice; permission handling in the shell may need review`,
        ),
  );
  const usb = findInTree(dir, 'src/sdr', /navigator\.usb/);
  results.push(
    usb
      ? info('client-usb-api', `SDR client still uses navigator.usb (${usb})`)
      : warn(
          'client-usb-api',
          'SDR client no longer references navigator.usb in src/sdr; WebUSB permission handling in the shell may need review',
        ),
  );

  // informational: shape of the engine ---------------------------------------
  if (pkg) {
    const vite = pkg.devDependencies?.vite ?? pkg.dependencies?.vite;
    const major = vite ? /(\d+)/.exec(vite)?.[1] : null;
    results.push(
      info('vite-major', major ? `Vite major ${major} (declared "${vite}")` : 'vite is not declared in package.json'),
    );
  }
  const lockText = read(dir, 'package-lock.json');
  if (lockText) {
    try {
      const lock = JSON.parse(lockText);
      const entries = Object.entries(lock.packages ?? {}).filter(([k]) => k !== '');
      results.push(info('package-count', `${entries.length} packages in package-lock.json`));
      const native = new Set();
      for (const [k, v] of entries) {
        const nm = k.replace(/^.*node_modules\//, '');
        if (v.hasInstallScript || KNOWN_NATIVE.includes(nm)) native.add(nm);
      }
      results.push(
        info(
          'native-deps',
          native.size
            ? `install-script or native packages: ${[...native].sort().join(', ')}`
            : 'no install-script or native packages',
        ),
      );
    } catch {
      results.push(warn('package-count', 'package-lock.json is not valid JSON'));
    }
  } else {
    results.push(warn('package-count', 'package-lock.json is missing; npm ci would fail'));
  }

  return results;
}

async function checkExtract(dir, rel, src) {
  const name = 'hud-summary-extract';
  const gateway = {
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'X' }] }],
    output_text: 'X',
  };
  const outputOnly = { output: gateway.output };
  let fn = null;
  let how = '';
  try {
    const mod = await import(pathToFileURL(path.join(dir, rel)).href);
    if (typeof mod.extractOpenAiResponseText === 'function') {
      fn = mod.extractOpenAiResponseText;
      how = 'imported export';
    }
  } catch {
    /* module needs the full engine tree or has side effects; fall back to source */
  }
  if (!fn) {
    const fnSrc = extractFunctionSource(src, 'extractOpenAiResponseText');
    if (!fnSrc) {
      return fail(
        name,
        `${rel} no longer defines extractOpenAiResponseText; the gateway response shape is unverified`,
      );
    }
    try {
      fn = new Function(`${fnSrc}\nreturn extractOpenAiResponseText;`)();
      how = 'extracted source';
    } catch (e) {
      return fail(
        name,
        `${rel} extractOpenAiResponseText could not be evaluated standalone (${e.message}); it now depends on other module state`,
      );
    }
  }
  try {
    const a = fn(gateway);
    const b = fn(outputOnly);
    if (a === 'X' && b === 'X') {
      return pass(name, `extractOpenAiResponseText accepts the gateway shape (${how})`);
    }
    return fail(
      name,
      `extractOpenAiResponseText returned ${JSON.stringify(a)} / ${JSON.stringify(b)} for the gateway shape, expected "X"; the response format the gateway emits is no longer understood`,
    );
  } catch (e) {
    return fail(name, `extractOpenAiResponseText threw on the gateway shape (${e.message})`);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function toMarkdown(results) {
  const label = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', info: 'INFO' };
  const rows = results.map(
    (r) => `| ${label[r.status]} | \`${r.name}\` | ${r.message.replace(/\|/g, '\\|')} |`,
  );
  return ['| Result | Check | Detail |', '|---|---|---|', ...rows].join('\n');
}

async function main(argv) {
  const args = argv.slice(2);
  const json = args.includes('--json');
  const md = args.includes('--md');
  const ni = args.indexOf('--node');
  const nodeVersion = ni >= 0 ? args[ni + 1] : undefined;
  const positional = args.filter((a, i) => !a.startsWith('--') && !(ni >= 0 && i === ni + 1));
  if (positional.length !== 1) {
    console.error('usage: node ci/contracts.mjs <engineDir> [--json] [--md] [--node <version>]');
    return 64;
  }
  const results = await runContracts(positional[0], { nodeVersion });
  const failed = results.filter((r) => r.status === 'fail');
  if (json) {
    console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2));
  } else if (md) {
    console.log(toMarkdown(results));
  } else {
    for (const r of results) console.log(`${r.status.toUpperCase().padEnd(4)} ${r.name} - ${r.message}`);
    console.log(
      failed.length
        ? `\n${failed.length} contract(s) FAILED`
        : `\nall ${results.filter((r) => r.status === 'pass').length} contracts passed`,
    );
  }
  return failed.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv).then(
    (code) => process.stdout.write('', () => process.exit(code)),
    (e) => {
      console.error(`contracts.mjs crashed: ${e.stack || e}`);
      process.exit(1);
    },
  );
}
