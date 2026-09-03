#!/usr/bin/env bash
#
# Prove a stranger can clone this repo and build it.
#
# WHAT THIS ACTUALLY CHECKS
#   Not "does the README read well". It clones into a temporary directory with
#   every private-registry credential removed from the environment, installs
#   against the lockfile and runs the production build. If the @sprqvntrs/*
#   packages ever move back behind a token, this fails here rather than in a
#   stranger's terminal.
#
#   The clone is a fresh one on purpose. A build in the working tree would pass
#   using node_modules that were installed WITH a token, which proves nothing.
#
# THE CREDENTIAL SCRUB
#   Three things can quietly supply a token: GITHUB_PACKAGES_TOKEN and friends
#   in the environment, an `npm_config_*` variable, and a scope mapping in the
#   user's ~/.npmrc. The first two are unset below. The third is handled by
#   pointing npm at an empty userconfig for the duration.
#
# Usage: scripts/verify-public-clone.sh [git-url]
#   Defaults to the HTTPS URL, which is what a stranger uses. Pass the SSH URL
#   to run this against the repo while it is still private.
set -euo pipefail

REPO_URL="${1:-${VERIFY_CLONE_URL:-https://github.com/SPRQVNTRS/translate-altan-fyi.git}}"

# TS commands need the ts-dev toolbox (the host lacks native build tools), but
# must run bare when this script is already executing inside a container. Same
# detection as .githooks/pre-push.
if [ -f /run/.containerenv ] || [ -f /.dockerenv ]; then
  run() { CI=true "$@"; }
elif command -v toolbox >/dev/null 2>&1; then
  run() { toolbox run -c ts-dev env CI=true "$@"; }
else
  echo "✖ verify-public-clone: no ts-dev toolbox and not inside a container."
  exit 1
fi

# Under $HOME on purpose: a toolbox container shares the home directory, not
# /tmp, so a clone in /tmp would be invisible to the `toolbox run` below.
mkdir -p "$HOME/.cache"
WORKDIR="$(mktemp -d "$HOME/.cache/translate-public-clone-XXXXXX")"
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

echo "▶ cloning $REPO_URL into $WORKDIR"
git clone --depth 1 "$REPO_URL" "$WORKDIR/repo"

# An empty userconfig, so a ~/.npmrc scope mapping cannot supply the registry
# or the token that a stranger would not have.
: > "$WORKDIR/empty-npmrc"

cd "$WORKDIR/repo"

# The install and the build run through the same toolbox wrapper the gate uses.
# NPM_CONFIG_USERCONFIG is threaded explicitly because toolbox does not inherit
# the calling shell's environment.
( cd "$WORKDIR/repo" && run env \
    NPM_CONFIG_USERCONFIG="$WORKDIR/empty-npmrc" \
    GITHUB_PACKAGES_TOKEN= GITHUB_TOKEN= NPM_TOKEN= NODE_AUTH_TOKEN= \
    pnpm install --frozen-lockfile )

echo "▶ production build"
( cd "$WORKDIR/repo" && run env NPM_CONFIG_USERCONFIG="$WORKDIR/empty-npmrc" pnpm build )

echo "✅ verify-public-clone: a tokenless clone installs and builds"
