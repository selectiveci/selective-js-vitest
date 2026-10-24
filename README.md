# selective-js-vitest

Selective client for Vitest. The process you launch is a sidecar: it speaks newline-delimited JSON to `transport --stdio`, and the transport binary owns the websocket.

`packages/core` is the session, the wire protocol, and the transport spawn. PLAN.md calls that package `selective-js-core`. That repository does not exist, and this change does not create it. The core stays a workspace package so it can move out later. `packages/vitest` is the Vitest adapter and the `selective` bin. Jest is out of scope. The napi addon is a later slice, so this sidecar has to run on its own.

## Run

Node 20, 22, or 24 and later. Vitest `^4.1.1` or `^5`. The packed `@selectiveci/core` lists one optional transport package per platform: `@selectiveci/transport-linux-x64`, `-linux-arm64`, `-darwin-x64` and `-darwin-arm64`. npm installs the one that matches, and `selective` runs its `bin/transport`. The Linux binary is statically linked against musl, so it runs on glibc and Alpine images. `SELECTIVE_TRANSPORT` overrides it with any `transport` binary (this slice is pinned to transport commit `44a9c7abde5a35d869c5f71780d56e26c0c6f8bd`). `SELECTIVE_WS_PING_INTERVAL_MS` and `SELECTIVE_WS_PONG_TIMEOUT_MS` are forwarded to that child.

```bash
npm install -D vitest @selectiveci/vitest
npx selective vitest --config vitest.config.js
npx selective exec vitest --config vitest.config.js
```

Nothing is published yet. `scripts/pack.sh <out-dir> <transport-binary> [linux-x64]` packs core, the Vitest adapter and one platform package. The script writes the optional dependencies into the packed core. They are not in `packages/core/package.json`, because npm 11 `npm ci` rejects a lockfile that has no entries for unpublished packages.

`selective vitest` loads the build environment with `transport --build-env` and exits 1 listing any missing `SELECTIVE_*` names. `selective exec vitest` only prints the manifest. It does not need CI variables.

The websocket URL and API key travel in `SELECTIVE_TRANSPORT_URL` on the transport child. They are not process arguments. The client advertises `test_map=record` when it can trace, and `select` when it can't: a browser-mode project, Vitest's V8 coverage, or `NODE_V8_COVERAGE` would share the isolate's coverage counters. `SELECTIVE_TEST_MAP_DISABLE` of `1`, `true`, or `yes` forces `0`. `SELECTIVE_TEST_MAP_RECORD` is forwarded unchanged.

When the server asks it to record, each worker starts V8 precise coverage before collection and takes it around every test. A test's dependencies are the files whose functions ran during it, its per-test suite hooks included. Code that runs only when a module is first imported belongs to no test. Concurrent tests and skipped tests are left out, so the server keeps running them. At close the runner uploads `{version: 1, files, tests}` through `transport --upload-fragment`. Paths are relative to the repository root and leave out `node_modules`, the client itself, and the comma-separated `SELECTIVE_TEST_MAP_IGNORE` directories. The transport tries the upload 3 times, 1 s and then 2 s apart. A failed upload prints a warning and does not change the exit status. If coverage cannot start or be taken in a worker, the tests still run and report normally, the runner prints one warning, and it uploads no fragment.

## What the sidecar does

One `createVitest` stays up for the session. Vitest 4 accepts `standalone: true` only with `watch: true`, so the sidecar sets both and turns the Vite file watcher off. `close()` runs only when the server closes with a null exit status. An integer `close.exit_status` is the process status and skips Vitest teardown.

Discovery takes every id from `collectTests` with `includeTaskLocation`. Vitest 4.1.12 marks a loop-registered test `dynamic: false`, so a static parse cannot see it. Modules are keyed by project name and module id, so a file shared by two projects runs in both. A file that fails to collect is a failed manifest entry, and the shard exits 1.

Each `run_test_cases` batch is one `runTestSpecifications` call, with one specification per module listing that batch's test ids. A batch that names an id twice is split into separate calls. `fileParallelism` is forced off, with `maxWorkers: 1` and `isolate: false`. Selective sets `test.runner` to its own runner and refuses a user `runner` with a one-line error. That runner turns `beforeAll`, `afterAll` and `aroundAll` into per-test hooks, so every test gets its suite hooks as if it ran alone. It also stamps each test's start and end in the worker. `run_time` comes from those stamps, with the batch's startup shared evenly across its tests. `report_at_finish` sends `connection_retries`, `seconds_in_before_all_hooks` and `seconds_in_after_all_hooks`.

Results are forwarded only for assigned ids. A later skip does not replace a pass. An error outside a test, such as a throwing hook or an unhandled rejection, fails the named test, or else every assigned test in its file, prints `selective: error outside a test in <files>: <message> (fails <tests>)`, and makes the shard exit 1. Each result prints one progress line, `✓|×|↓ <file> > <name> <ms>ms`. Failure text has ANSI codes stripped.

The user's reporters stay out of the batch runs. At session close they receive one `onTestRunEnd`, with Vitest's own module and task objects holding the last attempt of each assigned test. A reporter that throws ends the session with exit 1. Coverage accumulates across batches (`cleanOnRerun: false`, `reportOnFailure: true`). `exec` turns coverage off, forces `silent`, and sends Vitest's output to stderr, so its stdout is only the manifest JSON. `--log` writes `log/<runner_id>.log`.

Lost connections cancel the current Vitest run, then retry with `reconnect=true` and sleep `min(attempt, 4)` seconds. The eleventh failure exits 1. A missing transport exits 1 immediately and names the platform package to install.

## Tests

```bash
SELECTIVE_TRANSPORT=/path/to/transport npm test
```

Protocol tests drive a fake adapter through the real `transport --stdio` binary and a local websocket. Vitest tests use `fixtures/vitest-sample` and `fixtures/vitest-review`. `tests/conformance.sh` runs the transport's `transport-conformance run --client` suite against the Vitest client; it finds `transport-conformance` next to `SELECTIVE_TRANSPORT` unless `SELECTIVE_TRANSPORT_CONFORMANCE` names it. Its fixture, `tests/support/conformance-fixture`, gives the passing test's group a 0.5 s `beforeAll` and declares `before_all_seconds: 0.5`, so `group_hook_time` checks the reported hook seconds. The recording e2e test checks per-test attribution in both batch orders, and the conformance run covers fragment upload and a stall mid-upload.
