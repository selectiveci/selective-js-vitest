import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  correlateTestFiles,
  diffTestFiles,
  encodeFrame,
  isTestPath,
  loadEnvironment,
  missingSelectiveNames,
  retryDelay,
  retriesExhausted,
  interpretSnapshot,
  snapshotFailure,
  snapshotTree,
  stdioLaunch,
  transportPackage,
  buildFragment,
  TERMINATION_GRACE_MS,
} from "@selectiveci/core";
import { createVitestAdapter, vitestVersionAllowed } from "@selectiveci/vitest";
import { repoRoot, transportBin } from "./support/harness.js";
import { openStdio } from "../packages/core/src/transport.js";

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function probe(env, cwd) {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { loadEnvironment, missingSelectiveNames } from "@selectiveci/core";
const env = loadEnvironment(process.env.PROBE_CWD);
console.log(JSON.stringify({ missing: missingSelectiveNames(env), runner: env.runner_id, commit: env.commit_message }));`,
    ],
    {
      cwd: repoRoot,
      env: { ...env, PROBE_CWD: cwd },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function bareEnv(extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: "C.UTF-8",
    SELECTIVE_TRANSPORT: transportBin(),
    ...extra,
  };
}

test("retry timing matches the transport client", () => {
  assert.equal(retryDelay(1), 1000);
  assert.equal(retryDelay(4), 4000);
  assert.equal(retryDelay(9), 4000);
  assert.equal(retriesExhausted(10), false);
  assert.equal(retriesExhausted(11), true);
  assert.equal(TERMINATION_GRACE_MS, 250);
});

test("the packed core lists each platform's transport package as an optional dependency", () => {
  const out = mkdtempSync(path.join(tmpdir(), "sel-pack-"));
  try {
    const packed = spawnSync("bash", [path.join(repoRoot, "scripts/pack.sh"), out, transportBin()], { encoding: "utf8" });
    assert.equal(packed.status, 0, packed.stderr);
    const { version } = JSON.parse(readFileSync(path.join(repoRoot, "packages/core/package.json"), "utf8"));
    const manifest = (name) =>
      JSON.parse(spawnSync("tar", ["-xOzf", path.join(out, `${name}-${version}.tgz`), "package/package.json"], { encoding: "utf8" }).stdout);
    const targets = [["linux", "x64"], ["linux", "arm64"], ["darwin", "x64"], ["darwin", "arm64"]];
    assert.deepEqual(
      manifest("selectiveci-core").optionalDependencies,
      Object.fromEntries(targets.map(([platform, arch]) => [transportPackage(platform, arch), version])),
    );
    const platform = manifest("selectiveci-transport-linux-x64");
    assert.deepEqual([platform.name, platform.os, platform.cpu], [transportPackage("linux", "x64"), ["linux"], ["x64"]]);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("a fragment keeps repo files outside node_modules and SELECTIVE_TEST_MAP_IGNORE", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "sel-fragment-"));
  const outside = mkdtempSync(path.join(tmpdir(), "sel-outside-"));
  const previous = process.env.SELECTIVE_TEST_MAP_IGNORE;
  try {
    git(repo, ["init", "-q"]);
    for (const dir of ["src", "gen", "node_modules/dep"]) mkdirSync(path.join(repo, dir), { recursive: true });
    const file = (name) => {
      writeFileSync(name, "");
      return name;
    };
    const own = file(path.join(repo, "src/a.js"));
    const deps = [own, file(path.join(repo, "gen/b.js")), file(path.join(repo, "node_modules/dep/i.js")), file(path.join(outside, "c.js")), path.join(repo, "src/gone.js")];
    process.env.SELECTIVE_TEST_MAP_IGNORE = " ../gen ,";
    assert.deepEqual(buildFragment(new Map([["t1", new Set(deps)], ["t2", new Set([own])]]), path.join(repo, "src")), {
      version: 1,
      files: ["src/a.js"],
      tests: [
        { id: "t1", deps: [0] },
        { id: "t2", deps: [0] },
      ],
    });
  } finally {
    if (previous === undefined) delete process.env.SELECTIVE_TEST_MAP_IGNORE;
    else process.env.SELECTIVE_TEST_MAP_IGNORE = previous;
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("stdio launch puts the url in the environment only", () => {
  const launch = stdioLaunch("ws://127.0.0.1:9/transport/websocket?api_key=secret");
  assert.deepEqual(launch.args, ["--stdio"]);
  assert.equal(launch.env.SELECTIVE_TRANSPORT_URL, "ws://127.0.0.1:9/transport/websocket?api_key=secret");
  assert.equal(launch.args.join(" ").includes("ws://"), false);
  assert.equal(launch.args.join(" ").includes("secret"), false);
});

test("stdio launch forwards websocket keepalive when it is set", () => {
  const previousPing = process.env.SELECTIVE_WS_PING_INTERVAL_MS;
  const previousPong = process.env.SELECTIVE_WS_PONG_TIMEOUT_MS;
  process.env.SELECTIVE_WS_PING_INTERVAL_MS = "200";
  process.env.SELECTIVE_WS_PONG_TIMEOUT_MS = "1000";
  try {
    const launch = stdioLaunch("ws://127.0.0.1:9/transport/websocket?api_key=secret");
    assert.equal(launch.env.SELECTIVE_WS_PING_INTERVAL_MS, "200");
    assert.equal(launch.env.SELECTIVE_WS_PONG_TIMEOUT_MS, "1000");
    assert.deepEqual(launch.args, ["--stdio"]);
  } finally {
    if (previousPing == null) delete process.env.SELECTIVE_WS_PING_INTERVAL_MS;
    else process.env.SELECTIVE_WS_PING_INTERVAL_MS = previousPing;
    if (previousPong == null) delete process.env.SELECTIVE_WS_PONG_TIMEOUT_MS;
    else process.env.SELECTIVE_WS_PONG_TIMEOUT_MS = previousPong;
  }
});

test("frames write integer seconds as float literals", () => {
  assert.equal(
    encodeFrame({
      type: "test_case_result",
      data: { run_time: 0, line_number: 3, failure_message_lines: ['{"run_time":0}'] },
    }),
    '{"type":"test_case_result","data":{"run_time":0.0,"line_number":3,"failure_message_lines":["{\\"run_time\\":0}"]}}\n',
  );
  assert.equal(
    encodeFrame({ data: { test_cases: [{ id: "a", run_time: 1 }, { id: "b", run_time: 0.25 }] } }),
    '{"data":{"test_cases":[{"id":"a","run_time":1.0},{"id":"b","run_time":0.25}]}}\n',
  );
  assert.equal(
    encodeFrame({
      data: { connection_retries: 2, seconds_in_before_all_hooks: 0, seconds_in_after_all_hooks: 1e-7 },
    }),
    '{"data":{"connection_retries":2,"seconds_in_before_all_hooks":0.0,"seconds_in_after_all_hooks":1e-7}}\n',
  );
});

test("a frame written to a transport that stopped reading is reported unsent", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sel-pipe-"));
  const script = path.join(dir, "transport");
  writeFileSync(script, "#!/bin/sh\nexec 0<&-\necho ready\nsleep 5\n", { mode: 0o755 });
  const previous = process.env.SELECTIVE_TRANSPORT;
  process.env.SELECTIVE_TRANSPORT = script;
  const link = openStdio("ws://127.0.0.1:9/transport/websocket");
  try {
    assert.equal(await link.recv(), "ready");
    const unsent = await new Promise((resolve) => {
      assert.equal(link.send({ type: "test_case_result", data: { id: "a" } }, () => resolve(true)), true);
      setTimeout(() => resolve(false), 2000);
    });
    assert.equal(unsent, true);
  } finally {
    link.child.kill("SIGKILL");
    if (previous == null) delete process.env.SELECTIVE_TRANSPORT;
    else process.env.SELECTIVE_TRANSPORT = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("build-env round-trips a commit message and lists missing names", () => {
  const message = "a\\b\tc\nd";
  const filled = probe(
    bareEnv({
      SELECTIVE_API_KEY: "k",
      SELECTIVE_PLATFORM: "github_actions",
      SELECTIVE_RUN_ID: "run-1",
      SELECTIVE_RUN_ATTEMPT: "1",
      SELECTIVE_RUNNER_ID: "bad id/!",
      SELECTIVE_BRANCH: "main",
      SELECTIVE_SHA: "abc",
      SELECTIVE_GIT_REPO: "selectiveci/selective-js-vitest",
      SELECTIVE_GIT_PROVIDER: "github",
      SELECTIVE_COMMIT_MESSAGE: message,
    }),
    repoRoot,
  );
  assert.equal(filled.commit, message);
  assert.equal(filled.runner, "bad_id__");
  assert.deepEqual(filled.missing, []);

  const dir = mkdtempSync(path.join(tmpdir(), "sel-env-"));
  try {
    git(dir, ["init"]);
    const empty = probe(bareEnv(), dir);
    assert.deepEqual(empty.missing, [
      "SELECTIVE_API_KEY",
      "SELECTIVE_PLATFORM",
      "SELECTIVE_RUN_ID",
      "SELECTIVE_RUN_ATTEMPT",
      "SELECTIVE_BRANCH",
      "SELECTIVE_SHA",
      "SELECTIVE_GIT_REPO",
      "SELECTIVE_GIT_PROVIDER",
    ]);
    assert.match(empty.runner, /^selgen-[0-9a-f]{8}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(typeof loadEnvironment, "function");
  assert.equal(typeof missingSelectiveNames, "function");
});

test("snapshot tree comes from transport --snapshot", () => {
  const snap = snapshotTree(repoRoot);
  assert.equal(snap.ok, true);
  assert.equal(typeof snap.tree.sha, "string");
  assert.ok(snap.tree.sha.length >= 7);
  assert.equal(typeof snap.tree.prefix, "string");
  assert.equal(typeof snap.tree.files, "object");
  assert.equal(Array.isArray(snap.tree.dirty), true);
  assert.equal(typeof snap.tree.files["README.md"], "string");
});

test("a snapshot spawn error names itself", () => {
  const error = Object.assign(new Error("spawnSync ENOBUFS"), { code: "ENOBUFS" });
  const failed = interpretSnapshot({ error, status: null, stdout: "" });
  assert.equal(failed.ok, false);
  assert.match(snapshotFailure(failed), /ENOBUFS/);
  assert.equal(snapshotFailure(failed).includes("not a git checkout"), false);
  const checkout = interpretSnapshot({
    status: 1,
    stdout: "",
    stderr: "not a git checkout\n",
  });
  assert.equal(checkout.ok, false);
  assert.equal(checkout.error, null);
  assert.match(snapshotFailure(checkout), /not a git checkout/);
  const other = interpretSnapshot({ status: 1, stdout: "", stderr: "rev-parse failed\n" });
  assert.match(snapshotFailure(other), /rev-parse failed/);
  assert.equal(snapshotFailure(other).includes("not a git checkout"), false);
  const bare = interpretSnapshot({ status: 1, stdout: "" });
  assert.match(snapshotFailure(bare), /exit 1/);
  assert.equal(snapshotFailure(bare).includes("not a git checkout"), false);
  const dir = mkdtempSync(path.join(tmpdir(), "sel-not-git-"));
  try {
    const outside = snapshotTree(dir);
    assert.equal(outside.ok, false);
    assert.match(snapshotFailure(outside), /not a git checkout/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshot reads a tree past the 1 MiB spawn buffer", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sel-snap-"));
  try {
    git(dir, ["init"]);
    git(dir, ["config", "user.email", "dev@example.com"]);
    git(dir, ["config", "user.name", "Dev"]);
    git(dir, ["config", "commit.gpgsign", "false"]);
    const folder = path.join(dir, "p".repeat(48));
    mkdirSync(folder);
    const count = 11000;
    for (let i = 0; i < count; i += 1) {
      writeFileSync(path.join(folder, `f${String(i).padStart(5, "0")}.txt`), "x\n");
    }
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "many files"]);
    const snap = snapshotTree(dir);
    assert.equal(snap.ok, true, snap.error?.message);
    assert.equal(Object.keys(snap.tree.files).length, count);
    const bare = mkdtempSync(path.join(tmpdir(), "sel-snap-bare-"));
    try {
      const missed = snapshotTree(bare);
      assert.equal(missed.ok, false);
      assert.equal(missed.error, null);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("diff and correlation use origin and the suite root", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sel-git-"));
  try {
    git(dir, ["init"]);
    git(dir, ["config", "user.email", "dev@example.com"]);
    git(dir, ["config", "user.name", "Dev"]);
    git(dir, ["config", "commit.gpgsign", "false"]);
    writeFileSync(path.join(dir, "app.js"), "export const n = 1;\n");
    writeFileSync(path.join(dir, "app.test.js"), "test(\"adds\", () => {});\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "add both"]);
    writeFileSync(path.join(dir, "other.js"), "export const o = 1;\n");
    writeFileSync(path.join(dir, "app.test.js"), "test(\"other\", () => {});\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "other with the test"]);
    git(dir, ["checkout", "-b", "side"]);
    writeFileSync(path.join(dir, "app.test.js"), "test(\"side\", () => {});\n");
    git(dir, ["commit", "-am", "side"]);
    git(dir, ["checkout", "-"]);
    git(dir, ["merge", "--no-ff", "-m", "merge side", "side"]);
    git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    writeFileSync(path.join(dir, "app.js"), "export const n = 2;\n");
    writeFileSync(path.join(dir, "app.test.js"), "test(\"adds more\", () => {});\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "change both"]);
    const known = new Set(["app.test.js"]);
    const diff = diffTestFiles({
      cwd: dir,
      targetBranch: "main",
      suiteRoot: "",
      knownTests: known,
    });
    assert.deepEqual(diff, { ok: true, files: ["app.test.js"], sources: ["app.js"] });
    const correlated = correlateTestFiles({
      cwd: dir,
      targetBranch: "main",
      suiteRoot: "",
      knownTests: known,
      sources: diff.sources,
    });
    assert.deepEqual(correlated, {
      correlated_files: { "app.js": { "app.test.js": 2 } },
      uncorrelated_files: { "app.test.js": 1 },
    });
    const missing = diffTestFiles({
      cwd: dir,
      targetBranch: "missing-branch",
      suiteRoot: "",
      knownTests: known,
    });
    assert.equal(missing.ok, false);
    assert.match(missing.warning, /could not diff/);
    assert.equal(isTestPath("tests/app.test.js"), true);
    assert.equal(isTestPath("src/app.js"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the vitest bin reads the core package by its name", () => {
  const cli = path.join(repoRoot, "packages/vitest/src/cli.js");
  const listed = spawnSync(process.execPath, [cli], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(listed.status, 1);
  assert.match(listed.stderr, /usage: selective/);
});

test("vitest version pin and the select advertisement", () => {
  assert.equal(vitestVersionAllowed("4.1.1"), true);
  assert.equal(vitestVersionAllowed("4.1.0"), false);
  assert.equal(vitestVersionAllowed("4.2.0"), true);
  assert.equal(vitestVersionAllowed("5.0.0"), true);
  assert.equal(vitestVersionAllowed("6.0.0"), false);
  assert.equal(vitestVersionAllowed("3.9.9"), false);
  const adapter = createVitestAdapter({
    cwd: repoRoot,
    argv: [],
    coreVersion: "0.1.0",
    wrapperVersion: "0.1.0",
  });
  const previous = process.env.SELECTIVE_TEST_MAP_DISABLE;
  try {
    delete process.env.SELECTIVE_TEST_MAP_DISABLE;
    assert.equal(adapter.versions().testMap, "select");
    for (const value of ["1", "true", "yes", "TRUE", "Yes"]) {
      process.env.SELECTIVE_TEST_MAP_DISABLE = value;
      assert.equal(adapter.versions().testMap, "0");
    }
  } finally {
    if (previous == null) delete process.env.SELECTIVE_TEST_MAP_DISABLE;
    else process.env.SELECTIVE_TEST_MAP_DISABLE = previous;
  }
});
