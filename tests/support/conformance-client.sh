#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
export SELECTIVE_PLATFORM=github_actions SELECTIVE_BRANCH=main SELECTIVE_SHA=abc123
export SELECTIVE_GIT_REPO=selectiveci/selective-js-vitest SELECTIVE_GIT_PROVIDER=github
SELECTIVE_FLAKE_FILE="$(mktemp -u)"
export SELECTIVE_FLAKE_FILE
cd "$root"
exec node packages/vitest/src/cli.js vitest --config tests/support/conformance.config.js "$@"
