#!/usr/bin/env bash
# Signature, entitlement, Gatekeeper and notarization-ticket checks for a built OpenTac.app. Exit 1 on any failure.
#
#   scripts/verify-notarized.sh release/mac-arm64/OpenTac.app
#   scripts/verify-notarized.sh release/mac-arm64/OpenTac.app release/OpenTac-0.1.0-arm64.dmg   # also checks the app inside the dmg
#
# electron-builder's notarize step only WARNS when APPLE_* credentials are missing and the build stays green;
# this script is what makes an un-notarized release fail CI (docs/DECISIONS.md, round two).
set -u

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: $0 <OpenTac.app> [<OpenTac.dmg>]" >&2
  exit 64
fi

FAILED=0
fail() { echo "FAIL: $*" >&2; FAILED=1; }
ok() { echo "ok:   $*"; }

check_app() { # <app> <label>
  local app="${1%/}" label="$2" out
  [ -d "$app/Contents" ] || { fail "$label: '$app' is not an app bundle"; return; }

  if out="$(codesign --verify --deep --strict --verbose=2 "$app" 2>&1)"; then
    ok "$label: codesign --verify --deep --strict"
  else
    fail "$label: codesign verification failed:
$out"
  fi

  local node="$app/Contents/Resources/node/bin/node"
  if out="$(codesign -d --entitlements :- "$node" 2>&1)"; then
    for ent in com.apple.security.cs.allow-jit com.apple.security.cs.disable-library-validation; do
      if grep -q "$ent" <<<"$out"; then ok "$label: bundled node has $ent"; else fail "$label: bundled node lacks entitlement $ent"; fi
    done
  else
    fail "$label: cannot read entitlements of bundled node:
$out"
  fi

  if out="$(spctl -a -vv -t install "$app" 2>&1)"; then
    if grep -q 'accepted' <<<"$out" && grep -q 'Notarized Developer ID' <<<"$out"; then
      ok "$label: spctl accepted, source=Notarized Developer ID"
    else
      fail "$label: spctl output lacks 'accepted' and 'Notarized Developer ID':
$out"
    fi
  else
    fail "$label: Gatekeeper (spctl) rejected the app:
$out"
  fi

  if out="$(xcrun stapler validate "$app" 2>&1)"; then
    ok "$label: stapler validate"
  else
    fail "$label: stapler validate failed (no notarization ticket stapled?):
$out"
  fi
}

check_app "$1" "app"

if [ "$#" -eq 2 ]; then
  DMG="$2"
  if [ ! -f "$DMG" ]; then
    fail "dmg not found: $DMG"
  else
    MNT="$(mktemp -d "${TMPDIR:-/tmp}/opentac-dmg.XXXXXX")"
    if hdiutil attach "$DMG" -nobrowse -readonly -noverify -mountpoint "$MNT" >/dev/null 2>&1; then
      trap 'hdiutil detach "$MNT" -force >/dev/null 2>&1; rmdir "$MNT" 2>/dev/null' EXIT
      INNER="$(find "$MNT" -maxdepth 1 -name '*.app' -print -quit)"
      if [ -n "$INNER" ]; then check_app "$INNER" "dmg"; else fail "no .app inside $DMG"; fi
    else
      fail "cannot mount $DMG"
      rmdir "$MNT" 2>/dev/null
    fi
  fi
fi

if [ "$FAILED" -ne 0 ]; then
  echo "verify-notarized: FAILED" >&2
  exit 1
fi
echo "verify-notarized: all checks passed"
