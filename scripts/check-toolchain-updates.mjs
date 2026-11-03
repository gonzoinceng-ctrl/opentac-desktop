#!/usr/bin/env node
/**
 * Weekly toolchain check (docs/DECISIONS.md, staged update pipeline item 12).
 *
 * Compares scripts/node-version.json (bundled Node, 24.x line) and package.json (Electron 45.x,
 * dugite, electron-builder, electron-updater) with nodejs.org and the npm registry, prints a Markdown
 * report on stdout, and exits:
 *   0  nothing actionable (informational notes may still be printed)
 *   2  a newer Node 24.x patch or Electron 45.x patch exists  -> the workflow opens/updates an issue
 *   1  network or parse failure
 * When a newer Node exists the report includes the SHA-256 lines for its darwin tarballs and a ready-to-paste
 * node-version.json "sha256" block (taken from the release's SHASUMS256.txt over HTTPS; still verify by hand).
 * No dependencies beyond Node builtins.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const TIMEOUT_MS = 30_000;

/** Parse "1.2.3" / "v1.2.3" -> [1,2,3]; null for prereleases or junk. */
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`cannot compare "${a}" and "${b}"`);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** Highest stable version in `versions` on the given major line (e.g. 24), or null. */
export function newestOnLine(versions, major) {
  let best = null;
  for (const v of versions) {
    const p = parseVersion(v);
    if (!p || p[0] !== major) continue;
    if (best === null || compareVersions(v, best) > 0) best = String(v).replace(/^v/, '');
  }
  return best;
}

/** Extract the darwin tarball lines from a SHASUMS256.txt body. */
export function darwinShaLines(shasums, version) {
  const wanted = [`node-v${version}-darwin-arm64.tar.gz`, `node-v${version}-darwin-x64.tar.gz`];
  const lines = shasums.split('\n').map((l) => l.trim()).filter(Boolean);
  const found = {};
  for (const w of wanted) {
    const line = lines.find((l) => l.endsWith(`  ${w}`));
    if (!line) throw new Error(`${w} missing from SHASUMS256.txt`);
    found[w] = line.split(/\s+/)[0];
  }
  return found;
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { 'user-agent': 'opentac-toolchain-check', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'opentac-toolchain-check' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

async function main() {
  const nodeSpec = JSON.parse(readFileSync(new URL('scripts/node-version.json', root), 'utf8'));
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const nodeMajor = Number(nodeSpec.line ?? String(nodeSpec.version).split('.')[0]);
  const electronCurrent = deps.electron;
  const electronMajor = parseVersion(electronCurrent)[0];

  const [nodeIndex, electronDoc, ...latest] = await Promise.all([
    getJson('https://nodejs.org/dist/index.json'),
    getJson('https://registry.npmjs.org/electron', { accept: 'application/vnd.npm.install-v1+json' }),
    ...['dugite', 'electron-builder', 'electron-updater'].map((p) => getJson(`https://registry.npmjs.org/${p}/latest`)),
  ]);

  const actionable = [];
  const info = [];
  const sections = [];

  // --- Node ---
  const nodeEntries = nodeIndex.filter((e) => parseVersion(e.version)?.[0] === nodeMajor);
  const newestNode = newestOnLine(nodeEntries.map((e) => e.version), nodeMajor);
  const nodeNewer = newestNode && compareVersions(newestNode, nodeSpec.version) > 0;
  const nodeEntry = nodeEntries.find((e) => e.version === `v${newestNode}`);
  let nodeBlock = `- Bundled Node: \`${nodeSpec.version}\` (newest ${nodeMajor}.x: \`${newestNode}\`)${nodeNewer ? ' **update available**' : ' up to date'}`;
  if (nodeNewer) {
    actionable.push(`Node ${nodeSpec.version} -> ${newestNode}`);
    if (nodeEntry?.security) nodeBlock += ' (flagged as a **security** release)';
    const sums = darwinShaLines(await getText(`https://nodejs.org/dist/v${newestNode}/SHASUMS256.txt`), newestNode);
    const arm = sums[`node-v${newestNode}-darwin-arm64.tar.gz`];
    const x64 = sums[`node-v${newestNode}-darwin-x64.tar.gz`];
    nodeBlock += [
      '',
      '',
      `  SHA-256 (from https://nodejs.org/dist/v${newestNode}/SHASUMS256.txt):`,
      '',
      '  ```',
      `  ${arm}  node-v${newestNode}-darwin-arm64.tar.gz`,
      `  ${x64}  node-v${newestNode}-darwin-x64.tar.gz`,
      '  ```',
      '',
      '  Paste into `scripts/node-version.json` (and bump `version`, `source`, `updated`):',
      '',
      '  ```json',
      '  "sha256": {',
      `    "darwin-arm64": "${arm}",`,
      `    "darwin-x64": "${x64}"`,
      '  }',
      '  ```',
      '',
    ].join('\n');
  }
  sections.push(nodeBlock);

  // --- Electron ---
  const electronVersions = Object.keys(electronDoc.versions ?? {});
  const newestElectron = newestOnLine(electronVersions, electronMajor);
  const electronNewer = newestElectron && compareVersions(newestElectron, electronCurrent) > 0;
  sections.push(`- Electron: \`${electronCurrent}\` (newest ${electronMajor}.x: \`${newestElectron}\`)${electronNewer ? ' **update available**' : ' up to date'}`);
  if (electronNewer) actionable.push(`Electron ${electronCurrent} -> ${newestElectron}`);
  const electronLatest = electronDoc['dist-tags']?.latest;
  if (electronLatest && parseVersion(electronLatest) && parseVersion(electronLatest)[0] > electronMajor) {
    info.push(`Electron \`latest\` is ${electronLatest} (a newer major than ${electronMajor}.x); not an automatic update, plan a migration.`);
  }

  // --- Other toolchain pins (informational) ---
  for (const doc of latest) {
    const cur = deps[doc.name];
    const newer = cur && parseVersion(cur) && parseVersion(doc.version) && compareVersions(doc.version, cur) > 0;
    sections.push(`- ${doc.name}: \`${cur ?? 'n/a'}\` (latest \`${doc.version}\`)${newer ? ' newer available (informational)' : ' up to date'}`);
  }

  const out = [];
  out.push('# OpenTac toolchain check', '');
  out.push(actionable.length ? `**Action needed:** ${actionable.join('; ')}.` : 'No Node 24.x or Electron 45.x patch updates pending.', '');
  out.push(...sections.map((s) => s), '');
  if (info.length) out.push('Notes:', '', ...info.map((i) => `- ${i}`), '');
  out.push('Procedure: `docs/RELEASE.md` (toolchain bumps), record the change in `docs/DECISIONS.md`.', '');
  console.log(out.join('\n'));
  process.exit(actionable.length ? 2 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`[check-toolchain-updates] ${e.message}`);
    process.exit(1);
  });
}
