#!/usr/bin/env bash
# Shared shell helpers for the mirror's workflows. SOURCE this file, do not run it:
#   source ci/lib.sh
#
# Conventions:
# - Untrusted values (workflow inputs, upstream tag names, issue text) reach
#   scripts only through environment variables and are always quoted.
# - The mirror is addressed as https://github.com/$GITHUB_REPOSITORY; upstream is
#   ALWAYS the literal URL below, never a configurable input.
# - Nothing here ever passes --force or --tags to git push.

UPSTREAM_URL="https://github.com/bilawalsidhu/gods-eye-view"
ALL_LABELS=(canary hold reject superseded gate-failed tag-drift history-rewrite canary-ok digest selfcheck-failed workflow-trigger)

# engine_init <dir>
# Create an empty repo in <dir> whose `origin` is this mirror. When
# ENGINE_PUSH_TOKEN is set it is attached ONLY to requests for this mirror's URL
# (git url-matched extraheader), so fetches from upstream stay anonymous.
engine_init() {
  local dir=$1
  mkdir -p "$dir"
  git -C "$dir" init --quiet
  git -C "$dir" remote add origin "https://github.com/${GITHUB_REPOSITORY}"
  if [ -n "${ENGINE_PUSH_TOKEN:-}" ]; then
    local b64
    b64=$(printf 'x-access-token:%s' "$ENGINE_PUSH_TOKEN" | base64 | tr -d '\n')
    echo "::add-mask::${b64}"
    git -C "$dir" config "http.https://github.com/${GITHUB_REPOSITORY}/.extraheader" "AUTHORIZATION: basic ${b64}"
  fi
  git -C "$dir" config user.name "opentac-engine-bot"
  git -C "$dir" config user.email "opentac-engine-bot@users.noreply.github.com"
}

# engine_fetch   (run inside the engine dir)
# Full fetch of every engine ref on the mirror: branches (upstream-main,
# candidate, stable, the CI branch), all tags, and the gate notes ref if present.
engine_fetch() {
  git fetch --no-tags --quiet origin '+refs/heads/*:refs/remotes/origin/*'
  git fetch --quiet origin '+refs/tags/*:refs/tags/*'
  if git ls-remote --exit-code --quiet origin refs/notes/gate > /dev/null 2>&1; then
    git fetch --quiet origin '+refs/notes/gate:refs/notes/gate'
  fi
}

# upstream_fetch   (run inside the engine dir)
# Fetch upstream main (no tags) into refs/remotes/upstream/main.
upstream_fetch() {
  git fetch --no-tags --quiet "$UPSTREAM_URL" '+refs/heads/main:refs/remotes/upstream/main'
}

# ensure_labels   (needs GH_REPO and GH_TOKEN). Idempotent.
ensure_labels() {
  local l
  for l in "${ALL_LABELS[@]}"; do
    gh label create "$l" --force --color "ededed" --description "OpenTac engine pipeline" > /dev/null 2>&1 || true
  done
}

# issue_upsert <label> <title> <body-file>
# Comment on the newest open issue carrying <label>, or open a new one.
# Prints the issue number.
issue_upsert() {
  local label=$1 title=$2 bodyfile=$3 num
  ensure_labels
  num=$(gh issue list --state open --label "$label" --limit 1 --json number --jq '.[0].number // empty')
  if [ -n "$num" ]; then
    gh issue comment "$num" --body-file "$bodyfile" > /dev/null
    echo "$num"
  else
    gh issue create --title "$title" --label "$label" --body-file "$bodyfile" | grep -Eo '[0-9]+$'
  fi
}

# push_default_branch <ci-dir> <branch>
# Push the ci checkout's HEAD to the default branch, rebasing on races (3 tries).
push_default_branch() {
  local dir=$1 branch=$2 i
  for i in 1 2 3; do
    if git -C "$dir" push origin "HEAD:refs/heads/${branch}"; then
      return 0
    fi
    echo "push to ${branch} raced (attempt ${i}); rebasing"
    git -C "$dir" fetch --quiet origin "$branch"
    git -C "$dir" rebase "origin/${branch}" || return 1
  done
  return 1
}

# timed <name> <command...>
# Run a command, append "name<TAB>exit<TAB>seconds" to $TIMINGS_FILE, keep its exit code.
timed() {
  local name=$1 rc=0 start=$SECONDS
  shift
  "$@" || rc=$?
  printf '%s\t%s\t%s\n' "$name" "$rc" "$((SECONDS - start))" >> "${TIMINGS_FILE:?TIMINGS_FILE must be set}"
  return "$rc"
}

# require_push_token: fail early with a readable message when the secret is missing.
require_push_token() {
  if [ -z "${ENGINE_PUSH_TOKEN:-}" ]; then
    echo "::error title=Missing secret::ENGINE_PUSH_TOKEN is not set. See README.md (Secrets). Refs and tags cannot be pushed with GITHUB_TOKEN because upstream edits workflow files."
    return 1
  fi
}

# short_sha <sha>
short_sha() {
  printf '%s' "$1" | cut -c1-7
}

# upstream_tag_for <sha>   (inside the engine dir) newest mirrored v* tag pointing at the commit, else "main".
upstream_tag_for() {
  local t
  t=$(git tag --points-at "$1" --list 'v*' | sort -V | tail -n 1)
  printf '%s' "${t:-main}"
}
