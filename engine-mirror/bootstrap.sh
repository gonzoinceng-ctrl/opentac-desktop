#!/usr/bin/env bash
# bootstrap.sh - create and seed the OpenTac engine mirror on GitHub.
#
# The mirror is a PLAIN PUBLIC REPOSITORY (not a fork) named opentac-engine.
# This directory becomes its DEFAULT branch, the orphan branch `opentac-ci`
# (DECISIONS: GitHub only runs schedule and the "Run workflow" button from the
# default branch). Engine refs are ordinary non-default refs pushed separately:
#   upstream-main   exact copy of bilawalsidhu/gods-eye-view main
#   v*              upstream's tags, pushed by name (never --tags, never --force)
#   stable, candidate  both seeded at the newest v* tag, or at --seed <sha>
# No branch named `main` is ever pushed, so upstream's ci.yml cannot fire here.
#
# THIS SCRIPT IS NOT RUN BY ANYTHING. The owner runs it once, when ready.
#
# Usage:
#   OWNER=gonzoinceng-ctrl APP_REPO=opentac-desktop ./bootstrap.sh [--seed <upstream-sha>] [--dry-run]
#
# Environment:
#   OWNER      GitHub user or org that will own the mirror   (default: gonzoinceng-ctrl)
#   APP_REPO   name of the app repository under OWNER        (default: opentac-desktop)
#   ENGINE_REPO name of the mirror repository                (default: opentac-engine)
#
# Requirements: git, gh (logged in with the `repo` and `workflow` scopes), node, rsync.
#
# Idempotent: every step checks before it acts. Re-running
#   - leaves an existing repo, labels and ruleset alone,
#   - fast-forwards upstream-main and pushes only NEW tags,
#   - never moves an existing stable or candidate,
#   - refreshes the opentac-ci branch files but KEEPS manifest/tags.json and RELEASES.md
#     (state that CI itself writes).
# Nothing here ever uses --force.
#
# The OWNER placeholder: files in this directory say OWNER/opentac-desktop and
# OWNER/opentac-engine. A temporary copy is rewritten with sed before the push;
# the files on disk here are never modified. bootstrap.sh itself is not pushed.

set -euo pipefail

OWNER="${OWNER:-gonzoinceng-ctrl}"
APP_REPO="${APP_REPO:-opentac-desktop}"
ENGINE_REPO="${ENGINE_REPO:-opentac-engine}"
UPSTREAM_URL="https://github.com/bilawalsidhu/gods-eye-view"
CI_BRANCH="opentac-ci"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SLUG="${OWNER}/${ENGINE_REPO}"

SEED=""
DRY_RUN=false
while [ $# -gt 0 ]; do
  case "$1" in
    --seed)
      SEED="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h | --help)
      sed -n '2,40p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "unknown argument: $1 (try --help)" >&2
      exit 64
      ;;
  esac
done

say() { printf '\n== %s\n' "$*"; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

# run <command...>: a MUTATING command. Printed and skipped under --dry-run.
run() {
  if [ "$DRY_RUN" = true ]; then
    printf '[dry-run] %q' "$1"
    shift
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

[[ "$OWNER" =~ ^[A-Za-z0-9-]+$ ]] || die "OWNER has unexpected characters"
[[ "$APP_REPO" =~ ^[A-Za-z0-9._-]+$ ]] || die "APP_REPO has unexpected characters"
[[ "$ENGINE_REPO" =~ ^[A-Za-z0-9._-]+$ ]] || die "ENGINE_REPO has unexpected characters"
[ -z "$SEED" ] || [[ "$SEED" =~ ^[0-9a-f]{7,40}$ ]] || die "--seed must be a hex commit id"

for tool in git gh node rsync; do
  command -v "$tool" > /dev/null || die "$tool is required but not installed"
done
gh auth status > /dev/null 2>&1 || die "gh is not logged in: run 'gh auth login'"
if ! gh auth status 2>&1 | grep -qi "workflow"; then
  echo "warning: your gh token may lack the 'workflow' scope. Pushing upstream history (it contains .github/workflows files) would then be rejected." >&2
  echo "         If a push fails, run: gh auth refresh -s workflow" >&2
fi

# Let git use gh's credentials for github.com without touching any global config.
export GIT_CONFIG_COUNT=2
export GIT_CONFIG_KEY_0="credential.https://github.com.helper"
export GIT_CONFIG_VALUE_0=""
export GIT_CONFIG_KEY_1="credential.https://github.com.helper"
export GIT_CONFIG_VALUE_1="!gh auth git-credential"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/opentac-bootstrap.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

echo "mirror:   ${SLUG}"
echo "app repo: ${OWNER}/${APP_REPO}"
echo "upstream: ${UPSTREAM_URL}"
echo "workdir:  ${WORK}"
[ "$DRY_RUN" = false ] || echo "DRY RUN: nothing will be created or pushed"

# --------------------------------------------------------------------------
say "1/8 Create ${SLUG} (public) if it does not exist"
if gh repo view "$SLUG" > /dev/null 2>&1; then
  echo "exists"
else
  run gh repo create "$SLUG" --public \
    --description 'Tested mirror of bilawalsidhu/gods-eye-view for OpenTac (no engine commits of its own)'
fi

# --------------------------------------------------------------------------
say "2/8 Push this directory as the orphan default branch ${CI_BRANCH}"
STAGE="${WORK}/ci-stage"
mkdir -p "$STAGE"
rsync -a --exclude='.git' --exclude='node_modules' --exclude='bootstrap.sh' "${HERE}/" "${STAGE}/"
# Substitute the OWNER placeholder in a COPY only. App repo first (it has its own name), then the rest.
find "$STAGE" -type f \( -name '*.md' -o -name '*.yml' -o -name '*.yaml' -o -name '*.mjs' -o -name '*.json' -o -name '*.sh' \) \
  -exec sed -i.bak -e "s#OWNER/opentac-desktop#${OWNER}/${APP_REPO}#g" -e "s#OWNER/opentac-engine#${SLUG}#g" -e "s#OWNER/#${OWNER}/#g" {} \;
find "$STAGE" -name '*.bak' -delete
if grep -rn "OWNER/" "$STAGE" > /dev/null 2>&1; then
  grep -rn "OWNER/" "$STAGE" | head >&2
  die "placeholder OWNER/ still present after substitution"
fi

CI_REPO="${WORK}/ci-repo"
if git ls-remote --exit-code --heads "https://github.com/${SLUG}" "$CI_BRANCH" > /dev/null 2>&1; then
  echo "${CI_BRANCH} exists: refreshing files, keeping manifest/tags.json and RELEASES.md"
  git clone --quiet --branch "$CI_BRANCH" --single-branch "https://github.com/${SLUG}" "$CI_REPO"
  rsync -a --delete --exclude='.git' --exclude='manifest/tags.json' --exclude='RELEASES.md' "${STAGE}/" "${CI_REPO}/"
else
  mkdir -p "$CI_REPO"
  git -C "$CI_REPO" init --quiet
  git -C "$CI_REPO" checkout --quiet --orphan "$CI_BRANCH"
  rsync -a "${STAGE}/" "${CI_REPO}/"
  git -C "$CI_REPO" remote add origin "https://github.com/${SLUG}"
fi
git -C "$CI_REPO" config user.name "${GIT_AUTHOR_NAME:-$(git config user.name || echo 'OpenTac bootstrap')}"
git -C "$CI_REPO" config user.email "${GIT_AUTHOR_EMAIL:-$(git config user.email || echo 'bootstrap@users.noreply.github.com')}"
git -C "$CI_REPO" add -A
if git -C "$CI_REPO" diff --cached --quiet; then
  echo "${CI_BRANCH} already up to date"
else
  git -C "$CI_REPO" commit --quiet -m "OpenTac engine mirror CI ($(date -u +%F))"
  # Fast-forward only: a plain push, no --force.
  run git -C "$CI_REPO" push origin "HEAD:refs/heads/${CI_BRANCH}"
fi

# --------------------------------------------------------------------------
say "3/8 Make ${CI_BRANCH} the default branch"
run gh api --silent -X PATCH "repos/${SLUG}" -f "default_branch=${CI_BRANCH}"

# --------------------------------------------------------------------------
say "4/8 Mirror upstream main as upstream-main, and upstream v* tags by name"
ENG="${WORK}/engine.git"
git init --quiet --bare "$ENG"
git -C "$ENG" fetch --quiet --no-tags "$UPSTREAM_URL" '+refs/heads/main:refs/heads/upstream-main'
git -C "$ENG" remote add origin "https://github.com/${SLUG}"
TAGS=()
while read -r tag; do
  [ -n "$tag" ] || continue
  TAGS+=("$tag")
done < <(git ls-remote --tags --refs "$UPSTREAM_URL" 'refs/tags/v[0-9]*' | sed 's#.*refs/tags/##')
for tag in "${TAGS[@]}"; do
  git -C "$ENG" fetch --quiet --no-tags "$UPSTREAM_URL" "+refs/tags/${tag}:refs/tags/${tag}"
done
echo "upstream-main at $(git -C "$ENG" rev-parse --short upstream-main), ${#TAGS[@]} v* tag(s): ${TAGS[*]}"
# upstream-main: a plain push can only fast-forward.
run git -C "$ENG" push origin 'refs/heads/upstream-main:refs/heads/upstream-main'
for tag in "${TAGS[@]}"; do
  remote_sha="$(git ls-remote "https://github.com/${SLUG}" "refs/tags/${tag}" | cut -f1)"
  tag_sha="$(git -C "$ENG" rev-parse "refs/tags/${tag}")"
  if [ -z "$remote_sha" ]; then
    run git -C "$ENG" push origin "refs/tags/${tag}:refs/tags/${tag}"
  elif [ "$remote_sha" != "$tag_sha" ]; then
    die "tag ${tag} already exists on the mirror at ${remote_sha}, upstream has ${tag_sha}. Not touching it."
  fi
done

# --------------------------------------------------------------------------
say "5/8 Seed stable and candidate (only if absent)"
if [ -n "$SEED" ]; then
  SEED_SHA="$(git -C "$ENG" rev-parse --verify --quiet "${SEED}^{commit}")" || die "--seed ${SEED} is not a commit of upstream"
else
  NEWEST="$(printf '%s\n' "${TAGS[@]}" | node "${HERE}/ci/canary.mjs" newest-tag)" || die "no v<semver> upstream tag found; pass --seed <sha>"
  SEED_SHA="$(git -C "$ENG" rev-parse "refs/tags/${NEWEST}^{commit}")"
  echo "newest upstream tag: ${NEWEST}"
fi
git -C "$ENG" merge-base --is-ancestor "$SEED_SHA" upstream-main || die "seed ${SEED_SHA} is not in upstream main's history (zero engine commits rule)"
for branch in stable candidate; do
  if git ls-remote --exit-code --heads "https://github.com/${SLUG}" "$branch" > /dev/null 2>&1; then
    echo "${branch}: exists, leaving it where it is"
  else
    echo "${branch}: creating at ${SEED_SHA}"
    run git -C "$ENG" push origin "${SEED_SHA}:refs/heads/${branch}"
  fi
done

# --------------------------------------------------------------------------
say "6/8 Labels"
while IFS='|' read -r name color description; do
  run gh label create "$name" --repo "$SLUG" --force --color "$color" --description "$description" < /dev/null
done << 'LABELS'
canary|0e8a16|The open canary for the current candidate
hold|fbca04|Stop automatic promotion of this canary
reject|b60205|Do not promote this canary
superseded|cccccc|Replaced by a newer candidate
gate-failed|d93f0b|The gate failed for a candidate
tag-drift|d93f0b|Upstream deleted or moved a tag we mirrored
history-rewrite|b60205|Upstream main is not a descendant of upstream-main
canary-ok|0e8a16|Owner confirms the canary build was used on their Mac
digest|1d76db|Weekly intake digest
selfcheck-failed|b60205|The zero-engine-commits invariant failed
LABELS

# --------------------------------------------------------------------------
say "7/8 Tag ruleset: no update or delete of v* and stable-* tags (best effort)"
RULESET_NAME="opentac-immutable-tags"
RULESET_JSON='{
  "name": "'"${RULESET_NAME}"'",
  "target": "tag",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/tags/v*", "refs/tags/stable-*"], "exclude": [] } },
  "rules": [ { "type": "update" }, { "type": "deletion" } ]
}'
manual_ruleset() {
  cat << EOF
Could not create the ruleset through the API. Create it by hand:
  https://github.com/${SLUG}/settings/rules/new?target=tag
    Name:               ${RULESET_NAME}
    Enforcement status: Active
    Target tags:        v*   and   stable-*     (Add target > Include by pattern)
    Rules:              Restrict updates, Restrict deletions
    Bypass list:        (empty; new tags can still be created)
EOF
}
if existing="$(gh api "repos/${SLUG}/rulesets" --jq ".[] | select(.name == \"${RULESET_NAME}\") | .id" 2> /dev/null)" && [ -n "$existing" ]; then
  echo "ruleset already exists (id ${existing})"
elif [ "$DRY_RUN" = true ]; then
  echo "[dry-run] would POST the ruleset ${RULESET_NAME}"
elif ! printf '%s' "$RULESET_JSON" | gh api -X POST "repos/${SLUG}/rulesets" --input - > /dev/null 2>&1; then
  manual_ruleset
else
  echo "ruleset created"
fi

# --------------------------------------------------------------------------
say "8/8 Secret and optional variables (not set by this script)"
cat << EOF
Add the secret the workflows need. It must be a fine-grained personal access token
(or a GitHub App installation token) with:
  - ${SLUG}:            Contents (write), Workflows (write), Issues (write)
  - ${OWNER}/${APP_REPO}: Contents (write)   (for the engine-promoted repository_dispatch)

  gh secret set ENGINE_PUSH_TOKEN --repo ${SLUG}

Optional repository variables (Settings > Secrets and variables > Actions > Variables):
  INTAKE_POLICY      main (default) or tags
  MIN_SHELL          fallback minShell for the first promotion, e.g. 1.0.0
  CANARY_OK_FIRST_N  number of first promotions that need the canary-ok label (default 3, 0 disables)

Then smoke-test the pipeline from the Actions tab (all run from ${CI_BRANCH}):
  1. watch     (should be silent and green)
  2. intake    with policy=main
  3. promote   (it will wait for the 72 h canary; use force=true only for a hotfix)
EOF
echo
echo "done."
