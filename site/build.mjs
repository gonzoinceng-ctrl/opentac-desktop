#!/usr/bin/env node
// OpenTac static site builder. Node 24, ESM, no dependencies beyond node builtins
// (sharp is borrowed from the project root's devDependencies, and only to (re)generate images).
//
//   node site/build.mjs            build into site/dist
//   node site/build.mjs --serve    build, serve on http://127.0.0.1:4310, rebuild on change
//   node site/build.mjs --images   force regeneration of favicons / OG image
//
// Env: GITHUB_TOKEN (optional, raises the API rate limit), OPENTAC_ENGINE_STABLE (stable-* tag shown on
// /changelog), OPENTAC_SITE_OFFLINE=1 (skip all network), OPENTAC_SITE_FIXTURE=file.json
// ({latest, releases, sums}) to render a populated site without the network.

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(HERE, 'src');
const DIST = path.join(HERE, 'dist');
const argv = new Set(process.argv.slice(2));

// ---------------------------------------------------------------------------------------------
// Constants (single source for every URL the templates use)
// ---------------------------------------------------------------------------------------------
const SITE_URL = 'https://opentac.icu';
const APP_REPO = 'gonzoinceng-ctrl/opentac-desktop';
const MIRROR_REPO = 'gonzoinceng-ctrl/opentac-engine';
const UPSTREAM_REPO = 'bilawalsidhu/gods-eye-view';
const GLOBALS = {
  site: { url: SITE_URL, name: 'OpenTac' },
  links: {
    app: `https://github.com/${APP_REPO}`,
    appIssues: `https://github.com/${APP_REPO}/issues`,
    appReleases: `https://github.com/${APP_REPO}/releases`,
    appNotices: `https://github.com/${APP_REPO}/blob/main/THIRD_PARTY_NOTICES.md`,
    mirror: `https://github.com/${MIRROR_REPO}`,
    upstream: `https://github.com/${UPSTREAM_REPO}`,
    upstreamIssues: `https://github.com/${UPSTREAM_REPO}/issues`,
    upstreamKeys: `https://github.com/${UPSTREAM_REPO}#-api-keys`,
    upstreamData: `https://github.com/${UPSTREAM_REPO}/blob/main/DATA_SOURCES.md`,
    youtube: 'https://www.youtube.com/@bilawalsidhu',
  },
};
const API = 'https://api.github.com';
const FETCH_TIMEOUT_MS = 10_000;
const IMAGE_GEN_VERSION = 'img-v1';

const log = (...a) => console.log('[site]', ...a);
const warn = (...a) => console.warn('[site] WARN', ...a);

// ---------------------------------------------------------------------------------------------
// Tiny template engine: {{var}} (escaped), {{{var}}} (raw), {{> partial}},
// {{#if x}}..{{else}}..{{/if}}, {{#each list}}..{{/each}} ({{this}} inside primitives)
// ---------------------------------------------------------------------------------------------
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const TAG_RE = /\{\{\{\s*([\w.]+)\s*\}\}\}|\{\{\s*([#/>]?)\s*([\w.]+)(?:\s+([\w.]+))?\s*\}\}/g;

function parse(src, file) {
  const root = { type: 'root', children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  let last = 0;
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(src))) {
    if (m.index > last) top().children.push({ type: 'text', value: src.slice(last, m.index) });
    last = TAG_RE.lastIndex;
    if (m[1] !== undefined) {
      top().children.push({ type: 'raw', name: m[1] });
      continue;
    }
    const [, , sigil, name, arg] = m;
    if (sigil === '>') top().children.push({ type: 'partial', name });
    else if (sigil === '#') {
      if (name !== 'if' && name !== 'each') throw new Error(`${file}: unknown block {{#${name}}}`);
      if (!arg) throw new Error(`${file}: {{#${name}}} needs an argument`);
      const node = { type: name, arg, children: [], elseAt: null };
      top().children.push(node);
      stack.push(node);
    } else if (sigil === '/') {
      if (top().type !== name) throw new Error(`${file}: mismatched {{/${name}}}`);
      stack.pop();
    } else if (name === 'else') {
      if (top().type !== 'if') throw new Error(`${file}: {{else}} outside {{#if}}`);
      top().elseAt = top().children.length;
    } else top().children.push({ type: 'var', name });
  }
  if (last < src.length) top().children.push({ type: 'text', value: src.slice(last) });
  if (stack.length !== 1) throw new Error(`${file}: unclosed {{#${top().type}}}`);
  return root.children;
}

function lookup(name, scopes) {
  if (name === 'this') return scopes[scopes.length - 1];
  const [head, ...rest] = name.split('.');
  for (let i = scopes.length - 1; i >= 0; i--) {
    const s = scopes[i];
    if (s !== null && typeof s === 'object' && head in s) {
      let v = s[head];
      for (const k of rest) v = v == null ? undefined : v[k];
      return v;
    }
  }
  return undefined;
}
const truthy = (v) => (Array.isArray(v) ? v.length > 0 : Boolean(v));

function renderNodes(nodes, scopes, partials, file) {
  let out = '';
  for (const n of nodes) {
    switch (n.type) {
      case 'text': out += n.value; break;
      case 'var':
      case 'raw': {
        const v = lookup(n.name, scopes);
        if (v === undefined) throw new Error(`${file}: undefined variable "${n.name}"`);
        out += n.type === 'raw' ? String(v) : esc(v);
        break;
      }
      case 'partial': {
        const p = partials[n.name];
        if (!p) throw new Error(`${file}: unknown partial "${n.name}"`);
        out += renderNodes(p, scopes, partials, `partial:${n.name}`);
        break;
      }
      case 'if': {
        const cut = n.elseAt ?? n.children.length;
        const branch = truthy(lookup(n.arg, scopes)) ? n.children.slice(0, cut) : n.children.slice(cut);
        out += renderNodes(branch, scopes, partials, file);
        break;
      }
      case 'each': {
        const list = lookup(n.arg, scopes) ?? [];
        for (const item of list) out += renderNodes(n.children, [...scopes, item], partials, file);
        break;
      }
    }
  }
  return out;
}

const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');

// ---------------------------------------------------------------------------------------------
// Release data (GitHub API at build time, never at runtime)
// ---------------------------------------------------------------------------------------------
async function ghFetch(url, { json = true } = {}) {
  const headers = { 'User-Agent': 'opentac-site-build', 'X-GitHub-Api-Version': '2022-11-28' };
  if (json) headers.Accept = 'application/vnd.github+json';
  if (process.env.GITHUB_TOKEN && url.startsWith(API)) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.replace(/\?.*/, '')}`);
  return json ? res.json() : res.text();
}

async function loadRaw() {
  const result = { latest: null, releases: [], sums: null, source: 'none' };
  if (process.env.OPENTAC_SITE_FIXTURE) {
    const f = JSON.parse(fs.readFileSync(process.env.OPENTAC_SITE_FIXTURE, 'utf8'));
    return { latest: f.latest ?? null, releases: f.releases ?? [], sums: f.sums ?? null, source: 'fixture' };
  }
  if (process.env.OPENTAC_SITE_OFFLINE === '1') return result;
  try {
    result.latest = await ghFetch(`${API}/repos/${APP_REPO}/releases/latest`);
    result.source = 'github';
  } catch (e) {
    warn(`latest release unavailable: ${e.message}`);
  }
  try {
    const list = await ghFetch(`${API}/repos/${APP_REPO}/releases?per_page=20`);
    if (Array.isArray(list)) result.releases = list;
  } catch (e) {
    warn(`release list unavailable: ${e.message}`);
  }
  if (!result.latest) result.latest = result.releases.find((r) => !r.draft && !r.prerelease) ?? null;
  const sumsAsset = result.latest?.assets?.find((a) => /^sha256sums(\.txt)?$/i.test(a.name));
  if (sumsAsset) {
    try {
      result.sums = await ghFetch(sumsAsset.browser_download_url, { json: false });
    } catch (e) {
      warn(`SHA256SUMS.txt unavailable: ${e.message}`);
    }
  }
  return result;
}

const fmtDate = (iso) =>
  iso ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(iso)) : '';
const fmtSize = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`);

function parseSums(text) {
  const map = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/);
    if (m) map.set(path.basename(m[2]), m[1].toLowerCase());
  }
  return map;
}

function inline(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noopener">$1</a>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(?<![">=/])(https?:\/\/[^\s<]*[^\s<.,;:!?)&])/g, '<a href="$1" rel="noopener">$1</a>');
  return t;
}

function mdToHtml(src) {
  const out = [];
  let para = [];
  let inList = false;
  const flush = () => { if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`); para = []; };
  const close = () => { if (inList) out.push('</ul>'); inList = false; };
  for (const line of String(src ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    let m;
    if (!line.trim()) { flush(); close(); }
    else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flush(); close();
      const lvl = Math.min(6, Math.max(3, m[1].length + 1));
      out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
    } else if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
      flush();
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else { close(); para.push(line.trim()); }
  }
  flush(); close();
  return out.join('\n');
}

function buildReleaseData(raw) {
  const sums = parseSums(raw.sums);
  const describeAsset = (a) => ({
    name: a.name,
    url: a.browser_download_url,
    size: fmtSize(a.size ?? 0),
    sha256: sums.get(a.name) ?? (/^sha256:([0-9a-f]{64})$/i.exec(a.digest ?? '')?.[1]?.toLowerCase() ?? ''),
  });
  const toRelease = (r) => ({
    tag: r.tag_name,
    name: r.name || r.tag_name,
    version: String(r.tag_name ?? '').replace(/^v/i, ''),
    url: r.html_url,
    prerelease: Boolean(r.prerelease),
    date: fmtDate(r.published_at ?? r.created_at),
    iso: (r.published_at ?? r.created_at ?? '').slice(0, 10),
    notesHtml: mdToHtml(r.body),
    hasNotes: Boolean((r.body ?? '').trim()),
  });

  const data = { available: false, arches: [], latest: null };
  const dl = { both: false, archAttrs: '', primaryUrl: '', primaryLabel: '', altUrl: '', altLabel: '', hasPrimary: false };
  const r = raw.latest;
  if (r && r.tag_name && !r.draft) {
    const assets = (r.assets ?? []).filter((a) => /\.(dmg|zip)$/i.test(a.name) && a.browser_download_url);
    const pick = (arch, ext) => {
      const a = assets.find((x) => (/arm64/i.test(x.name) ? 'arm64' : 'x64') === arch && x.name.toLowerCase().endsWith(ext));
      return a ? describeAsset(a) : null;
    };
    const arches = [
      { key: 'arm64', label: 'Apple Silicon', hint: 'M1 and later', dmg: pick('arm64', '.dmg'), zip: pick('arm64', '.zip') },
      { key: 'x64', label: 'Intel', hint: 'x64', dmg: pick('x64', '.dmg'), zip: pick('x64', '.zip') },
    ].filter((a) => a.dmg || a.zip);
    if (arches.length) {
      const arm = arches.find((a) => a.key === 'arm64')?.dmg;
      const x64 = arches.find((a) => a.key === 'x64')?.dmg;
      const rel = toRelease(r);
      Object.assign(data, { available: true, arches, latest: rel, hasSums: sums.size > 0, anySha: arches.some((a) => a.dmg?.sha256 || a.zip?.sha256) });
      dl.hasPrimary = true;
      dl.primaryUrl = arm?.url || x64?.url || arches[0].dmg?.url || arches[0].zip.url;
      dl.primaryLabel = arm ? 'Download for Apple Silicon' : x64 ? 'Download for Intel' : 'Download';
      if (arm && x64) {
        dl.both = true;
        dl.altUrl = x64.url;
        dl.altLabel = 'Intel Mac? Download x64';
        dl.archAttrs =
          `data-arch-root data-arm64-href="${esc(arm.url)}" data-x64-href="${esc(x64.url)}" ` +
          `data-arm64-label="Download for Apple Silicon" data-x64-label="Download for Intel" ` +
          `data-arm64-alt="Apple Silicon Mac? Download arm64" data-x64-alt="Intel Mac? Download x64"`;
      } else {
        dl.altUrl = '';
      }
    }
  }

  const list = (raw.releases ?? []).filter((x) => x && !x.draft && x.tag_name).map(toRelease);
  return { release: data, dl, releases: list };
}

// ---------------------------------------------------------------------------------------------
// Images: favicon set + OG image from build/icon-1024.png (sharp from the project root)
// ---------------------------------------------------------------------------------------------
const IMG_DIR = path.join(SRC, 'assets', 'img');
const IMG_FILES = ['favicon.svg', 'favicon.ico', 'icon-32.png', 'icon-64.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'og-image.png'];

const ogSvg = () => `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs><radialGradient id="g" cx="25%" cy="50%" r="75%"><stop offset="0" stop-color="#14202a"/><stop offset="1" stop-color="#0a0a0f"/></radialGradient></defs>
  <rect width="1200" height="630" fill="url(#g)"/>
  <g font-family="Helvetica Neue, Helvetica, Arial, sans-serif">
    <text x="520" y="290" font-size="128" font-weight="700" fill="#f2f4f8">OpenTac</text>
    <rect x="524" y="318" width="120" height="6" rx="3" fill="#5ee7ff"/>
    <text x="522" y="388" font-size="32" fill="#c9d1dc">Unofficial macOS app for God's Eye View</text>
    <text x="522" y="436" font-size="28" fill="#8f9bad">All the magic is Bilawal Sidhu's.</text>
    <text x="522" y="548" font-size="30" font-weight="600" fill="#5ee7ff">opentac.icu</text>
  </g>
</svg>`;

function makeIco(entries) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  let offset = 6 + 16 * entries.length;
  const dir = entries.map(({ size, buf }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(buf.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += buf.length;
    return e;
  });
  return Buffer.concat([head, ...dir, ...entries.map((e) => e.buf)]);
}

async function ensureImages(force) {
  const iconPath = path.join(ROOT, 'build', 'icon-1024.png');
  const svgPath = path.join(ROOT, 'build', 'icon-source.svg');
  const marker = path.join(IMG_DIR, '.source-hash');
  const have = () => IMG_FILES.every((f) => fs.existsSync(path.join(IMG_DIR, f)));
  if (!fs.existsSync(iconPath)) {
    if (have()) { warn('build/icon-1024.png missing; keeping committed images'); return 'kept'; }
    throw new Error('build/icon-1024.png missing and no generated images present');
  }
  const iconBytes = fs.readFileSync(iconPath);
  const hash = createHash('sha256').update(iconBytes).update(ogSvg()).update(IMAGE_GEN_VERSION).digest('hex');
  if (!force && have() && fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === hash) return 'cached';

  let sharp;
  try {
    const req = createRequire(path.join(ROOT, 'package.json'));
    const mod = await import(pathToFileURL(req.resolve('sharp')).href);
    sharp = mod.default ?? mod;
  } catch (e) {
    if (have()) { warn(`sharp unavailable (${e.code ?? e.message}); keeping committed images`); return 'kept'; }
    throw new Error('sharp is not installed (run `npm ci` at the project root once) and no generated images exist');
  }

  const bg = { r: 10, g: 10, b: 15, alpha: 1 };
  const out = (f) => path.join(IMG_DIR, f);
  const png = (size) => sharp(iconBytes).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
  fs.mkdirSync(IMG_DIR, { recursive: true });
  fs.copyFileSync(svgPath, out('favicon.svg'));
  const p16 = await png(16), p32 = await png(32), p48 = await png(48);
  fs.writeFileSync(out('favicon.ico'), makeIco([{ size: 16, buf: p16 }, { size: 32, buf: p32 }, { size: 48, buf: p48 }]));
  fs.writeFileSync(out('icon-32.png'), p32);
  fs.writeFileSync(out('icon-64.png'), await png(64));
  fs.writeFileSync(out('icon-192.png'), await png(192));
  fs.writeFileSync(out('icon-512.png'), await png(512));
  // iOS wants an opaque square with the mark inset
  const inner = await sharp(iconBytes).resize(140, 140).png().toBuffer();
  fs.writeFileSync(out('apple-touch-icon.png'), await sharp({ create: { width: 180, height: 180, channels: 4, background: bg } }).composite([{ input: inner, left: 20, top: 20 }]).png({ compressionLevel: 9 }).toBuffer());
  const og = await sharp(Buffer.from(ogSvg())).png().toBuffer();
  fs.writeFileSync(out('og-image.png'), await sharp(og).composite([{ input: await png(380), left: 90, top: 125 }]).png({ compressionLevel: 9 }).toBuffer());
  fs.writeFileSync(marker, hash + '\n');
  return 'generated';
}


// ---------------------------------------------------------------------------------------------
// Screenshots: whatever PNG/WebP files sit in src/assets/screenshots/ (produced by scripts/screenshots.mts)
// ---------------------------------------------------------------------------------------------
const SHOT_DIR = path.join(SRC, 'assets', 'screenshots');
const SHOT_INFO = {
  '01-globe': ['The globe', 'The God\'s Eye View globe running in an OpenTac window'],
  '02-setup-progress': ['First-run setup', 'OpenTac setup window showing install progress on first launch'],
  '03-preferences-keys': ['Preferences: API keys', 'OpenTac Preferences, API keys tab'],
  '04-preferences-engine': ['Preferences: engine settings', 'OpenTac Preferences, engine settings tab'],
  '05-preferences-app': ['Preferences: app settings', 'OpenTac Preferences, app settings tab'],
  '06-about': ['About OpenTac', 'OpenTac About panel crediting God\'s Eye View and Bilawal Sidhu'],
  '07-update-disclosure': ['Update disclosure', 'OpenTac showing what an engine update changes before it is applied'],
};

function imageSize(file) {
  const b = fs.readFileSync(file);
  if (b.length > 24 && b.toString('latin1', 1, 4) === 'PNG') return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const kind = b.toString('latin1', 12, 16);
    if (kind === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (kind === 'VP8L') { const v = b.readUInt32LE(21); return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 }; }
    if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

function loadShots() {
  if (!fs.existsSync(SHOT_DIR)) return [];
  const stems = new Map();
  for (const f of fs.readdirSync(SHOT_DIR).sort()) {
    const m = /^([\w-]+)\.(png|webp)$/i.exec(f);
    if (!m) continue;
    const e = stems.get(m[1]) ?? {};
    e[m[2].toLowerCase()] = f;
    stems.set(m[1], e);
  }
  const shots = [];
  for (const [stem, e] of stems) {
    const size = imageSize(path.join(SHOT_DIR, e.png ?? e.webp));
    if (!size) { warn(`screenshot ${stem}: unreadable image, skipped`); continue; }
    const [title, alt] = SHOT_INFO[stem] ?? [stem.replace(/^\d+-/, '').replace(/-/g, ' '), `OpenTac screenshot: ${stem}`];
    const url = (f) => `/assets/screenshots/${f}`;
    shots.push({
      stem, title, alt, ...size,
      webp: e.webp ? url(e.webp) : '',
      src: url(e.png ?? e.webp),
    });
  }
  return shots;
}

// ---------------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------------
const NAV = ['download', 'keys', 'ai', 'changelog', 'contact'];

function walk(dir) {
  const files = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...walk(p));
    else files.push(p);
  }
  return files;
}

function loadPartials() {
  const out = {};
  for (const f of fs.readdirSync(path.join(SRC, 'partials'))) {
    if (!f.endsWith('.html')) continue;
    out[f.replace(/\.html$/, '')] = parse(stripComments(fs.readFileSync(path.join(SRC, 'partials', f), 'utf8')), `partial:${f}`);
  }
  return out;
}

function parsePage(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error(`${file}: missing front matter`);
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  for (const k of ['title', 'description', 'path']) if (!meta[k]) throw new Error(`${file}: front matter needs "${k}"`);
  return { meta, body: raw.slice(m[0].length) };
}

function headersFile() {
  const csp = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
  return `# Cloudflare Pages response headers (generated by site/build.mjs)
/*
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()
  Content-Security-Policy: ${csp}

/assets/*
  Cache-Control: public, max-age=3600

/favicon.ico
  Cache-Control: public, max-age=3600
`;
}

// Cloudflare Pages' _redirects only matches paths, never hostnames (docs: domain-level redirects are
// unsupported there), so a literal "www -> apex" rule cannot live in this file. The www redirect is a
// Cloudflare Redirect Rule (see site/README.md). The rules below are the path-level ones that do work.
const redirectsFile = () => `# Cloudflare Pages redirects (generated by site/build.mjs)
# NOTE: www.opentac.icu -> opentac.icu (301) cannot be expressed here: _redirects matches paths only,
# not hostnames. Configure it as a Cloudflare Redirect Rule; see site/README.md.
/licences /licenses/ 301
`;

async function build(cache) {
  const t0 = Date.now();
  const imgState = await ensureImages(argv.has('--images'));
  log(`images: ${imgState}`);

  cache.raw ??= await loadRaw();
  const rel = buildReleaseData(cache.raw);
  log(
    rel.release.available
      ? `release: ${rel.release.latest.tag} (${cache.raw.source}), ${rel.release.arches.length} arch(es), checksums ${rel.release.anySha ? 'yes' : 'no'}`
      : `release: none (${cache.raw.source}) -> "coming soon" state`,
  );
  log(`changelog entries: ${rel.releases.length}`);

  const engineTag = process.env.OPENTAC_ENGINE_STABLE ?? '';
  const engine = /^[A-Za-z0-9._-]{1,80}$/.test(engineTag)
    ? { known: true, tag: engineTag, url: `${GLOBALS.links.mirror}/tree/${engineTag}` }
    : { known: false, tag: '', url: GLOBALS.links.mirror };
  if (engineTag && !engine.known) warn('OPENTAC_ENGINE_STABLE ignored (unexpected characters)');

  const licenseText = fs.readFileSync(path.join(SRC, 'content', 'gods-eye-view-LICENSE.txt'), 'utf8');
  const partials = loadPartials();
  const buildDate = new Date().toISOString().slice(0, 10);
  const shots = loadShots();
  const hero = shots.find((x) => x.stem === '01-globe') ?? shots[0] ?? null;
  const gallery = shots.filter((x) => x !== hero);
  log(`screenshots: ${shots.length}`);

  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  const pages = [];
  const pageDir = path.join(SRC, 'pages');
  for (const f of fs.readdirSync(pageDir).filter((x) => x.endsWith('.html')).sort()) {
    const { meta, body } = parsePage(path.join(pageDir, f));
    const canonical = SITE_URL + (meta.path === '/' ? '/' : meta.path);
    const vars = {
      ...GLOBALS,
      ...rel,
      engine,
      license_text: esc(licenseText),
      hero: hero ?? false,
      gallery,
      hasShots: shots.length > 0,
      build_date: buildDate,
      title: meta.title,
      description: meta.description,
      path: meta.path,
      canonical,
      page_title: meta['page-title'] || `${meta.title} | OpenTac`,
      noindex: meta.noindex === 'true',
    };
    for (const k of NAV) vars[`aria_${k}`] = meta.current === k ? ' aria-current="page"' : '';
    const tree = parse(stripComments(body), f);
    const html = renderNodes(tree, [vars], partials, f).replace(/\n{3,}/g, '\n\n');
    const outPath = f === '404.html' ? '404.html' : meta.path === '/' ? 'index.html' : path.join(meta.path.replace(/^\//, ''), 'index.html');
    fs.mkdirSync(path.dirname(path.join(DIST, outPath)), { recursive: true });
    fs.writeFileSync(path.join(DIST, outPath), html);
    pages.push({ file: outPath, path: meta.path, indexable: f !== '404.html' && meta.noindex !== 'true' });
  }

  // static assets (skip dotfiles), favicon at the root, manifest
  for (const p of walk(path.join(SRC, 'assets'))) {
    const to = path.join(DIST, 'assets', path.relative(path.join(SRC, 'assets'), p));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(p, to);
  }
  fs.copyFileSync(path.join(IMG_DIR, 'favicon.ico'), path.join(DIST, 'favicon.ico'));
  fs.writeFileSync(
    path.join(DIST, 'site.webmanifest'),
    JSON.stringify({
      name: 'OpenTac', short_name: 'OpenTac', start_url: '/', display: 'browser',
      background_color: '#0a0a0f', theme_color: '#0a0a0f',
      icons: [
        { src: '/assets/img/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/assets/img/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    }, null, 2) + '\n',
  );

  fs.writeFileSync(path.join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);
  const urls = pages.filter((p) => p.indexable).map((p) => `  <url>\n    <loc>${SITE_URL}${p.path}</loc>\n    <lastmod>${buildDate}</lastmod>\n  </url>`);
  fs.writeFileSync(path.join(DIST, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`);
  fs.writeFileSync(path.join(DIST, '_headers'), headersFile());
  fs.writeFileSync(path.join(DIST, '_redirects'), redirectsFile());

  lint(pages);
  log(`built ${pages.length} pages in ${Date.now() - t0} ms -> ${path.relative(process.cwd(), DIST) || DIST}`);
}

// Fail the build on anything that would break under the strict CSP or on dead internal links.
function lint(pages) {
  const problems = [];
  for (const p of pages) {
    const html = fs.readFileSync(path.join(DIST, p.file), 'utf8');
    if (/\sstyle\s*=/.test(html)) problems.push(`${p.file}: inline style attribute (blocked by CSP)`);
    if (/<style[\s>]/i.test(html)) problems.push(`${p.file}: <style> element (blocked by CSP)`);
    if (/<script(?![^>]*\ssrc=)[^>]*>/i.test(html)) problems.push(`${p.file}: inline <script> (blocked by CSP)`);
    if (/\son[a-z]+\s*=\s*["']/i.test(html.replace(/<pre[\s\S]*?<\/pre>/g, ''))) problems.push(`${p.file}: inline event handler`);
    if (/\{\{|\}\}/.test(html.replace(/<pre[\s\S]*?<\/pre>/g, ''))) problems.push(`${p.file}: unresolved template tag`);
    for (const m of html.matchAll(/\b(?:href|src)="(\/[^"#?]*)/g)) {
      if (m[1].startsWith('//')) continue;
      const target = m[1].endsWith('/') ? m[1] + 'index.html' : m[1];
      if (!fs.existsSync(path.join(DIST, target))) problems.push(`${p.file}: broken internal link ${m[1]}`);
    }
  }
  if (problems.length) throw new Error('site lint failed:\n  ' + problems.join('\n  '));
}

// ---------------------------------------------------------------------------------------------
// Dev server
// ---------------------------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
};

function serve(port = 4310, host = '127.0.0.1') {
  const csp = fs.readFileSync(path.join(DIST, '_headers'), 'utf8').match(/Content-Security-Policy: (.*)/)?.[1];
  createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end('bad request'); return; }
    let file = path.join(DIST, path.normalize(pathname));
    if (!file.startsWith(DIST + path.sep) && file !== DIST) { res.writeHead(403).end('forbidden'); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      if (!pathname.endsWith('/')) { res.writeHead(301, { Location: pathname + '/' }).end(); return; }
      file = path.join(file, 'index.html');
    }
    const found = fs.existsSync(file) && fs.statSync(file).isFile();
    if (!found) file = path.join(DIST, '404.html');
    const headers = { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
    if (csp) headers['Content-Security-Policy'] = csp;
    res.writeHead(found ? 200 : 404, headers);
    fs.createReadStream(file).pipe(res);
  }).listen(port, host, () => log(`serving http://${host}:${port}/  (CSP applied; Ctrl-C to stop)`));
}

// ---------------------------------------------------------------------------------------------
const cache = {};
try {
  await build(cache);
} catch (e) {
  console.error(`[site] build failed: ${e.message}`);
  process.exit(1);
}
if (argv.has('--serve')) {
  serve();
  let timer;
  fs.watch(SRC, { recursive: true }, (_ev, name) => {
    if (name && /(^|\/)\./.test(name)) return;
    clearTimeout(timer);
    timer = setTimeout(() => build(cache).catch((e) => console.error(`[site] rebuild failed: ${e.message}`)), 250);
  });
}
