# Third-party notices

OpenTac is an **unofficial** desktop app for God's Eye View by Bilawal Sidhu. It is not affiliated
with or endorsed by the upstream author. This file reproduces the licences of the software OpenTac
runs or redistributes. The same text is served on the website at `/licenses` and linked from the
app's About panel.

## God's Eye View (the engine) — MIT, source code only

Copyright (c) 2026 Bilawal Sidhu. https://github.com/bilawalsidhu/gods-eye-view

OpenTac does not bundle or modify this project. It downloads it from GitHub on first run
(through the OpenTac engine mirror, whose refs contain only upstream's own commits) and runs it from a
checkout in your Application Support folder. The complete `LICENSE` file of that repository, including
its note on third-party data and assets, follows **verbatim**. Note in particular that the MIT grant
covers the source code only, and that some bundled datasets and all runtime data feeds carry
non-commercial or share-alike terms; OpenTac is therefore distributed as a non-commercial project.

```text
MIT License

Copyright (c) 2026 Bilawal Sidhu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

NOTE ON THIRD-PARTY DATA AND ASSETS — THE MIT LICENSE ABOVE COVERS THE SOURCE
CODE ONLY.

The datasets bundled under src/data/local_data/, and all data fetched from
third-party providers at runtime, are owned by their respective sources and
are NOT licensed under MIT. They are included/visualized for convenience and
remain subject to their own licenses and terms. Notably:

  - TeleGeography Submarine Cable Map (src/data/local_data/
    telegeography_submarine_cables/): CC BY-NC-SA 3.0 — NonCommercial +
    ShareAlike. NOT for commercial use. If you use this project commercially,
    remove these files or obtain a commercial license from TeleGeography.
  - Datacenters and Dams (OpenStreetMap / Open Infrastructure Map extracts):
    Open Database License (ODbL) 1.0 — attribution + share-alike on the data.
  - NASA FIRMS active-fire snapshot: CC0 / U.S. public domain (citation
    requested).
  - Bhote Koshi event imagery and derived river centerline
    (public/events/bhote-koshi-2026/ and the coordinate dataset in
    src/data/bhoteKoshiFloodPath.js): Vantor / GeoPera, CC BY-NC 4.0.
    NOT for commercial use without separate permission. Source-linked witness
    posts retain their owners' terms; no witness clips are bundled. See the
    folder README for attribution and modification notices. The derived
    coordinates remain third-party data even though they are embedded in a
    JavaScript source file; the MIT grant does not cover that dataset.

Live sources (Google Maps, OpenSky, adsb.lol, AISStream, CelesTrak, USGS,
OSM Overpass, City of Austin, GBFS) are fetched at runtime under each
provider's terms; some (e.g. Google Maps, OpenSky) restrict commercial use
and require you to supply your own credentials.

In short: the MIT grant does not extend to any third-party data. See
DATA_SOURCES.md for the full per-source license + attribution summary, and
remove any dataset whose terms don't fit your use.

The 3D models under public/models/ are also third-party works and are NOT
licensed under MIT. They remain under their individual licenses. See
public/models/README.md for the author, source, license, modification notice,
and attribution covering each model file.
```

## OpenTac (the shell)

OpenTac's own source code is MIT; see the `LICENSE` file at the repository root (also declared in
`package.json`). The OpenTac name and icon belong to
this project; the icon is described under "App icon" below.

## Bundled runtimes and tools

These ship inside `OpenTac.app` (under `Contents/Resources/` and the Electron framework). Their
own licence files are included in the bundle where noted.

### Node.js — MIT (with bundled components)

Node.js 24.x (see `scripts/node-version.json` for the exact version), downloaded from
https://nodejs.org and checksum-verified at build time. Copyright Node.js contributors. Node.js is
released under the MIT licence and bundles components under other licences (V8, OpenSSL, ICU, libuv,
zlib, undici, ada, llhttp and others). The full text, with every bundled component's licence, is
shipped as `Resources/node/LICENSE` inside the app and is the authoritative list.

### npm — Artistic License 2.0

The npm CLI bundled with Node (`Resources/node/lib/node_modules/npm/`), used to install the engine's
dependencies. npm is licensed under the Artistic License 2.0; see
`Resources/node/lib/node_modules/npm/LICENSE` and https://github.com/npm/cli.

### git — GNU General Public License v2

Git is shipped through dugite (dugite-native) as a **separate executable** at
`Resources/app.asar.unpacked/node_modules/dugite/git/`, unmodified, and is invoked only as a
subprocess. OpenTac is not linked against it. Git is licensed under the GNU General Public License,
version 2 (some components under LGPL and other licences). Source code for git is available at
https://github.com/git/git; the dugite-native build is at https://github.com/desktop/dugite-native.
The Git Credential Manager that dugite also ships is excluded from the bundle and never run.

### Electron — MIT

Electron 45.x. Copyright (c) Electron contributors and (c) 2013-2020 GitHub Inc. Licensed under the
MIT licence (https://github.com/electron/electron).

### Chromium — BSD and others

The Chromium engine inside Electron is licensed under a BSD-style licence and includes many third-party
components under their own licences. The complete list, with texts, is Electron's `LICENSES.chromium.html`
(distributed with every Electron build, under `node_modules/electron/dist/` in a source checkout) and the Chromium source tree's
`LICENSE` at https://chromium.googlesource.com/chromium/src/+/main/LICENSE.

### Libraries used by the shell

Verified against the licence files in each package at the pinned versions:

| Package | Version | Licence | Copyright holder |
|---|---|---|---|
| electron | 45.2.1 | MIT | Electron contributors; GitHub Inc. |
| electron-builder | 26.18.0 | MIT | (build tool, not shipped in the app) |
| electron-updater | 6.8.11 | MIT | Loopline Systems |
| electron-log | 5.4.4 | MIT | Alexey Prokhorov |
| dugite | 3.3.2 | MIT | GitHub and contributors |
| semver | 7.8.6 | ISC | Isaac Z. Schlueter and Contributors |
| tree-kill | 1.2.2 | MIT | Peter Krumins |

The complete list of the shell's npm dependencies (including transitive ones that end up inside the
app) with their licence texts is generated at release time (by the release workflow and electron-builder, from the production
dependency tree); it is not maintained by hand here. Each package's own `LICENSE` file is
authoritative.

## Data and live services

OpenTac itself adds no data. The data bundled in God's Eye View and the feeds it reads at runtime
(Google Maps, OpenSky, adsb.lol, AISStream, CelesTrak, USGS, OpenStreetMap Overpass and others) are
covered by the data note in the upstream licence above and by upstream's `DATA_SOURCES.md`. They are not
under the MIT licence.

## App icon

`build/icon-source.svg` is an original OpenTac mark (reticle over a horizon arc). It is
deliberately **not** derived from upstream's `public/logo.svg`, so that OpenTac never presents
God's Eye View's identity as its own (brief 01 §12, 06 §5). `scripts/make-icon.mjs` renders it to
`build/icon.icns`.
