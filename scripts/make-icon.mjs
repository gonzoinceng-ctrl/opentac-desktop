#!/usr/bin/env node
/**
 * Render build/icon-source.svg → build/icon.icns via sharp + iconutil.
 * The source SVG is an original OpenTac mark (reticle over a horizon arc), deliberately not derived
 * from upstream's public/logo.svg; see THIRD_PARTY_NOTICES.md "App icon". Idempotent; safe to re-run.
 */
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const src = path.join(root, 'build/icon-source.svg');
const iconset = path.join(root, 'build/icon.iconset');
const icns = path.join(root, 'build/icon.icns');
if (!existsSync(src)) { console.error(`[make-icon] missing ${src}`); process.exit(1); }

rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset, { recursive: true });
const logo = readFileSync(src);
const BASE = 1024;
// macOS-style tile: dark rounded square (upstream's theme colour) with the logo contained inside a ~12% margin.
const tile = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${BASE}" height="${BASE}" viewBox="0 0 ${BASE} ${BASE}">
    <rect x="52" y="52" width="920" height="920" rx="200" ry="200" fill="#0a0a0f"/>
  </svg>`);
const inner = Math.round(BASE * 0.72);
const logoPng = await sharp(logo, { density: 512 })
  .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png().toBuffer();
const master = await sharp(tile).png()
  .composite([{ input: logoPng, left: Math.round((BASE - inner) / 2), top: Math.round((BASE - inner) / 2) }])
  .png().toBuffer();
await sharp(master).toFile(path.join(root, 'build/icon-1024.png'));
const sizes = [16, 32, 128, 256, 512];
for (const s of sizes) {
  await sharp(master).resize(s, s).png().toFile(path.join(iconset, `icon_${s}x${s}.png`));
  await sharp(master).resize(s * 2, s * 2).png().toFile(path.join(iconset, `icon_${s}x${s}@2x.png`));
}
const r = spawnSync('iconutil', ['-c', 'icns', iconset, '-o', icns], { stdio: 'inherit' });
if (r.status !== 0) { console.error('[make-icon] iconutil failed'); process.exit(1); }
console.log(`[make-icon] wrote ${icns}`);
