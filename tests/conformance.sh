#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
transport=${SELECTIVE_TRANSPORT:?SELECTIVE_TRANSPORT must name the transport binary}
conformance=${SELECTIVE_TRANSPORT_CONFORMANCE:-$(dirname "$transport")/transport-conformance}
ids=$(mktemp)
trap 'rm -f "$ids"' EXIT
node "$root/packages/vitest/src/cli.js" exec vitest --config "$root/tests/support/conformance.config.js" \
  | node -e '
    const text = require("node:fs").readFileSync(0, "utf8");
    const byName = Object.fromEntries(JSON.parse(text.slice(text.indexOf("{"))).test_cases.map((c) => [c.description, c.id]));
    console.log(JSON.stringify({ pass: byName.passes, fail: byName.fails, pending: byName.pends, flaky: byName.flake, before_all_seconds: 0.5 }));
  ' > "$ids"
cd "$root"
"$conformance" run --client "$root/tests/support/conformance-client.sh" --fixture-ids "$ids" --transport "$transport"
