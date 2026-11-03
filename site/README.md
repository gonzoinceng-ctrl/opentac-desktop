# OpenTac website (opentac.icu)

A static site with no framework and no npm dependencies. `build.mjs` (Node 24, ESM) renders
`src/pages/*.html` through `src/partials/*.html` into `dist/`.

```
npm run site:build     # node site/build.mjs        -> site/dist
npm run site:dev       # node site/build.mjs --serve -> http://127.0.0.1:4310 (rebuilds on change, applies the production CSP)
node site/build.mjs --images   # force-regenerate favicons and the OG image
```

## How it is put together

- **Templates.** A page starts with front matter (`title`, `description`, `path`, optional `current`,
  `page-title`, `noindex`). Syntax: `{{var}}` (HTML-escaped), `{{{var}}}` (raw), `{{> partial}}`,
  `{{#if x}}...{{else}}...{{/if}}`, `{{#each list}}...{{/each}}`. An undefined variable fails the build.
  Shared URLs live once in `build.mjs` (`GLOBALS.links`).
- **Release data is build-time only.** The build calls `GET /repos/gonzoinceng-ctrl/opentac-desktop/releases/latest`
  and `/releases?per_page=20` (10 s timeout each, optional `GITHUB_TOKEN`), reads the `SHA256SUMS.txt` asset
  (falling back to the API's per-asset `digest`), and classifies `.dmg`/`.zip` assets as arm64 when the file name
  contains `arm64`, otherwise x64. If there is no release or a request fails, every page shows a
  "First release coming soon, build from source on GitHub" state; no button ever points nowhere.
  There is no runtime API call (the CSP has `connect-src 'none'`).
- **Architecture detection** is `src/assets/js/arch.js`: `navigator.userAgentData.getHighEntropyValues(['architecture'])`,
  else a WebGL renderer probe (`Apple M…` is arm64; Intel/AMD/NVIDIA is x64; Safari's masked `Apple GPU` is left on
  arm64). The explicit "Intel Mac? Download x64" link is always in the HTML.
- **Images.** `build/icon-1024.png` is turned into the favicon set (SVG, ICO, 32/64/192/512, apple-touch) and a
  1200x630 OG image using `sharp` from the project root's `node_modules`. Output is committed in
  `src/assets/img/` with a source hash, so a build only needs `sharp` when the icon or the OG template changes.
  CI or Cloudflare can build without `npm ci`. The OG text uses system fonts: regenerate it on a Mac.
- **Licence text.** `src/content/gods-eye-view-LICENSE.txt` is a verbatim copy of upstream's `LICENSE`, rendered on
  `/licenses`. When upstream changes its licence, copy the new file over it:
  `cp <checkout>/LICENSE site/src/content/gods-eye-view-LICENSE.txt`.
- **Lint.** The build fails on inline `<script>`/`<style>`/`style=`/`on*=` (the CSP would block them), unresolved
  template tags and broken internal links.
- **Env.** `GITHUB_TOKEN` (rate limit), `OPENTAC_ENGINE_STABLE` (e.g. `stable-2026.11.03`, shown on `/changelog`),
  `OPENTAC_SITE_OFFLINE=1` (skip network), `OPENTAC_SITE_FIXTURE=file.json` (`{latest, releases, sums}` in GitHub API
  shape, to preview the populated site offline).
- **Screenshots.** The home page has a placeholder figure and an HTML comment saying where to drop real screenshots
  (take your own; do not copy upstream's README media).

## Cloudflare Pages setup

The site is deployed by `.github/workflows/site.yml` (Direct Upload with `wrangler pages deploy site/dist`), so the
Pages project is **not** connected to Git:

1. Cloudflare dashboard, Workers & Pages, Create, Pages, **Upload assets** (Direct Upload). Name the project
   `opentac` (the workflow's `CF_PROJECT`) and upload any placeholder file; the first workflow run replaces it.
2. Create an API token with the **Cloudflare Pages: Edit** permission (My Profile, API Tokens), and add two
   repository secrets in `gonzoinceng-ctrl/opentac-desktop`: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
   Until they exist the workflow builds the site and skips the deploy.
3. **Rebuilds** happen on `release: published`, every 6 hours, on `workflow_dispatch`, and on the mirror's
   `engine-promoted` dispatch. The workflow sets `GITHUB_TOKEN` and `OPENTAC_ENGINE_STABLE` for the build.

   Equivalent settings if you would rather let Cloudflare build from Git: Framework preset None, build command
   `node site/build.mjs`, output directory `site/dist`, root directory empty, variable `NODE_VERSION=24.22.2`
   (optionally encrypted `GITHUB_TOKEN`); then you need your own rebuild trigger (a Deploy hook).
4. **Custom domains** (Pages project, Custom domains, Set up a custom domain):
   - Add `opentac.icu`. An apex domain on Pages needs the zone to use Cloudflare's nameservers; if the domain is at
     another registrar, change its nameservers to the two Cloudflare gives you first. Cloudflare then creates the
     record itself: `CNAME  opentac.icu  ->  <project>.pages.dev` (proxied; flattened at the apex).
   - Add `www`: `CNAME  www  ->  opentac.icu` (proxied, orange cloud). If you add `www.opentac.icu` as a Pages custom
     domain too it will serve the same site; the canonical tags point at the apex either way.
   - HTTPS is automatic. In SSL/TLS, set mode to **Full (strict)** and turn on **Always Use HTTPS**.
     `_headers` already sends HSTS (`max-age=31536000; includeSubDomains`, no `preload`).
5. **www to apex 301.** Cloudflare Pages' `_redirects` file matches paths only, never hostnames, so this rule cannot
   live in the repo (the generated `_redirects` says so). Create it in the zone instead: Rules, Redirect Rules,
   Create rule, "Wildcard pattern":
   - Request URL: `https://www.opentac.icu/*`
   - Target URL: `https://opentac.icu/${1}`, status **301**, preserve query string.
   The `www` DNS record must be proxied for the rule to see the request.
6. Check: `curl -sI https://opentac.icu/ | grep -iE 'strict-transport|content-security|x-content-type|referrer|permissions'`,
   `curl -sI https://www.opentac.icu/download/` (expect a 301 to the apex), and the browser network panel showing
   requests to `opentac.icu` only.

## Files the build writes into dist/

`robots.txt`, `sitemap.xml` (every page except 404), `_headers` (HSTS, nosniff, referrer policy, minimal
permissions policy, strict CSP: `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self';
connect-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'`), `_redirects`, `site.webmanifest`,
`404.html`, `favicon.ico`.
