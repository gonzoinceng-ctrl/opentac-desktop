#!/usr/bin/env node
// Release check for the deployed site and for every URL the desktop app opens.
//   node site/check-live.mjs [--base https://opentac.icu] [--base https://opentac.pages.dev]
// Exits 1 if any URL does not answer 2xx (after redirects), or if the live home page is stale
// (still showing the screenshot placeholder while src/assets/screenshots has files, or missing a built page).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = process.argv.slice(2);
const bases = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--base' && args[i + 1]) bases.push(args[++i].replace(/\/+$/, ''));
if (bases.length === 0) bases.push('https://opentac.icu');

const problems = [];
async function get(url) {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'opentac-site-check' } });
    return { status: res.status, text: await res.text() };
  } catch (e) {
    return { status: 0, text: '', error: e.message };
  }
}

// URLs the app itself opens: the About "View licences" link, the Help menu site item, and the static links in the menu.
const appUrls = new Set();
for (const f of ['src/main/index.ts', 'src/renderer/setup/view.ts']) {
  const file = path.join(root, f);
  if (!fs.existsSync(file)) continue;
  for (const m of fs.readFileSync(file, 'utf8').matchAll(/['"`](https:\/\/[^'"`\s$]+)['"`]/g)) {
    if (/opentac\.icu|github\.com/.test(m[1])) appUrls.add(m[1]);
  }
}

// Pages the local build produces (site/dist/sitemap.xml) must all exist on the deployment.
const sitemap = path.join(here, 'dist', 'sitemap.xml');
const pagePaths = fs.existsSync(sitemap)
  ? [...fs.readFileSync(sitemap, 'utf8').matchAll(/<loc>https?:\/\/[^/]+(\/[^<]*)<\/loc>/g)].map((m) => m[1])
  : ['/'];
const hasShots = fs.existsSync(path.join(here, 'src', 'assets', 'screenshots')) &&
  fs.readdirSync(path.join(here, 'src', 'assets', 'screenshots')).some((f) => /\.(png|webp)$/i.test(f));

for (const base of bases) {
  console.log(`# ${base}`);
  for (const p of pagePaths) {
    const r = await get(base + p);
    const ok = r.status >= 200 && r.status < 300;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${r.status} ${base}${p}${r.error ? ' ' + r.error : ''}`);
    if (!ok) problems.push(`${base}${p} -> ${r.status || r.error}`);
    if (ok && p === '/' && hasShots && r.text.includes('Screenshot coming soon')) {
      problems.push(`${base}/ is stale: shows the screenshot placeholder but src has screenshots (rebuild and redeploy)`);
    }
  }
}
console.log('# URLs opened by the app');
for (const u of appUrls) {
  const r = await get(u);
  const ok = r.status >= 200 && r.status < 300;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${r.status} ${u}${r.error ? ' ' + r.error : ''}`);
  if (!ok) problems.push(`app link ${u} -> ${r.status || r.error}`);
}
if (problems.length) {
  console.error('\nsite check failed:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log('\nsite check passed');
