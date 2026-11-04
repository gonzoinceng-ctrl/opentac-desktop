#!/usr/bin/env bash
# One-time owner setup for OpenTac: the two things the assistant is not allowed to do on its own.
#   1. GitHub Actions secrets for signing, notarization, the website deploy and the engine mirror.
#   2. DNS for opentac.icu (apex + www) -> the Cloudflare Pages site.
#
# Everything is read from 1Password at run time and piped straight into `gh` / `curl`.
# No value is printed, written to disk or stored anywhere else.
#
# Needs: `op` (signed in to the 1Password desktop app; the Personal vault is required for the Apple
# items, so the service account token is NOT enough), `gh` (logged in as gonzoinceng-ctrl), `curl`.
# Run from anywhere:  bash scripts/owner-setup.sh            (both parts)
#                     bash scripts/owner-setup.sh secrets    (GitHub secrets only)
#                     bash scripts/owner-setup.sh dns        (DNS only)
set -euo pipefail

APP_REPO=gonzoinceng-ctrl/opentac-desktop
MIRROR_REPO=gonzoinceng-ctrl/opentac-engine
MIRROR_ENV=engine-push

# 1Password items (ids are stable; vault names as they appear in the app).
P12_ITEM=opkaf65hlqcj4ttu772km32hmq   # Developer ID Application certificate (.p12) + passphrase, vault Personal
P8_ITEM=ilbxs2fzx5nq5fs3etkpvlbe2i    # App Store Connect API key (.p8), vault Personal (issuer id in its notes)
CF_ITEM=jnjnbuncfeaedytincodokykuu    # Cloudflare API token, vault "General Services"
APPLE_TEAM_ID=QR97D7QRX8
APPLE_API_KEY_ID=XS3L978S8X

CF_ZONE=a3dafd88eeea5651ebbaefb2d0e60c25          # opentac.icu
CF_RECORD_APEX=7957224084ba641681c59a42359f0d96   # CNAME opentac.icu
CF_RECORD_WWW=8093cba9288ef30af121743caf3da30d    # CNAME www.opentac.icu
PAGES_HOST=opentac.pages.dev

part="${1:-all}"
say() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "$1 is not installed"; }
need op; need gh; need curl; need base64

# Returns the name of the first attached file in an item whose name ends with $2.
item_file() {
  op item get "$1" --format json | python3 -I -c '
import json, sys
d = json.load(sys.stdin)
suffix = sys.argv[1]
names = [f["name"] for f in d.get("files", []) if f["name"].endswith(suffix)]
print(names[0] if names else "")' "$2"
}

do_secrets() {
  say "Checking 1Password access (Personal vault)"
  op item get "$P12_ITEM" --format json >/dev/null || die "cannot read the certificate item; sign in to 1Password first"
  local p12name p8name vault
  vault="$(op item get "$P12_ITEM" --format json | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["vault"]["name"])')"
  p12name="$(item_file "$P12_ITEM" .p12)"; [ -n "$p12name" ] || die "no .p12 file attached to the certificate item"
  p8name="$(item_file "$P8_ITEM" .p8)";   [ -n "$p8name" ]  || die "no .p8 file attached to the App Store Connect key item"

  say "GitHub secrets on $APP_REPO (signing + notarization)"
  op read "op://$vault/$P12_ITEM/$p12name" | base64 | gh secret set CSC_LINK --repo "$APP_REPO"
  op read "op://$vault/$P12_ITEM/passphrase" | gh secret set CSC_KEY_PASSWORD --repo "$APP_REPO"
  op read "op://$vault/$P8_ITEM/$p8name" | gh secret set APPLE_API_KEY_P8 --repo "$APP_REPO"
  printf '%s' "$APPLE_API_KEY_ID" | gh secret set APPLE_API_KEY_ID --repo "$APP_REPO"
  printf '%s' "$APPLE_TEAM_ID" | gh secret set APPLE_TEAM_ID --repo "$APP_REPO"
  # The issuer id is a UUID in the key item's notes.
  op item get "$P8_ITEM" --fields notesPlain --reveal \
    | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 \
    | { read -r issuer; [ -n "$issuer" ] || die "no issuer UUID found in the .p8 item's notes"; printf '%s' "$issuer"; } \
    | gh secret set APPLE_API_ISSUER --repo "$APP_REPO"

  say "GitHub secrets on $APP_REPO (website deploy)"
  op item get "$CF_ITEM" --vault "General Services" --fields "Bearer API Key" --reveal | gh secret set CLOUDFLARE_API_TOKEN --repo "$APP_REPO"
  op item get "$CF_ITEM" --vault "General Services" --fields Account_ID --reveal | gh secret set CLOUDFLARE_ACCOUNT_ID --repo "$APP_REPO"

  say "Engine mirror push token ($MIRROR_REPO, environment $MIRROR_ENV)"
  gh auth token | gh secret set ENGINE_PUSH_TOKEN --repo "$MIRROR_REPO" --env "$MIRROR_ENV"

  say "Secrets now set:"
  gh secret list --repo "$APP_REPO"
  gh secret list --repo "$MIRROR_REPO" --env "$MIRROR_ENV"
}

do_dns() {
  say "Repointing opentac.icu and www.opentac.icu to $PAGES_HOST"
  local token
  token="$(op item get "$CF_ITEM" --vault "General Services" --fields "Bearer API Key" --reveal)"
  for pair in "$CF_RECORD_APEX:opentac.icu" "$CF_RECORD_WWW:www.opentac.icu"; do
    id="${pair%%:*}"; name="${pair#*:}"
    curl -sS -X PATCH "https://api.cloudflare.com/client/v4/zones/$CF_ZONE/dns_records/$id" \
      -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
      --data "{\"type\":\"CNAME\",\"name\":\"$name\",\"content\":\"$PAGES_HOST\",\"proxied\":true,\"comment\":\"OpenTac website (Cloudflare Pages)\"}" \
      | python3 -I -c 'import json,sys; r=json.load(sys.stdin); ok=r["success"]; print(("ok   " if ok else "FAIL ")+ (r["result"]["name"]+" -> "+r["result"]["content"] if ok else str(r["errors"])))'
  done
  say "Waiting for the site to answer on the domain (up to 2 minutes)"
  for _ in $(seq 1 24); do
    code="$(curl -s -o /dev/null -w '%{http_code}' https://opentac.icu/ || true)"
    if [ "$code" = "200" ]; then echo "https://opentac.icu answers 200"; return 0; fi
    sleep 5
  done
  echo "opentac.icu is not answering 200 yet (last status $code); DNS can take a few minutes. Re-check with: curl -I https://opentac.icu"
}

case "$part" in
  all) do_secrets; do_dns ;;
  secrets) do_secrets ;;
  dns) do_dns ;;
  *) die "usage: $0 [all|secrets|dns]" ;;
esac
say "Done."
