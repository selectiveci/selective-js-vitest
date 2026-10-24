#!/usr/bin/env bash
set -euo pipefail
out=$(mkdir -p "$1" && cd "$1" && pwd)
binary=$2
target=${3:-linux-x64}
root=$(cd "$(dirname "$0")/.." && pwd)
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/transport/bin" "$stage/core"
install -m 0755 "$binary" "$stage/transport/bin/transport"
cp -r "$root/packages/core/package.json" "$root/packages/core/src" "$stage/core/"
node -e '
  const fs = require("node:fs");
  const [stage, target] = process.argv.slice(1);
  const corePath = `${stage}/core/package.json`;
  const core = JSON.parse(fs.readFileSync(corePath, "utf8"));
  const targets = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];
  core.optionalDependencies = Object.fromEntries(targets.map((t) => [`@selectiveci/transport-${t}`, core.version]));
  fs.writeFileSync(corePath, JSON.stringify(core, null, 2) + "\n");
  const [os, cpu] = target.split("-");
  const manifest = { name: `@selectiveci/transport-${target}`, version: core.version, os: [os], cpu: [cpu], files: ["bin"] };
  fs.writeFileSync(`${stage}/transport/package.json`, JSON.stringify(manifest, null, 2) + "\n");
' "$stage" "$target"
(cd "$stage/transport" && npm pack --pack-destination "$out" > /dev/null)
(cd "$stage/core" && npm pack --pack-destination "$out" > /dev/null)
(cd "$root" && npm pack -w packages/vitest --pack-destination "$out" > /dev/null)
ls "$out"
