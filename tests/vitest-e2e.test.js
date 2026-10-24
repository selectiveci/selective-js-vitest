import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { repoRoot, selectiveEnv, spawnNode, startMock, websocketQuery } from "./support/harness.js";

const cli = path.join(repoRoot, "packages/vitest/src/cli.js");
const sampleConfig = "fixtures/vitest-sample/vitest.config.js";

function readLog(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function countLine(text, line) {
  return text.split("\n").filter((item) => item === line).length;
}

async function bootVitest(args, env = {}) {
  const server = await startMock();
  const dir = mkdtempSync(path.join(tmpdir(), "sel-vitest-"));
  const logs = {
    dir,
    hook: path.join(dir, "hook"),
    setup: path.join(dir, "setup"),
    body: path.join(dir, "body"),
    flake: path.join(dir, "flake"),
    config: path.join(dir, "config.json"),
    junit: path.join(dir, "junit.xml"),
    reason: path.join(dir, "reason"),
    signal: path.join(dir, "signal"),
  };
  const proc = spawnNode(
    cli,
    ["vitest", ...args, ...(process.env.VITEST_POOL ? [`--pool=${process.env.VITEST_POOL}`] : [])],
    selectiveEnv({
      SELECTIVE_HOST: server.origin,
      SELECTIVE_HOOK_LOG: logs.hook,
      SELECTIVE_SETUP_LOG: logs.setup,
      SELECTIVE_BODY_LOG: logs.body,
      SELECTIVE_FLAKE_FILE: logs.flake,
      SELECTIVE_CONFIG_OUT: logs.config,
      SELECTIVE_JUNIT_OUT: path.join(dir, "junit.xml"),
      SELECTIVE_REASON_OUT: logs.reason,
      SELECTIVE_SIGNAL_LOG: logs.signal,
      ...env,
    }),
  );
  try {
    await server.until(
      () => server.connections.some((conn) => !conn.rejected && conn.ws?.readyState === 1),
      30000,
    );
  } catch (err) {
    proc.child.kill("SIGKILL");
    await proc.exit(5000).catch(() => {});
    await server.close();
    throw new Error(`${err.message}\n${proc.stderr()}\n${proc.stdout()}`);
  }
  return {
    server,
    proc,
    logs,
    async stop() {
      if (proc.child.exitCode == null && proc.child.signalCode == null) {
        proc.child.kill("SIGKILL");
      }
      await proc.exit(5000).catch(() => {});
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function fragmentOf(server) {
  assert.equal(server.fragments.length, 1);
  const [upload] = server.fragments;
  const query = new URL(upload.url, "http://127.0.0.1").searchParams;
  assert.deepEqual([query.get("run_id"), query.get("run_attempt"), query.get("runner_id")], ["run-1", "1", "runner-1"]);
  assert.equal(upload.headers.authorization, "conformance-key");
  const fragment = JSON.parse(gunzipSync(upload.body).toString());
  assert.equal(fragment.version, 1);
  for (const file of fragment.files) assert.equal(existsSync(path.join(repoRoot, file)), true, file);
  return new Map(fragment.tests.map((item) => [item.id, item.deps.map((index) => fragment.files[index]).sort()]));
}

async function manifestOf(server) {
  server.send({ command: "connected" });
  server.send({ command: "test_manifest" });
  const frame = await server.next(30000);
  assert.equal(frame.type, "test_manifest");
  return frame;
}

function byDescription(frame, description) {
  const found = frame.data.test_cases.filter((item) => item.description === description);
  assert.equal(found.length, 1, `${description} count ${found.length}`);
  return found[0];
}

test("dynamic split, hook re-entry, assigned results, and forced workers", async () => {
  const ctx = await bootVitest(["--config", sampleConfig, "--shard=1/2"]);
  try {
    const params = websocketQuery(ctx.server.connections[0].url);
    assert.equal(params.get("test_map"), "record");
    assert.equal(params.get("framework"), "vitest");
    ctx.server.send({
      command: "configure_test_map",
      tree: true,
      record: true,
      allocations: true,
    });
    const manifest = await manifestOf(ctx.server);
    const descriptions = manifest.data.test_cases.map((item) => item.description);
    assert.equal(descriptions.includes("row %s"), false);
    assert.equal(descriptions.includes("row 1"), true);
    assert.equal(descriptions.includes("row 2"), true);
    assert.equal(descriptions.includes("static after"), true);
    assert.equal(descriptions.includes("typed adds"), true);
    assert.equal(descriptions.includes("alpha"), true);
    assert.equal(descriptions.filter((item) => item === "same").length, 2);
    const sameIds = manifest.data.test_cases.filter((item) => item.description === "same").map((item) => item.id);
    assert.equal(new Set(sameIds).size, 2);
    for (const item of manifest.data.test_cases) {
      assert.equal(typeof item.run_time, "number");
      assert.equal(item.file_path.startsWith("fixtures/vitest-sample/tests/"), true);
      assert.equal(item.file_path.startsWith("/"), false);
    }
    assert.equal(typeof manifest.data.test_map_tree.sha, "string");
    const forced = JSON.parse(readFileSync(ctx.logs.config, "utf8"));
    assert.equal(forced.fileParallelism, false);
    assert.equal(Number(forced.maxWorkers), 1);
    assert.equal(forced.isolate, false);
    assert.match(ctx.proc.stderr(), /ignoring --shard and --changed/);

    const row = byDescription(manifest, "row 1");
    const alpha = byDescription(manifest, "alpha");
    const beta = byDescription(manifest, "beta");
    const gamma = byDescription(manifest, "gamma");
    ctx.server.send({
      command: "run_test_cases",
      test_case_ids: ["not-a-real-test", row.id],
    });
    const missing = await ctx.server.next(30000);
    const rowResult = await ctx.server.next(30000);
    assert.equal(missing.data.status, "failed");
    assert.match(missing.data.failure_message_lines[0], /not collected/);
    assert.equal(rowResult.data.id, row.id);
    assert.equal(rowResult.data.status, "passed");
    assert.equal(readLog(ctx.logs.body), "row 1\n");
    ctx.server.send({ command: "remove_failed_test_case_result", test_case_id: "not-a-real-test" });

    const started = performance.now();
    ctx.server.send({ command: "run_test_cases", test_case_ids: [alpha.id, beta.id] });
    const alphaResult = await ctx.server.next(30000);
    const betaResult = await ctx.server.next(30000);
    const elapsed = (performance.now() - started) / 1000;
    const reported = alphaResult.data.run_time + betaResult.data.run_time;
    assert.ok(reported > elapsed / 2 && reported <= elapsed, `${reported}s reported for ${elapsed}s`);
    assert.match(ctx.proc.stdout(), /✓ fixtures\/vitest-sample\/tests\/group\.test\.js > beta \d+ms/);
    assert.deepEqual([alphaResult.data.id, alphaResult.data.status], [alpha.id, "passed"]);
    assert.deepEqual([betaResult.data.id, betaResult.data.status], [beta.id, "passed"]);

    ctx.server.send({ command: "run_test_cases", test_case_ids: [gamma.id] });
    const gammaResult = await ctx.server.next(30000);
    assert.deepEqual([gammaResult.data.id, gammaResult.data.status], [gamma.id, "passed"]);

    ctx.server.send({ command: "close", exit_status: null });
    const report = await ctx.server.next(15000);
    assert.equal(report.type, "report_at_finish");
    assert.equal(report.data.connection_retries, 0);
    assert.equal(typeof report.data.seconds_in_before_all_hooks, "number");
    assert.equal(typeof report.data.seconds_in_after_all_hooks, "number");
    assert.ok(report.data.seconds_in_before_all_hooks >= 0.15 && report.data.seconds_in_before_all_hooks < 0.2);
    assert.ok(report.data.seconds_in_after_all_hooks > 0);
    assert.equal((await ctx.proc.exit(30000)).code, 0);
    assert.equal(countLine(readLog(ctx.logs.hook), "beforeAll"), 3);
    assert.equal(countLine(readLog(ctx.logs.hook), "afterAll"), 3);
    assert.equal(countLine(readLog(ctx.logs.hook), "module"), 3);
    assert.equal(readLog(ctx.logs.body), "row 1\n");
    assert.equal(readLog(ctx.logs.setup), "setup\nteardown\n");
    assert.equal(ctx.proc.stdout().includes("Test Files"), true);
    assert.equal(readLog(ctx.logs.reason), "passed");
    const deps = fragmentOf(ctx.server);
    assert.deepEqual([...deps.keys()].sort(), [row.id, alpha.id, beta.id, gamma.id].sort());
    assert.equal(deps.get(row.id).includes("fixtures/vitest-sample/tests/dynamic.test.js"), true);
    assert.equal(deps.get(alpha.id).includes("fixtures/vitest-sample/tests/group.test.js"), true);
    assert.equal(ctx.proc.stderr().includes("recording is unavailable"), false);
  } finally {
    await ctx.stop();
  }
});

test("failure backtrace stays in the repo and a skip is pending", async () => {
  const ctx = await bootVitest(["--config", sampleConfig]);
  try {
    const manifest = await manifestOf(ctx.server);
    const fails = byDescription(manifest, "fails");
    const pends = byDescription(manifest, "pends");
    ctx.server.send({ command: "run_test_cases", test_case_ids: [fails.id, pends.id] });
    const failed = await ctx.server.next(30000);
    const pending = await ctx.server.next(30000);
    assert.equal(failed.data.id, fails.id);
    assert.equal(failed.data.status, "failed");
    const frame = failed.data.failure_formatted_backtrace[0];
    assert.match(frame, /outcomes\.test\.js/);
    assert.equal(frame.startsWith("/"), false);
    assert.equal(frame.includes("node_modules"), false);
    assert.ok(failed.data.failure_message_lines.includes("- Expected"));
    assert.equal(failed.data.failure_message_lines.some((line) => line.includes("\u001b")), false);
    assert.equal(pending.data.id, pends.id);
    assert.equal(pending.data.status, "pending");
    ctx.server.send({ command: "close", exit_status: null });
    assert.match((await ctx.server.next(15000)).raw, /"seconds_in_before_all_hooks":0\.0[,}]/);
    assert.equal((await ctx.proc.exit(20000)).code, 1);
    assert.equal(readLog(ctx.logs.reason), "failed");
  } finally {
    await ctx.stop();
  }
});

test("an id assigned twice in a batch runs twice, and removing it exits 0", async () => {
  const ctx = await bootVitest(["--config", sampleConfig]);
  try {
    const manifest = await manifestOf(ctx.server);
    const fails = byDescription(manifest, "fails");
    ctx.server.send({ command: "run_test_cases", test_case_ids: [fails.id, fails.id] });
    assert.equal((await ctx.server.next(30000)).data.status, "failed");
    assert.equal((await ctx.server.next(30000)).data.status, "failed");
    ctx.server.send({ command: "remove_failed_test_case_result", test_case_id: fails.id });
    ctx.server.send({ command: "close", exit_status: null });
    await ctx.server.next(15000);
    assert.equal((await ctx.proc.exit(20000)).code, 0);
    assert.equal(readLog(ctx.logs.setup), "setup\nteardown\n");
  } finally {
    await ctx.stop();
  }
});

test("a vitest flake fails and then passes on the next assign", async () => {
  const ctx = await bootVitest(["--config", sampleConfig]);
  try {
    const manifest = await manifestOf(ctx.server);
    const flake = byDescription(manifest, "flake");
    ctx.server.send({ command: "run_test_cases", test_case_ids: [flake.id] });
    assert.equal((await ctx.server.next(30000)).data.status, "failed");
    ctx.server.send({ command: "run_test_cases", test_case_ids: [flake.id] });
    assert.equal((await ctx.server.next(30000)).data.status, "passed");
    ctx.server.send({ command: "close", exit_status: null });
    await ctx.server.next(15000);
    assert.equal((await ctx.proc.exit(20000)).code, 0);
  } finally {
    await ctx.stop();
  }
});

test("an integer close skips vitest teardown", async () => {
  const ctx = await bootVitest(["--config", sampleConfig]);
  try {
    await manifestOf(ctx.server);
    ctx.server.send({ command: "close", exit_status: 2, message: "stop" });
    await ctx.server.next(15000);
    assert.equal((await ctx.proc.exit(20000)).code, 2);
    assert.equal(readLog(ctx.logs.setup).includes("setup"), true);
    assert.equal(readLog(ctx.logs.setup).includes("teardown"), false);
  } finally {
    await ctx.stop();
  }
});

test("SIGTERM after a vitest failure exits 1", async () => {
  const ctx = await bootVitest(["--config", sampleConfig]);
  try {
    const manifest = await manifestOf(ctx.server);
    const fails = byDescription(manifest, "fails");
    ctx.server.send({ command: "run_test_cases", test_case_ids: [fails.id] });
    assert.equal((await ctx.server.next(30000)).data.status, "failed");
    const started = Date.now();
    ctx.proc.child.kill("SIGTERM");
    const frame = await ctx.server.next(10000);
    assert.equal(frame.type, "terminating");
    assert.equal(frame.data.signal, "TERM");
    assert.equal((await ctx.proc.exit(15000)).code, 1);
    assert.ok(Date.now() - started >= 200);
    assert.equal(readLog(ctx.logs.signal), "user\nsetup\n");
  } finally {
    await ctx.stop();
  }
});

test("exec prints the manifest without CI env and can filter it", async () => {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: "C.UTF-8",
  };
  const listed = spawnNode(cli, ["exec", "vitest", "--config", sampleConfig], env);
  const listedExit = await listed.exit(60000);
  assert.equal(listedExit.code, 0, listed.stderr());
  const all = JSON.parse(listed.stdout());
  assert.equal(all.test_cases.some((item) => item.description === "row 1"), true);
  assert.equal(all.test_cases.some((item) => item.description === "row 2"), true);
  assert.equal(all.test_cases.some((item) => item.description === "row %s"), false);
  assert.equal(listed.stdout().includes("Test Files"), false);

  const filtered = spawnNode(cli, ["exec", "vitest", "--config", sampleConfig, "-t", "alpha"], env);
  const filteredExit = await filtered.exit(60000);
  assert.equal(filteredExit.code, 0, filtered.stderr());
  const only = JSON.parse(filtered.stdout().slice(filtered.stdout().indexOf("{")));
  assert.deepEqual(only.test_cases.map((item) => item.description), ["alpha"]);

  const empty = spawnNode(
    cli,
    ["exec", "vitest", "--config", "fixtures/vitest-empty/vitest.config.js"],
    env,
  );
  const emptyExit = await empty.exit(60000);
  assert.equal(emptyExit.code, 1);
  assert.match(empty.stderr(), /No test/i);
});

const review = "fixtures/vitest-review";

function vitestRun(config, env = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "sel-json-"));
  const out = path.join(dir, "report.json");
  const bin = path.join(repoRoot, "node_modules/vitest/vitest.mjs");
  const result = spawnSync(
    process.execPath,
    [bin, "run", "--config", config, "--reporter=json", `--outputFile=${out}`],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, ...env, SELECTIVE_BODY_LOG: "" },
    },
  );
  let report = null;
  try {
    report = JSON.parse(readFileSync(out, "utf8"));
  } catch {
    report = null;
  }
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, report, stderr: result.stderr, stdout: result.stdout };
}

async function runAssigned(ctx, ids) {
  ctx.server.send({ command: "run_test_cases", test_case_ids: ids });
  const results = [];
  for (let i = 0; i < ids.length; i += 1) results.push(await ctx.server.next(30000));
  return results;
}

test("a user-configured runner is refused in one line", async () => {
  const listed = spawnNode(cli, ["exec", "vitest", "--config", `${review}/vitest.runner.config.js`], {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: "C.UTF-8",
  });
  assert.equal((await listed.exit(60000)).code, 1);
  assert.equal(listed.stderr().trim(), `selective: test.runner (${repoRoot}/${review}/custom-runner.js) is not supported; Selective runs Vitest with its own runner`);
});

test("github actions annotations, a throwing reporter and coverage across batches", async () => {
  const annotated = await bootVitest(["--config", `${review}/vitest.projects.config.js`], { GITHUB_ACTIONS: "true" });
  try {
    const manifest = await manifestOf(annotated.server);
    const modes = manifest.data.test_cases.filter((item) => item.description === "mode is pass");
    await runAssigned(annotated, modes.map((item) => item.id));
    annotated.server.send({ command: "close", exit_status: null });
    await annotated.server.next(15000);
    assert.equal((await annotated.proc.exit(20000)).code, 1);
    assert.match(annotated.proc.stdout(), /::error file=[^\n]*shared\.test\.js,title=\[A\] [^\n]*mode is pass[^\n]*expected 'fail' to be 'pass'/);
  } finally {
    await annotated.stop();
  }

  const throwing = await bootVitest(["--config", `${review}/vitest.throwing.config.js`]);
  try {
    const ids = (await manifestOf(throwing.server)).data.test_cases.map((item) => item.id);
    await runAssigned(throwing, ids);
    throwing.server.send({ command: "close", exit_status: null });
    await throwing.server.next(15000);
    assert.equal((await throwing.proc.exit(20000)).code, 1);
    assert.match(throwing.proc.stderr(), /reporter boom/);
  } finally {
    await throwing.stop();
  }

  const coverageDir = mkdtempSync(path.join(tmpdir(), "sel-coverage-"));
  const covered = await bootVitest(["--config", `${review}/vitest.coverage.config.js`, "--coverage"], {
    SELECTIVE_COVERAGE_DIR: coverageDir,
  });
  try {
    assert.equal(websocketQuery(covered.server.connections[0].url).get("test_map"), "select");
    covered.server.send({ command: "configure_test_map", record: true });
    const manifest = await manifestOf(covered.server);
    await runAssigned(covered, [byDescription(manifest, "one").id]);
    await runAssigned(covered, [byDescription(manifest, "two").id]);
    covered.server.send({ command: "close", exit_status: null });
    await covered.server.next(15000);
    assert.equal((await covered.proc.exit(20000)).code, 0);
    const summary = JSON.parse(readFileSync(path.join(coverageDir, "coverage-summary.json"), "utf8"));
    const files = Object.keys(summary).filter((key) => key !== "total").map((key) => path.basename(key)).sort();
    assert.deepEqual(files, ["one.js", "two.js"]);
    assert.equal(covered.server.fragments.length, 0);
    assert.equal(covered.proc.stderr().split("recording is unavailable").length - 1, 1);
  } finally {
    await covered.stop();
    rmSync(coverageDir, { recursive: true, force: true });
  }
});

test("recording gives each test the files it ran, whatever the batch order", async () => {
  const ctx = await bootVitest(["--config", `${review}/vitest.record.config.js`]);
  try {
    assert.equal(websocketQuery(ctx.server.connections[0].url).get("test_map"), "record");
    ctx.server.send({ command: "configure_test_map", record: true });
    const manifest = await manifestOf(ctx.server);
    const one = byDescription(manifest, "one").id;
    const two = byDescription(manifest, "two").id;
    const together = [byDescription(manifest, "together one").id, byDescription(manifest, "together two").id];
    await runAssigned(ctx, [one, two, ...together]);
    await runAssigned(ctx, [two, one]);
    ctx.server.send({ command: "close", exit_status: null });
    await ctx.server.next(15000);
    assert.equal((await ctx.proc.exit(20000)).code, 0);
    const deps = fragmentOf(ctx.server);
    assert.deepEqual([...deps.keys()].sort(), [one, two].sort());
    assert.deepEqual(deps.get(one), [`${review}/src/one.js`, `${review}/tests/covered/one.test.js`]);
    assert.deepEqual(deps.get(two), [`${review}/src/two.js`, `${review}/tests/covered/two.test.js`]);
  } finally {
    await ctx.stop();
  }
});

test("a tracer that fails in the worker still runs the tests and uploads nothing", async () => {
  const ctx = await bootVitest(["--config", `${review}/vitest.broken-inspector.config.js`]);
  try {
    assert.equal(websocketQuery(ctx.server.connections[0].url).get("test_map"), "record");
    ctx.server.send({ command: "configure_test_map", record: true });
    const manifest = await manifestOf(ctx.server);
    const [one] = await runAssigned(ctx, [byDescription(manifest, "one").id]);
    const [two] = await runAssigned(ctx, [byDescription(manifest, "two").id]);
    assert.deepEqual([one.data.status, two.data.status], ["passed", "passed"]);
    ctx.server.send({ command: "close", exit_status: null });
    await ctx.server.next(15000);
    assert.equal((await ctx.proc.exit(20000)).code, 0);
    assert.equal(ctx.server.fragments.length, 0);
    assert.equal(ctx.proc.stderr().split("test map recording stopped (inspector stubbed to fail)").length - 1, 1);
  } finally {
    await ctx.stop();
  }
});

test("each result in a batch reports its own time", async () => {
  const ctx = await bootVitest(["--config", `${review}/vitest.paced.config.js`]);
  try {
    const manifest = await manifestOf(ctx.server);
    const results = await runAssigned(ctx, manifest.data.test_cases.map((item) => item.id));
    for (const { data } of results) assert.ok(data.run_time >= 0.025, `${data.description} ${data.run_time}`);
    const times = results.map(({ data }) => data.run_time);
    assert.ok(Math.max(...times) < 2 * Math.min(...times), times.join(" "));
    ctx.server.send({ command: "close", exit_status: null });
    await ctx.server.next(15000);
    assert.equal((await ctx.proc.exit(20000)).code, 0);
  } finally {
    await ctx.stop();
  }
});

test("loop and helper registration matches vitest run", async () => {
  const config = `${review}/vitest.registered.config.js`;
  const native = vitestRun(config);
  assert.equal(native.status, 1, native.stderr);
  assert.equal(native.report.numTotalTests, 12);
  assert.equal(native.report.numFailedTests, 5);
  assert.equal(native.report.numPassedTests, 7);
  const ctx = await bootVitest(["--config", config]);
  try {
    const manifest = await manifestOf(ctx.server);
    assert.equal(manifest.data.test_cases.length, 12);
    for (const item of manifest.data.test_cases) {
      assert.ok(item.line_number > 0, item.full_description);
      assert.equal(item.description.includes("${"), false);
    }
    const names = manifest.data.test_cases.map((item) => item.description);
    for (const name of [
      "imported pass",
      "imported fail",
      "static pass",
      "loop 1",
      "loop 2",
      "helper pass",
      "helper fail",
      "fixture 1",
      "fixture 2",
      "inside",
      "static fail",
    ]) {
      assert.equal(names.includes(name), true, name);
    }
    assert.equal(names.filter((name) => name === "inside").length, 2);
    const results = await runAssigned(
      ctx,
      manifest.data.test_cases.map((item) => item.id),
    );
    assert.deepEqual(
      readLog(ctx.logs.body).trim().split("\n"),
      results.map((item) => item.data.full_description),
    );
    const failed = results.filter((item) => item.data.status === "failed");
    const passed = results.filter((item) => item.data.status === "passed");
    assert.equal(failed.length, 5);
    assert.equal(passed.length, 7);
    ctx.server.send({ command: "close", exit_status: null });
    await ctx.server.next(15000);
    assert.equal((await ctx.proc.exit(30000)).code, 1);
  } finally {
    await ctx.stop();
  }
});

test("a file that fails to collect fails only the shard that ran it", async () => {
  const config = `${review}/vitest.collect.config.js`;
  const native = vitestRun(config);
  assert.equal(native.status, 1, native.stderr);
  const listed = spawnNode(cli, ["exec", "vitest", "--config", config], {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: "C.UTF-8",
  });
  const listedExit = await listed.exit(60000);
  assert.equal(listedExit.code, 1, listed.stderr());
  assert.match(listed.stderr(), /collect boom/);
  const all = JSON.parse(listed.stdout().slice(listed.stdout().indexOf("{")));
  assert.equal(all.test_cases.some((item) => item.description === "ok"), true);
  assert.equal(
    all.test_cases.some((item) => item.file_path.includes("boom.test.js")),
    true,
  );
  assert.equal(
    all.test_cases.some((item) => item.file_path.includes("syntax.test.js")),
    true,
  );
  const ctx = await bootVitest(["--config", config]);
  try {
    const manifest = await manifestOf(ctx.server);
    const ok = byDescription(manifest, "ok");
    const boom = manifest.data.test_cases.find((item) => item.file_path.includes("boom.test.js"));
    assert.ok(boom);
    assert.match(ctx.proc.stderr(), /collect boom/);
    const onlyGood = await runAssigned(ctx, [ok.id]);
    assert.equal(onlyGood[0].data.status, "passed");
    const reported = await runAssigned(ctx, [boom.id]);
    assert.equal(reported[0].data.status, "failed");
    assert.match(reported[0].data.failure_message_lines.join("\n"), /collect boom/);
    ctx.server.send({ command: "close", exit_status: null });
    await ctx.server.next(15000);
    assert.equal((await ctx.proc.exit(20000)).code, 1);
  } finally {
    await ctx.stop();
  }
  const clean = await bootVitest(["--config", config]);
  try {
    const ok = byDescription(await manifestOf(clean.server), "ok");
    assert.equal((await runAssigned(clean, [ok.id]))[0].data.status, "passed");
    clean.server.send({ command: "close", exit_status: null });
    await clean.server.next(15000);
    assert.equal((await clean.proc.exit(20000)).code, 0);
  } finally {
    await clean.stop();
  }
});

test("an unhandled error fails its file's tests until they are removed", async () => {
  for (const remove of [false, true]) {
    const ctx = await bootVitest(["--config", `${review}/vitest.unhandled.config.js`]);
    try {
      const ids = (await manifestOf(ctx.server)).data.test_cases.map((item) => item.id);
      const results = await runAssigned(ctx, ids);
      assert.deepEqual(results.map(({ data }) => data.status), ["passed", "passed"]);
      if (remove) {
        for (const id of ids) ctx.server.send({ command: "remove_failed_test_case_result", test_case_id: id });
      }
      ctx.server.send({ command: "close", exit_status: null });
      await ctx.server.next(15000);
      assert.equal((await ctx.proc.exit(20000)).code, remove ? 0 : 1);
      assert.match(ctx.proc.stderr(), /selective: error outside a test in fixtures\/vitest-review\/tests\/unhandled\/leak\.test\.js: leaked rejection \(fails leaks, clean\)/);
    } finally {
      await ctx.stop();
    }
  }
});

test("a throwing beforeAll or afterAll fails the test that ran it", async () => {
  const config = `${review}/vitest.hooks.config.js`;
  const before = await bootVitest(["--config", config]);
  try {
    const manifest = await manifestOf(before.server);
    const hook = byDescription(manifest, "after hook");
    const result = await runAssigned(before, [hook.id]);
    assert.equal(result[0].data.status, "failed");
    assert.match(result[0].data.failure_message_lines.join("\n"), /boom in beforeAll/);
    before.server.send({ command: "close", exit_status: null });
    await before.server.next(15000);
    assert.equal((await before.proc.exit(20000)).code, 1);
  } finally {
    await before.stop();
  }

  const after = await bootVitest(["--config", config]);
  try {
    const manifest = await manifestOf(after.server);
    const body = byDescription(manifest, "body");
    const result = await runAssigned(after, [body.id]);
    assert.equal(result[0].data.status, "failed");
    assert.match(result[0].data.failure_message_lines.join("\n"), /after boom/);
    after.server.send({ command: "close", exit_status: null });
    await after.server.next(15000);
    assert.equal((await after.proc.exit(20000)).code, 1);
    assert.equal(readLog(after.logs.reason), "failed");
  } finally {
    await after.stop();
  }

  const nested = await bootVitest(["--config", config]);
  try {
    const manifest = await manifestOf(nested.server);
    const inner = byDescription(manifest, "inner");
    const result = await runAssigned(nested, [inner.id]);
    assert.equal(result[0].data.status, "failed");
    assert.match(result[0].data.failure_message_lines.join("\n"), /nested after/);
    nested.server.send({ command: "close", exit_status: null });
    await nested.server.next(15000);
    assert.equal((await nested.proc.exit(20000)).code, 1);
  } finally {
    await nested.stop();
  }

  const clean = await bootVitest(["--config", config]);
  try {
    const manifest = await manifestOf(clean.server);
    const ok = byDescription(manifest, "clean");
    const result = await runAssigned(clean, [ok.id]);
    assert.equal(result[0].data.status, "passed");
    clean.server.send({ command: "close", exit_status: null });
    await clean.server.next(15000);
    assert.equal((await clean.proc.exit(20000)).code, 0);
  } finally {
    await clean.stop();
  }
});

test("allowOnly false fails the shard and an author skip stays pending", async () => {
  const config = `${review}/vitest.only.config.js`;
  const open = await bootVitest(["--config", config]);
  try {
    const manifest = await manifestOf(open.server);
    const focused = byDescription(manifest, "focused");
    const sibling = byDescription(manifest, "sibling");
    const skipped = byDescription(manifest, "author skip");
    const results = await runAssigned(open, [focused.id, sibling.id, skipped.id]);
    const byId = new Map(results.map((item) => [item.data.id, item.data.status]));
    assert.equal(byId.get(focused.id), "passed");
    assert.equal(byId.get(sibling.id), "pending");
    assert.equal(byId.get(skipped.id), "pending");
    open.server.send({ command: "close", exit_status: null });
    await open.server.next(15000);
    assert.equal((await open.proc.exit(20000)).code, 0);
  } finally {
    await open.stop();
  }

  const closed = await bootVitest(["--config", config], { CI: "true" });
  try {
    const manifest = await manifestOf(closed.server);
    const focused = byDescription(manifest, "focused");
    const sibling = byDescription(manifest, "sibling");
    const ran = await runAssigned(closed, [sibling.id, focused.id]);
    const focusedResult = ran.find((item) => item.data.id === focused.id).data;
    assert.equal(focusedResult.status, "failed");
    assert.match(focusedResult.failure_message_lines.join("\n"), /only/i);
    closed.server.send({ command: "close", exit_status: null });
    await closed.server.next(15000);
    assert.equal((await closed.proc.exit(20000)).code, 1);
  } finally {
    await closed.stop();
  }
});

test("a file shared by two projects runs in both", async () => {
  const config = `${review}/vitest.projects.config.js`;
  const native = vitestRun(config);
  assert.equal(native.status, 1, native.stderr);
  assert.equal(native.report.numTotalTests, 4);
  assert.equal(native.report.numFailedTests, 1);
  assert.equal(native.report.numPassedTests, 3);
  const listed = spawnNode(cli, ["exec", "vitest", "--config", config], {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: "C.UTF-8",
  });
  const listedExit = await listed.exit(60000);
  assert.equal(listedExit.code, 0, listed.stderr());
  const all = JSON.parse(listed.stdout().slice(listed.stdout().indexOf("{")));
  assert.equal(all.test_cases.length, 4);
  assert.equal(new Set(all.test_cases.map((item) => item.id)).size, 4);
  assert.equal(
    new Set(all.test_cases.map((item) => item.file_path)).size,
    1,
  );
  const ctx = await bootVitest(["--config", config]);
  try {
    const manifest = await manifestOf(ctx.server);
    assert.equal(manifest.data.test_cases.length, 4);
    const results = await runAssigned(
      ctx,
      manifest.data.test_cases.map((item) => item.id),
    );
    const statuses = results.map((item) => item.data.status).sort();
    assert.deepEqual(statuses, ["failed", "passed", "passed", "passed"]);
    const bodies = readLog(ctx.logs.body).trim().split("\n").sort();
    assert.deepEqual(bodies, ["fail", "pass"]);
    assert.equal(countLine(readLog(ctx.logs.hook), "beforeAll"), 4);
    ctx.server.send({ command: "close", exit_status: null });
    await ctx.server.next(15000);
    assert.equal((await ctx.proc.exit(20000)).code, 1);
  } finally {
    await ctx.stop();
  }
});

test("junit lists each assigned id once and still writes on an integer close", async () => {
  const ctx = await bootVitest(["--config", `${review}/vitest.junit.config.js`]);
  try {
    const manifest = await manifestOf(ctx.server);
    const alpha = byDescription(manifest, "alpha");
    const beta = byDescription(manifest, "beta");
    byDescription(manifest, "gamma");
    const first = await runAssigned(ctx, [alpha.id]);
    assert.equal(first[0].data.status, "failed");
    const second = await runAssigned(ctx, [beta.id, alpha.id]);
    assert.equal(second[0].data.status, "passed");
    assert.equal(second[1].data.status, "passed");
    ctx.server.send({ command: "close", exit_status: 0 });
    await ctx.server.next(15000);
    assert.equal((await ctx.proc.exit(20000)).code, 0);
    const xml = readFileSync(ctx.logs.junit, "utf8");
    assert.equal((xml.match(/name="alpha"/g) || []).length, 1);
    assert.equal((xml.match(/name="beta"/g) || []).length, 1);
    assert.equal(xml.includes("gamma"), false);
    assert.equal(xml.includes("<skipped"), false);
    const alphaXml = xml.slice(
      xml.indexOf('name="alpha"'),
      xml.indexOf("</testcase>", xml.indexOf('name="alpha"')),
    );
    assert.equal(alphaXml.includes("<failure"), false);
    assert.match(ctx.proc.stdout(), /marker-alpha/);
    assert.match(ctx.proc.stdout(), /marker-beta/);
    assert.equal(ctx.proc.stdout().includes("marker-gamma"), false);
    assert.equal(readLog(ctx.logs.setup).includes("setup"), true);
    assert.equal(readLog(ctx.logs.setup).includes("teardown"), false);
  } finally {
    await ctx.stop();
  }
});

test("passed-only silent prints logs from a failed test", async () => {
  const ctx = await bootVitest([
    "--config",
    `${review}/vitest.junit.config.js`,
    "--silent=passed-only",
  ]);
  try {
    const manifest = await manifestOf(ctx.server);
    const alpha = byDescription(manifest, "alpha");
    const beta = byDescription(manifest, "beta");
    const first = await runAssigned(ctx, [alpha.id]);
    assert.equal(first[0].data.status, "failed");
    const second = await runAssigned(ctx, [beta.id]);
    assert.equal(second[0].data.status, "passed");
    ctx.server.send({ command: "close", exit_status: 0 });
    await ctx.server.next(15000);
    assert.equal((await ctx.proc.exit(20000)).code, 0);
    assert.match(ctx.proc.stdout(), /marker-alpha/);
    assert.equal(ctx.proc.stdout().includes("marker-beta"), false);
  } finally {
    await ctx.stop();
  }
});

test("silent config keeps console markers off and still writes junit", async () => {
  const ctx = await bootVitest(["--config", `${review}/vitest.junit.config.js`, "--silent"]);
  try {
    const manifest = await manifestOf(ctx.server);
    const beta = byDescription(manifest, "beta");
    const ran = await runAssigned(ctx, [beta.id]);
    assert.equal(ran[0].data.status, "passed");
    ctx.server.send({ command: "close", exit_status: 0 });
    await ctx.server.next(15000);
    assert.equal((await ctx.proc.exit(20000)).code, 0);
    assert.equal(ctx.proc.stdout().includes("marker-beta"), false);
    const xml = readFileSync(ctx.logs.junit, "utf8");
    assert.equal((xml.match(/name="beta"/g) || []).length, 1);
    assert.equal(xml.includes("gamma"), false);
  } finally {
    await ctx.stop();
  }
});
