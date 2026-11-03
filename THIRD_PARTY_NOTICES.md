# Third-party notices

## God's Eye View — MIT

Copyright (c) Bilawal Sidhu. https://github.com/bilawalsidhu/gods-eye-view

<!-- Paste the full LICENSE text from the upstream repository here verbatim at build time (Phase 6). -->

## Bundled runtimes and tools

- Electron (MIT), Chromium (BSD and others), Node.js (MIT and others — see
  the LICENSE file shipped in `Resources/node/`).
- git, via dugite (GPLv2). Shipped as a separate executable; source at
  https://github.com/git/git.
- All shell npm dependencies: generated list to be appended by the release
  build.

## App icon

`build/icon-source.svg` is upstream's `public/logo.svg` (God's Eye View, MIT,
© Bilawal Sidhu), reproduced unmodified. `scripts/make-icon.mjs` composites it
onto a dark rounded tile to produce `build/icon.icns`. The OpenTac website uses
its own distinct mark, not this logo.
