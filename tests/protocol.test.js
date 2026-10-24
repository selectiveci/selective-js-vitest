import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { repoRoot, selectiveEnv, spawnNode, startMock, websocketQuery } from "./support/harness.js";

const client = path.join(repoRoot, "tests/support/protocol-client.js");

function queryOf(conn) {
  return websocketQuery(conn.url);
}

function openConnections(server) {
  return server.connections.filter(
    (conn) => !conn.rejected && conn.ws && conn.ws.readyState === 1,
  );
}

async function withClient(fn, { env = {}, args = [], wait = true, cwd = repoRoot } = {}) {
  const server = await startMock();
  const dir = mkdtempSync(path.join(tmpdir(), "sel-proto-"));
  const log = path.join(dir, "finish");
  const proc = spawnNode(
    client,
    args,
    selectiveEnv({
      SELECTIVE_HOST: server.origin,
      SELECTIVE_FINISH_LOG: log,
      ...env,
    }),
    cwd,
  );
  try {
    if (wait) {
      await server.until(() => openConnections(server).length >= 1, 15000);
    }
    await fn({ server, proc, log });
  } finally {
    if (proc.child.exitCode == null && proc.child.signalCode == null) {
      proc.child.kill("SIGKILL");
    }
    await proc.exit(5000).catch(() => {});
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function connectAndManifest(ctx) {
  ctx.server.send({ command: "connected" });
  ctx.server.send({ command: "test_manifest" });
  const frame = await ctx.server.next();
  assert.equal(frame.type, "test_manifest");
  return frame;
}

function caseById(frame, id) {
  return frame.data.test_cases.find((item) => item.id === id);
}

test("happy two batches advertises select and finishes", async () => {
  await withClient(async ({ server, proc, log }) => {
    const params = queryOf(server.connections[0]);
    assert.equal(params.get("api_key"), "conformance-key");
    assert.equal(params.get("run_id"), "run-1");
    assert.equal(params.get("run_attempt"), "1");
    assert.equal(params.get("runner_id"), "runner-1");
    assert.equal(params.get("language"), "javascript");
    assert.equal(params.get("framework"), "vitest");
    assert.equal(params.get("framework_version"), "4.1.12");
    assert.equal(params.get("framework_wrapper_version"), "0.1.0");
    assert.equal(params.get("test_map"), "select");
    assert.equal(params.get("test_map_record"), "");
    assert.equal(params.get("reconnect"), null);
    assert.equal(params.get("remove_failed"), "true");
    assert.equal(params.get("runtime_version").startsWith("v"), false);
    const metadata = JSON.parse(params.get("metadata"));
    assert.equal(metadata.branch, "main");
    for (const key of ["host", "runner_id", "api_key", "run_id", "run_attempt"]) {
      assert.equal(Object.hasOwn(metadata, key), false, key);
    }
    assert.equal(new URL(server.connections[0].url, server.origin).pathname, "/transport/websocket");

    server.send({ command: "print_notice", message: "hello-notice" });
    const manifest = await connectAndManifest({ server });
    assert.deepEqual(
      manifest.data.test_cases.map((item) => item.id),
      ["case-pass", "case-fail", "case-pend", "case-flake"],
    );
    for (const item of manifest.data.test_cases) {
      assert.equal(typeof item.run_time, "number");
      assert.equal(item.file_path, "tests/example.py");
    }
    assert.equal(manifest.data.test_map_tree, undefined);

    server.send({ command: "run_test_cases", test_case_ids: ["case-pass"] });
    const passed = await server.next();
    assert.equal(passed.type, "test_case_result");
    assert.equal(passed.data.id, "case-pass");
    assert.equal(passed.data.status, "passed");

    server.send({ command: "run_test_cases", test_case_ids: ["case-pend"] });
    const pending = await server.next();
    assert.equal(pending.data.status, "pending");
    assert.equal(pending.data.id, "case-pend");

    server.send({ command: "close", exit_status: null });
    const report = await server.next();
    assert.equal(report.type, "report_at_finish");
    assert.equal(report.data.connection_retries, 0);
    const outcome = await proc.exit();
    assert.equal(outcome.code, 0);
    assert.equal(readFileSync(log, "utf8"), "finish\n");
    assert.match(proc.stdout(), /hello-notice/);
  });
});

test("cross-runner remove clears a failure and an unknown id is ignored", async () => {
  await withClient(async ({ server, proc, log }) => {
    await connectAndManifest({ server });
    server.send({ command: "run_test_cases", test_case_ids: ["case-fail"] });
    const failed = await server.next();
    assert.equal(failed.data.status, "failed");
    assert.equal(failed.data.failure_formatted_backtrace[0].startsWith("tests/"), true);
    server.send({ command: "remove_failed_test_case_result", test_case_id: "missing-id" });
    server.send({ command: "remove_failed_test_case_result", test_case_id: "case-fail" });
    server.send({ command: "close", exit_status: null });
    const report = await server.next();
    assert.equal(report.data.connection_retries, 0);
    assert.equal((await proc.exit()).code, 0);
    assert.equal(readFileSync(log, "utf8"), "finish\n");
  });
});

test("manual rerun replaces a flake without a remove", async () => {
  await withClient(async ({ server, proc }) => {
    await connectAndManifest({ server });
    server.send({ command: "run_test_cases", test_case_ids: ["case-flake"] });
    assert.equal((await server.next()).data.status, "failed");
    server.send({ command: "run_test_cases", test_case_ids: ["case-flake"] });
    assert.equal((await server.next()).data.status, "passed");
    server.send({ command: "close", exit_status: null });
    await server.next();
    assert.equal((await proc.exit()).code, 0);
  });
});

test("auto-retry remove then assign replaces the failure", async () => {
  await withClient(async ({ server, proc }) => {
    await connectAndManifest({ server });
    server.send({ command: "run_test_cases", test_case_ids: ["case-flake"] });
    assert.equal((await server.next()).data.status, "failed");
    server.send({ command: "remove_failed_test_case_result", test_case_id: "case-flake" });
    server.send({ command: "run_test_cases", test_case_ids: ["case-flake"] });
    assert.equal((await server.next()).data.status, "passed");
    server.send({ command: "close", exit_status: null });
    await server.next();
    assert.equal((await proc.exit()).code, 0);
  });
});

test("reconnect command does not increment retries", async () => {
  await withClient(async ({ server, proc }) => {
    await connectAndManifest({ server });
    server.send({ command: "reconnect" });
    await server.until(
      () => server.connections.some((conn) => conn.url.includes("reconnect=true") && conn.ws?.readyState === 1),
      10000,
    );
    server.drain();
    server.send({ command: "connected" });
    server.send({ command: "run_test_cases", test_case_ids: ["case-pass"] });
    const result = await server.next();
    assert.equal(result.data.id, "case-pass");
    assert.equal(result.data.status, "passed");
    server.send({ command: "close", exit_status: null });
    const report = await server.next();
    assert.equal(report.data.connection_retries, 0);
    assert.equal((await proc.exit()).code, 0);
    assert.equal(queryOf(server.connections[0]).get("reconnect"), null);
  });
});

test("a failure survives a redial and a remove after the redial clears it", async () => {
  for (const remove of [false, true]) {
    await withClient(async ({ server, proc }) => {
      await connectAndManifest({ server });
      server.send({ command: "run_test_cases", test_case_ids: ["case-fail"] });
      assert.equal((await server.next()).data.status, "failed");
      server.send({ command: "reconnect" });
      await server.until(() => openConnections(server).some((conn) => conn.url.includes("reconnect=true")), 10000);
      assert.equal(queryOf(server.connections.at(-1)).get("remove_failed"), "true");
      server.send({ command: "connected" });
      if (remove) server.send({ command: "remove_failed_test_case_result", test_case_id: "case-fail" });
      server.send({ command: "close", exit_status: null });
      assert.equal((await server.next()).type, "report_at_finish");
      assert.equal((await proc.exit()).code, remove ? 0 : 1);
    });
  }
});

test("--log writes a session log, and a non-websocket host fails fast with the error block", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sel-log-"));
  try {
    await withClient(
      async ({ server, proc }) => {
        await connectAndManifest({ server });
        server.send({ command: "close", exit_status: null });
        await server.next();
        assert.equal((await proc.exit()).code, 0);
        const text = readFileSync(path.join(dir, "log", "runner-1.log"), "utf8");
        assert.match(text, /Received Command: {"command":"test_manifest"}/);
        assert.match(text, /Sending Response: test_manifest/);
      },
      { args: ["--log"], cwd: dir },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  await withClient(
    async ({ proc }) => {
      const started = Date.now();
      assert.equal((await proc.exit()).code, 1);
      assert.ok(Date.now() - started < 2000);
      assert.match(proc.stderr(), /contact support at https:\/\/selective\.ci\/support/);
      assert.match(proc.stderr(), /Invalid host: https:\/\/127\.0\.0\.1:9/);
    },
    { env: { SELECTIVE_HOST: "https://127.0.0.1:9" }, wait: false },
  );
});

test("socket drop reconnects with retries 1", async () => {
  await withClient(async ({ server, proc }) => {
    await connectAndManifest({ server });
    server.send({ command: "run_test_cases", test_case_ids: ["case-pass"] });
    server.drop();
    await server.until(
      () => server.connections.some((conn) => conn.url.includes("reconnect=true") && conn.ws?.readyState === 1),
      10000,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    server.drain();
    server.send({ command: "connected" });
    server.send({ command: "run_test_cases", test_case_ids: ["case-pend"] });
    let pending = null;
    for (let i = 0; i < 4 && !pending; i += 1) {
      const frame = await server.next();
      if (frame?.data?.id === "case-pend") pending = frame;
    }
    assert.equal(pending.data.status, "pending");
    server.send({ command: "close", exit_status: null });
    const report = await server.next();
    assert.equal(report.type, "report_at_finish");
    assert.equal(report.data.connection_retries, 1);
    assert.equal((await proc.exit()).code, 0);
  });
});

test("integer close is the process status and skips finish", async () => {
  await withClient(async ({ server, proc, log }) => {
    server.send({ command: "connected" });
    server.send({ command: "print_notice", message: "nope" });
    server.send({
      command: "close",
      exit_status: 2,
      error_code: "invalid_api_key",
      message: "nope",
    });
    const report = await server.next();
    assert.equal(report.data.connection_retries, 0);
    assert.equal((await proc.exit()).code, 2);
    assert.equal(proc.stdout().split("nope").length - 1, 1);
    assert.throws(() => readFileSync(log, "utf8"));
  });
});

test("integer close still wins after SIGTERM", async () => {
  await withClient(async ({ server, proc }) => {
    server.send({ command: "connected" });
    server.send({ command: "close", exit_status: 2, message: "nope" });
    const report = await server.next();
    assert.equal(report.type, "report_at_finish");
    proc.child.kill("SIGTERM");
    assert.equal((await proc.exit()).code, 2);
  });
});

test("null close after a failure exits 1 and runs finish", async () => {
  await withClient(async ({ server, proc, log }) => {
    await connectAndManifest({ server });
    server.send({ command: "run_test_cases", test_case_ids: ["case-fail"] });
    await server.next();
    server.send({ command: "close", exit_status: null });
    await server.next();
    assert.equal((await proc.exit()).code, 1);
    assert.equal(readFileSync(log, "utf8"), "finish\n");
  });
});

test("close exit_status 1 skips finish and exit_status 0 overrides a failure", async () => {
  await withClient(async ({ server, proc, log }) => {
    await connectAndManifest({ server });
    server.send({ command: "run_test_cases", test_case_ids: ["case-fail"] });
    await server.next();
    server.send({ command: "close", exit_status: 1, message: "incomplete" });
    await server.next();
    assert.equal((await proc.exit()).code, 1);
    assert.throws(() => readFileSync(log, "utf8"));
  });

  await withClient(async ({ server, proc, log }) => {
    await connectAndManifest({ server });
    server.send({ command: "run_test_cases", test_case_ids: ["case-fail"] });
    await server.next();
    server.send({ command: "close", exit_status: 0 });
    await server.next();
    assert.equal((await proc.exit()).code, 0);
    assert.throws(() => readFileSync(log, "utf8"));
  });
});

test("SIGTERM after a failure sends terminating and exits 1", async () => {
  await withClient(async ({ server, proc }) => {
    await connectAndManifest({ server });
    server.send({ command: "run_test_cases", test_case_ids: ["case-fail"] });
    assert.equal((await server.next()).data.status, "failed");
    proc.child.kill("SIGTERM");
    const frame = await server.next();
    assert.equal(frame.type, "terminating");
    assert.equal(frame.data.signal, "TERM");
    assert.equal((await proc.exit()).code, 1);
  });
});

test("SIGTERM with no failures exits 0", async () => {
  await withClient(async ({ server, proc }) => {
    server.send({ command: "connected" });
    proc.child.kill("SIGTERM");
    const frame = await server.next();
    assert.equal(frame.type, "terminating");
    assert.equal(frame.data.signal, "TERM");
    assert.equal((await proc.exit()).code, 0);
  });
});

test("three run commands stay in order", async () => {
  await withClient(async ({ server, proc }) => {
    await connectAndManifest({ server });
    server.send({ command: "run_test_cases", test_case_ids: ["case-pass", "case-fail"] });
    server.send({ command: "run_test_cases", test_case_ids: ["case-pend"] });
    server.send({ command: "run_test_cases", test_case_ids: ["case-flake"] });
    const statuses = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await server.next()).data);
    assert.deepEqual(
      statuses.map((item) => [item.id, item.status]),
      [
        ["case-pass", "passed"],
        ["case-fail", "failed"],
        ["case-pend", "pending"],
        ["case-flake", "failed"],
      ],
    );
    server.send({ command: "close", exit_status: null });
    const report = await server.next();
    assert.equal(report.data.connection_retries, 0);
    assert.equal((await proc.exit()).code, 1);
  });
});

test("frames before connected are queued", async () => {
  await withClient(async ({ server, proc, log }) => {
    server.send({ command: "test_manifest" });
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(server.pending(), 0);
    server.send({ command: "connected" });
    const manifest = await server.next();
    assert.equal(manifest.type, "test_manifest");
    assert.deepEqual(
      manifest.data.test_cases.map((item) => item.id),
      ["case-pass", "case-fail", "case-pend", "case-flake"],
    );
    server.send({ command: "close", exit_status: null });
    const report = await server.next();
    assert.equal(report.data.connection_retries, 0);
    assert.equal((await proc.exit()).code, 0);
    assert.equal(readFileSync(log, "utf8"), "finish\n");
  });
});

test("unknown commands are ignored unless --debug", async () => {
  await withClient(async ({ server, proc }) => {
    server.send({ command: "connected" });
    server.send({ command: "not_a_real_command", extra: 1 });
    const manifest = await connectAndManifest({ server });
    assert.equal(caseById(manifest, "case-pass").id, "case-pass");
    server.send({ command: "run_test_cases", test_case_ids: ["case-pass"] });
    assert.equal((await server.next()).data.status, "passed");
    server.send({ command: "close", exit_status: null });
    await server.next();
    assert.equal((await proc.exit()).code, 0);
  });

  await withClient(
    async ({ server, proc }) => {
      server.send({ command: "connected" });
      server.send({ command: "not_a_real_command" });
      assert.equal((await proc.exit()).code, 1);
      assert.match(proc.stderr(), /unknown command/);
    },
    { args: ["--debug"] },
  );
});

test("eleven rejected handshakes exit 1 and do not try a twelfth", async () => {
  const server = await startMock();
  server.reject(11);
  const proc = spawnNode(
    client,
    [],
    selectiveEnv({ SELECTIVE_HOST: server.origin }),
  );
  try {
    const outcome = await proc.exit(60000);
    assert.equal(outcome.code, 1);
    assert.equal(server.connections.length, 11);
    assert.equal(server.connections.every((conn) => conn.rejected), true);
    assert.match(proc.stderr(), /giving up after 11/);
  } finally {
    await server.close();
  }
});

test("record and tree warn once and upload nothing", async () => {
  await withClient(async ({ server, proc }) => {
    server.send({ command: "connected" });
    server.send({
      command: "configure_test_map",
      tree: true,
      record: true,
      allocations: true,
    });
    server.send({ command: "test_manifest" });
    const manifest = await server.next();
    assert.equal(manifest.type, "test_manifest");
    for (const key of ["sha", "prefix", "files", "dirty"]) {
      assert.ok(Object.hasOwn(manifest.data.test_map_tree, key));
    }
    assert.equal(typeof manifest.data.test_map_tree.files, "object");
    assert.ok(Array.isArray(manifest.data.test_map_tree.dirty));
    server.send({ command: "configure_test_map", tree: false });
    server.send({ command: "test_manifest" });
    assert.equal(Object.hasOwn((await server.next()).data, "test_map_tree"), false);
    server.send({ command: "run_test_cases", test_case_ids: ["case-pass"] });
    assert.equal((await server.next()).data.status, "passed");
    server.send({ command: "close", exit_status: null });
    await server.next();
    assert.equal((await proc.exit()).code, 0);
    assert.equal(server.fragments.length, 0);
    assert.equal(proc.stderr().split("recording is unavailable").length - 1, 1);
  });
});

test("a failing fragment upload is tried three times, warns, and keeps the exit status", async () => {
  await withClient(
    async ({ server, proc }) => {
      server.failUploads(500);
      server.send({ command: "connected" });
      server.send({ command: "configure_test_map", record: true });
      server.send({ command: "test_manifest" });
      assert.equal((await server.next()).type, "test_manifest");
      server.send({ command: "run_test_cases", test_case_ids: ["case-pass"] });
      assert.equal((await server.next()).data.status, "passed");
      server.send({ command: "close", exit_status: null });
      await server.next();
      assert.equal((await proc.exit(30000)).code, 0);
      assert.equal(server.fragments.length, 3);
      const spread = (server.fragments[2].at - server.fragments[0].at) / 1000;
      assert.ok(spread >= 3 && spread < 6, `${spread}s between the first and third POST`);
      assert.match(proc.stderr(), /could not upload this runner's test map \(.*HTTP 500/);
      assert.equal(proc.stderr().includes("recording is unavailable"), false);
    },
    { env: { SELECTIVE_FAKE_DEP: path.join(repoRoot, "README.md") } },
  );
});

test("a frame that is not JSON exits 1", async () => {
  await withClient(async ({ server, proc }) => {
    await connectAndManifest({ server });
    server.sendRaw("{this is not json");
    assert.equal((await proc.exit()).code, 1);
    assert.match(proc.stderr(), /could not parse a message from the server .*\{this is not json/);
  });
});

test("an id that was not collected fails and the batch continues", async () => {
  await withClient(async ({ server, proc }) => {
    await connectAndManifest({ server });
    server.send({ command: "run_test_cases", test_case_ids: ["not-collected", "case-pass"] });
    const missing = await server.next();
    const passed = await server.next();
    assert.equal(missing.data.status, "failed");
    assert.match(missing.data.failure_message_lines[0], /not collected/);
    assert.equal(missing.data.file_path, "not-collected");
    assert.deepEqual(missing.data.failure_formatted_backtrace, []);
    assert.equal(passed.data.id, "case-pass");
    assert.equal(passed.data.status, "passed");
    server.send({ command: "remove_failed_test_case_result", test_case_id: "not-collected" });
    server.send({ command: "close", exit_status: null });
    await server.next();
    assert.equal((await proc.exit()).code, 0);
  });
});

test("disable forces test_map 0 and record is forwarded raw", async () => {
  await withClient(
    async ({ server, proc }) => {
      assert.equal(queryOf(server.connections[0]).get("test_map"), "0");
      assert.equal(queryOf(server.connections[0]).get("test_map_record"), "raw-value");
      server.send({ command: "connected" });
      server.send({ command: "close", exit_status: null });
      await server.next();
      assert.equal((await proc.exit()).code, 0);
    },
    {
      env: {
        SELECTIVE_TEST_MAP_DISABLE: "1",
        SELECTIVE_TEST_MAP_RECORD: "raw-value",
      },
    },
  );
});

test("keepalive pings use the forwarded interval", async () => {
  await withClient(
    async ({ server, proc }) => {
      await new Promise((resolve) => setTimeout(resolve, 900));
      assert.ok(server.pings() >= 1, `pings ${server.pings()}`);
      assert.equal(openConnections(server).length, 1);
      server.send({ command: "connected" });
      server.send({ command: "test_manifest" });
      const frame = await server.next();
      assert.equal(frame.type, "test_manifest");
      server.send({ command: "close", exit_status: 0 });
      await server.next();
      assert.equal((await proc.exit()).code, 0);
    },
    {
      env: {
        SELECTIVE_WS_PING_INTERVAL_MS: "200",
        SELECTIVE_WS_PONG_TIMEOUT_MS: "1000",
      },
    },
  );
});

test("a missing transport binary exits 1 without connecting", async () => {
  const server = await startMock();
  server.reject(5);
  const proc = spawnNode(
    client,
    [],
    selectiveEnv({
      SELECTIVE_HOST: server.origin,
      SELECTIVE_TRANSPORT: "/no/such/selective-transport",
    }),
  );
  try {
    const outcome = await proc.exit(8000);
    assert.equal(outcome.code, 1);
    assert.match(proc.stderr(), /Install @selectiveci\/transport-linux-x64, or set SELECTIVE_TRANSPORT/);
    assert.equal(server.connections.length, 0);
  } finally {
    await server.close();
  }
});
