# 06 — Marketing Website: opentac.icu

A small, fast, static site whose only jobs are: explain what OpenTac is, let
people download the right build, and credit the upstream project correctly.
It is a separate deliverable from the app but ships with it.

## Non-negotiables

1. **Attribution is above the fold, not in a footer.** OpenTac is a desktop
   wrapper for *God's Eye View*, an open-source project by **Bilawal Sidhu**
   (https://github.com/bilawalsidhu/gods-eye-view, MIT). The hero section must
   say so in plain words, with his name and a link to the repository and to
   his YouTube channel (https://www.youtube.com/@bilawalsidhu). Suggested
   copy: "OpenTac is an unofficial macOS app for God's Eye View, the
   open-source real-time globe created by Bilawal Sidhu. All the magic is his;
   OpenTac just makes it a double-click."
2. **Not affiliated.** State clearly that OpenTac is independent and not
   endorsed by, affiliated with, or supported by the upstream author. Direct
   feature questions and bug reports about the globe itself to the upstream
   repo; app/packaging issues to the OpenTac repo.
3. **Licence compliance.** A `/licenses` page carrying the full MIT licence
   text and copyright line from upstream's `LICENSE`, plus the shell's own
   third-party notices (Electron, Node, dugite/git GPLv2, etc.). Link it from
   the footer and from the app's About panel.
4. **Media.** Do not hotlink or copy the upstream README's hero GIFs, YouTube
   thumbnails or screenshots without permission; the MIT licence covers code,
   not necessarily the marketing assets. Use **your own screenshots of OpenTac
   running** (which show upstream's UI — that's fine, it's a screenshot of the
   software) and keep an "Screenshots show God's Eye View running inside
   OpenTac" caption.
5. **Name.** The product name is OpenTac everywhere; "God's Eye View" appears
   only when referring to the upstream project. Don't style the upstream name
   as if it were your brand.
6. **No tracking.** No analytics scripts, no cookies, no third-party fonts
   loaded at runtime (self-host or system fonts). Matches the app's no-
   telemetry stance; say so on the privacy page.

## Content map

- **/** — hero (name, one-line pitch, attribution, primary Download button
  that auto-detects Apple Silicon vs Intel via `navigator.userAgent` /
  `navigator.platform` hints, with an explicit "Other downloads" link), three
  or four feature tiles (live aircraft/ships/satellites, voice control,
  photorealistic 3D with your own keys, self-updating engine), a short
  "How it works" (bundled runtime, live checkout from GitHub, updates with
  full disclosure), system requirements (macOS 12+, Apple Silicon or Intel,
  ~1 GB disk after first run, internet), FAQ.
- **/download** — both `.dmg` links, `.zip` links, SHA-256 checksums, the
  current version, release notes link, "verify the signature" instructions
  (`spctl -a -vv`), link to older releases on GitHub.
- **/keys** — which API keys unlock what (Cesium ion, Google Maps, OpenAI,
  Gemini, aisstream, FIRMS, TomTom, OpenSky, LL2), that they're optional, that
  they're stored only on the user's Mac in the engine's `.env`, and a link
  to upstream's own "Keys & Costs" README section.
- **/ai** — the AI options as described in `07-AI-PROVIDERS.md` once built
  (voice: OpenAI or Gemini; summaries: OpenAI, Ollama, OpenRouter, xAI).
- **/licenses**, **/privacy**, **/credits** (upstream author first; then
  Electron, Node.js, Chromium, Cesium, OpenStreetMap, Esri and the data
  providers upstream lists in `DATA_SOURCES.md` — link to it rather than copy
  it).
- **/changelog** — generated from the OpenTac GitHub Releases.

## Technical requirements

- Static site: Astro (recommended) or plain HTML + a build script. No server.
- Hosting: GitHub Pages (custom domain `opentac.icu`, HTTPS enforced) or
  Cloudflare Pages. DNS: `A`/`AAAA` or `CNAME` per the host's docs, plus
  `www` → apex redirect.
- **Download links resolve at build time** from the GitHub Releases API of
  the OpenTac repo (`/repos/OWNER/opentac/releases/latest`): asset URLs,
  sizes, SHA-256 (publish `SHA256SUMS.txt` as a release asset from CI), and
  version. Rebuild the site from a GitHub Action triggered on
  `release: published`. Fallback: a client-side fetch to the same API if the
  build-time data is stale (cache for 1 h).
- Lighthouse ≥ 95 on all four categories; works without JavaScript except
  arch auto-detect.
- `robots.txt`, `sitemap.xml`, Open Graph image (your own screenshot),
  favicon from the OpenTac icon (not upstream's logo — design a distinct
  mark; a stylised "OT" or reticle is fine).
- Security headers via the host: `Strict-Transport-Security`,
  `X-Content-Type-Options`, a strict CSP (`default-src 'self'`).
- Repo layout suggestion: `site/` directory inside the OpenTac repo or a
  separate `opentac-site` repo; either is fine — log the choice.

## Acceptance

- Hero visibly credits Bilawal Sidhu with repo link on desktop and mobile.
- Download button on an Apple Silicon Mac fetches the arm64 `.dmg` from the
  latest published release; Intel gets x64; both links present on /download
  with matching checksums.
- `/licenses` contains upstream's MIT text verbatim.
- No third-party requests at all in the network panel on any page.
- Site rebuilds automatically within minutes of publishing a release.
