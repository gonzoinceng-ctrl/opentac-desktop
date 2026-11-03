#!/usr/bin/env bash
# Structural check of a packaged OpenTac.app (unsigned or signed). Fails on ANY problem.
#
#   scripts/verify-bundle.sh release/mac-arm64/OpenTac.app arm64
#   scripts/verify-bundle.sh release/mac/OpenTac.app x64
#
# Guards the packaging pitfalls recorded in docs/DECISIONS.md:
#   - bundled Node must be the right Mach-O arch (dugite/node are fetched per arch);
#   - npm must survive electron-builder's node_modules filter (npm-cli.js + bin/npm symlink);
#   - dugite's git must be the app's arch (its postinstall fetches one arch only) and must run;
#   - Git Credential Manager (.NET, ~70 MB) must be excluded; minimum macOS must be 13.5.
# Also fails if the app's release/ directory holds a dmg/zip of the OTHER architecture (a cross-arch build slipped
# in; arm64 artifacts are named *arm64*, x64 ones are not). Set VERIFY_ALLOW_MULTI_ARCH=1 for a deliberate two-arch
# local `npm run dist`.
# Set VERIFY_SKIP_EXEC=1 to skip the "run it" checks (e.g. verifying x64 on an arm64 Mac without Rosetta).
set -u

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <OpenTac.app> <arm64|x64>" >&2
  exit 64
fi

APP="${1%/}"
ARCH_ARG="$2"
case "$ARCH_ARG" in
  arm64) WANT="arm64"; OTHER="x86_64" ;;
  x64 | x86_64) WANT="x86_64"; OTHER="arm64" ;;
  *) echo "unknown arch '$ARCH_ARG' (expected arm64 or x64)" >&2; exit 64 ;;
esac

RES="$APP/Contents/Resources"
FAILED=0
fail() { echo "FAIL: $*" >&2; FAILED=1; }
ok() { echo "ok:   $*"; }

[ -d "$APP/Contents" ] || { echo "FAIL: '$APP' is not an app bundle" >&2; exit 1; }

check_macho() { # <path> <label>
  local out
  if [ ! -e "$1" ]; then fail "$2 missing: $1"; return 1; fi
  out="$(file -L "$1")"
  if [[ "$out" != *"Mach-O"* ]]; then fail "$2 is not a Mach-O file: $out"; return 1; fi
  if [[ "$out" != *"$WANT"* ]]; then fail "$2 is not $WANT: $out"; return 1; fi
  if [[ "$out" == *"$OTHER"* ]]; then fail "$2 contains $OTHER (universal or wrong arch): $out"; return 1; fi
  ok "$2 is a Mach-O $WANT binary"
}

# 1. Bundled Node
NODE="$RES/node/bin/node"
check_macho "$NODE" "Resources/node/bin/node"
[ -x "$NODE" ] || fail "Resources/node/bin/node is not executable"

# 2. npm survived packaging
NPM_CLI="$RES/node/lib/node_modules/npm/bin/npm-cli.js"
if [ -f "$NPM_CLI" ]; then
  ok "npm-cli.js present"
  if [ "${VERIFY_SKIP_EXEC:-0}" = "1" ]; then
    echo "skip: npm --version (VERIFY_SKIP_EXEC=1)"
  elif NPM_V="$("$NODE" "$NPM_CLI" --version 2>&1)"; then
    ok "bundled node runs npm-cli.js --version ($NPM_V)"
  else
    fail "bundled node cannot run npm-cli.js --version: $NPM_V"
  fi
else
  fail "npm-cli.js missing: $NPM_CLI (extraResources filter dropped npm?)"
fi
for tool in npm npx; do
  if [ -L "$RES/node/bin/$tool" ] && [ -e "$RES/node/bin/$tool" ]; then
    ok "Resources/node/bin/$tool symlink resolves"
  else
    fail "Resources/node/bin/$tool is not a working symlink"
  fi
done

# 3. Launcher
if [ -f "$RES/launcher/opentac-start.mjs" ]; then ok "launcher/opentac-start.mjs present"; else fail "Resources/launcher/opentac-start.mjs missing"; fi

# 4. dugite's git
GIT="$RES/app.asar.unpacked/node_modules/dugite/git/bin/git"
if check_macho "$GIT" "unpacked dugite git"; then
  if [ "${VERIFY_SKIP_EXEC:-0}" = "1" ]; then
    echo "skip: git --version (VERIFY_SKIP_EXEC=1)"
  elif GIT_V="$("$GIT" --version 2>&1)"; then
    ok "dugite git runs ($GIT_V)"
  else
    fail "dugite git --version failed: $GIT_V"
  fi
fi

# 5. Minimum macOS
PLIST="$APP/Contents/Info.plist"
if MIN="$(plutil -extract LSMinimumSystemVersion raw -o - "$PLIST" 2>&1)"; then
  if [ "$MIN" = "13.5" ]; then ok "LSMinimumSystemVersion is 13.5"; else fail "LSMinimumSystemVersion is '$MIN', expected 13.5"; fi
else
  fail "cannot read LSMinimumSystemVersion from Info.plist: $MIN"
fi

# 6. Git Credential Manager must not ship (anywhere in the bundle)
GCM="$(find "$APP" -iname 'git-credential-manager*' 2>/dev/null | head -5)"
if [ -n "$GCM" ]; then fail "git-credential-manager* present in bundle:
$GCM"; else ok "no git-credential-manager* in bundle"; fi

# 7. No other-architecture installers next to this app (release/<dir>/OpenTac.app -> release/)
REL="$(cd "$APP/../.." 2>/dev/null && pwd)"
if [ "${VERIFY_ALLOW_MULTI_ARCH:-0}" != "1" ] && [ -n "$REL" ]; then
  STRAY=""
  for f in "$REL"/*.dmg "$REL"/*.zip; do
    [ -e "$f" ] || continue
    case "$WANT:$(basename "$f")" in
      arm64:*arm64*) ;;
      arm64:*) STRAY="$STRAY $f" ;;
      x86_64:*arm64*) STRAY="$STRAY $f" ;;
    esac
  done
  if [ -n "$STRAY" ]; then fail "other-architecture artifact(s) in $REL:$STRAY"; else ok "no other-architecture dmg/zip in $REL"; fi
fi

if [ "$FAILED" -ne 0 ]; then
  echo "verify-bundle: FAILED for $APP ($ARCH_ARG)" >&2
  exit 1
fi
echo "verify-bundle: all checks passed for $APP ($ARCH_ARG)"
