import {
  CONNECTED_TIMEOUT_MS,
  retriesExhausted,
  retryDelay,
  TERMINATION_GRACE_MS,
} from "./retry.js";
import { correlateTestFiles, diffTestFiles } from "./git.js";
import { loadEnvironment, missingSelectiveNames, buildWebsocketUrl } from "./env.js";
import { snapshotFailure, snapshotTree } from "./snapshot.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { errorBlock, sanitize } from "./text.js";
import { buildFragment, uploadFragment } from "./testmap.js";
import { missingTransportMessage, openStdio } from "./transport.js";

export async function runSession({ adapter, debug = false, log = false, cwd = process.cwd() }) {
  const holder = {
    link: null,
    overrideStatus: null,
    results: new Map(),
    signalled: false,
    adapter,
  };
  const onSignal = async (name) => {
    if (holder.signalled) return;
    holder.signalled = true;
    const code = (process.exitCode = processStatus(holder));
    try {
      holder.link?.send({ type: "terminating", data: { signal: name } });
      await new Promise((resolve) => setTimeout(resolve, TERMINATION_GRACE_MS));
      holder.link?.close();
    } finally {
      process.exit(code);
    }
  };
  process.on("SIGTERM", () => onSignal("TERM"));
  process.on("SIGINT", () => onSignal("INT"));

  let env;
  try {
    env = loadEnvironment(cwd);
  } catch (err) {
    console.error(errorBlock(err.missingTransport ? missingTransportMessage() : err.message));
    return 1;
  }
  const missing = missingSelectiveNames(env);
  if (missing.length) {
    console.error(errorBlock(`Missing required environment variables: ${missing.join(", ")}`));
    return 1;
  }
  if (!/^wss?:\/\//.test(env.host)) {
    console.error(errorBlock(`Invalid host: ${env.host}`));
    return 1;
  }
  const logLine = log ? openLog(env.runner_id) : () => {};
  try {
    await adapter.start();
  } catch (err) {
    if (debug) throw err;
    console.error(errorBlock(err.message));
    return 1;
  }

  const state = {
    tree: false,
    warnedRecord: false,
    connectionRetries: 0,
    manifest: null,
    ordering: null,
  };
  let failures = 0;
  let reconnect = false;
  while (!holder.signalled) {
    const versions = adapter.versions();
    versions.testMapRecord = process.env.SELECTIVE_TEST_MAP_RECORD;
    const url = buildWebsocketUrl({ env, versions, reconnect });
    const link = openStdio(url);
    holder.link = link;
    const ctx = { link, state, holder, adapter, env, url, debug, cwd, logLine };
    let outcome;
    try {
      outcome = await drive(ctx);
    } catch (err) {
      if (holder.signalled) return stayUntilExit();
      if (debug) throw err;
      console.error(errorBlock(err.message));
      link.close();
      return 1;
    }
    if (holder.signalled) return stayUntilExit();
    if (outcome === "lost") {
      link.close();
      failures += 1;
      state.connectionRetries = failures;
      if (retriesExhausted(failures)) {
        console.error(`giving up after ${failures} connection failures`);
        return 1;
      }
      await delay(retryDelay(failures));
      reconnect = true;
      continue;
    }
    if (outcome === "reconnect") {
      link.close();
      reconnect = true;
      continue;
    }
    link.close();
    return outcome;
  }
  return stayUntilExit();
}

async function drive(ctx) {
  const { link, holder } = ctx;
  const queued = [];
  const connected = await waitConnected(link, queued);
  if (connected === "lost") return "lost";
  if (connected === "timeout") return 1;
  while (!holder.signalled) {
    const command = queued.length ? queued.shift() : await readCommand(link);
    if (command === "lost") return "lost";
    if (!command) continue;
    ctx.logLine(`Received Command: ${JSON.stringify(command)}`);
    const action = await dispatch(ctx, command);
    if (holder.signalled) return stayUntilExit();
    if (action !== "continue") return action;
  }
  return stayUntilExit();
}

async function waitConnected(link, queued) {
  const deadline = Date.now() + CONNECTED_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const remaining = Math.max(deadline - Date.now(), 1);
    const command = await readCommand(link, remaining);
    if (command === "lost") return "lost";
    if (command === "timeout") {
      console.error("timed out waiting for connected");
      return "timeout";
    }
    if (!command) continue;
    if (command.command === "connected") return "ok";
    queued.push(command);
  }
  console.error("timed out waiting for connected");
  return "timeout";
}

async function readCommand(link, timeoutMs) {
  const incoming = timeoutMs == null ? link.recv() : timeout(link.recv(), timeoutMs);
  const line = await incoming;
  if (line === "timeout") return "timeout";
  if (line == null) return "lost";
  const trimmed = String(line).trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`selective could not parse a message from the server (${err.message}): ${trimmed.slice(0, 200)}`);
  }
}

async function dispatch(ctx, command) {
  const { state, holder, adapter, debug } = ctx;
  switch (command.command) {
    case "configure_test_map":
      if (command.record === true && !adapter.record() && !state.warnedRecord) {
        state.warnedRecord = true;
        console.error("selective: test map recording is unavailable; continuing with select");
      }
      state.tree = command.tree === true;
      return "continue";
    case "test_manifest":
      return sendManifest(ctx);
    case "run_test_cases":
      return runBatch(ctx, command.test_case_ids ?? []);
    case "remove_failed_test_case_result":
      if (typeof command.test_case_id === "string") {
        holder.results.delete(command.test_case_id);
        adapter.prepare(command.test_case_id);
      }
      return "continue";
    case "reconnect":
      return "reconnect";
    case "close":
      return closeSession(ctx, command);
    case "print_notice":
    case "print_message":
      if (typeof command.message === "string") console.log(command.message);
      return "continue";
    case "connected":
      return "continue";
    default:
      if (debug) {
        console.error(`selective: unknown command ${command.command ?? ""}`);
        return 1;
      }
      return "continue";
  }
}

async function sendManifest(ctx) {
  const { state, adapter, env, cwd } = ctx;
  if (!state.manifest) {
    const discovered = await adapter.discover();
    if (!discovered.testCases.length) {
      console.error(discovered.reason || "No tests found");
      return 1;
    }
    state.manifest = discovered.testCases;
    state.ordering = orderManifest({
      cwd,
      env,
      suiteRoot: adapter.suiteRoot(),
      testCases: discovered.testCases,
    });
  }
  const ordered = applyOrder(state.manifest, state.ordering?.modified);
  const data = { test_cases: ordered };
  if (state.tree) {
    const snap = snapshotTree(cwd);
    if (snap.ok) data.test_map_tree = snap.tree;
    else console.error(`selective: ${snapshotFailure(snap)}`);
  }
  if (state.ordering?.ok) {
    data.modified_test_files = state.ordering.modified;
    if (state.ordering.correlated) data.correlated_files = state.ordering.correlated;
  } else if (state.ordering?.warning) {
    console.error(`selective: ${state.ordering.warning}`);
  }
  if (!send(ctx, { type: "test_manifest", data })) return "lost";
  return "continue";
}

function orderManifest({ cwd, env, suiteRoot, testCases }) {
  if (!env.target_branch) return { ok: false };
  const knownTests = new Set(testCases.map((testCase) => testCase.file_path));
  const diff = diffTestFiles({
    cwd,
    targetBranch: env.target_branch,
    suiteRoot,
    knownTests,
  });
  if (!diff.ok) return diff;
  const correlated = correlateTestFiles({
    cwd,
    targetBranch: env.target_branch,
    suiteRoot,
    knownTests,
    sources: diff.sources,
  });
  return { ok: true, modified: diff.files, correlated };
}

function applyOrder(testCases, modified) {
  if (!modified?.length) return testCases;
  const rank = new Map(modified.map((file, index) => [file, index]));
  const order = (testCase) => rank.get(testCase.file_path) ?? modified.length;
  return testCases.toSorted((left, right) => order(left) - order(right));
}

async function runBatch(ctx, ids) {
  const { holder, adapter } = ctx;
  await adapter.discover();
  const report = (data) => {
    holder.results.set(data.id, data);
    const unsent = () => {
      if (holder.results.get(data.id) === data) holder.results.delete(data.id);
    };
    if (send(ctx, { type: "test_case_result", data }, unsent)) return true;
    unsent();
    return false;
  };
  const runnable = [];
  for (const id of ids) {
    if (!adapter.has(id)) {
      if (!report(missingResult(id))) return "lost";
      continue;
    }
    holder.results.delete(id);
    adapter.prepare(id);
    runnable.push(id);
  }
  let lost = false;
  await adapter.run(runnable, (result) => {
    if (lost) return;
    lost = !report(result);
    if (lost) adapter.cancel();
  });
  if (lost) return "lost";
  for (const id of runnable) {
    if (holder.results.has(id)) continue;
    if (!report(missingResult(id, "test produced no result"))) return "lost";
  }
  return "continue";
}

async function closeSession(ctx, command) {
  const { state, holder, adapter } = ctx;
  if (Number.isInteger(command.exit_status)) holder.overrideStatus = command.exit_status;
  const data = {
    connection_retries: state.connectionRetries,
    ...adapter.hookSeconds(),
  };
  if (!send(ctx, { type: "report_at_finish", data })) return "lost";
  await adapter.flushReporters();
  if (holder.overrideStatus == null) await adapter.finish();
  await uploadTestMap(ctx);
  return processStatus(holder);
}

async function uploadTestMap({ adapter, env, cwd }) {
  const deps = adapter.recordedDeps();
  if (!deps.size) return;
  const error = await uploadFragment(env, buildFragment(deps, cwd));
  if (error != null) {
    console.error(`Selective could not upload this runner's test map (${error}). Its tests will run on the next build rather than be skipped.`);
  }
}

function missingResult(id, message = `test was not collected: ${id}`) {
  return {
    id,
    description: id,
    full_description: id,
    status: "failed",
    file_path: id,
    line_number: 1,
    run_time: 0,
    pending_message: null,
    failure_message_lines: [message],
    failure_formatted_backtrace: [],
  };
}

function send(ctx, value, unsent) {
  ctx.logLine(`Sending Response: ${value.type}${value.data?.id ? `: ${value.data.id}` : ""}`);
  return ctx.link.send(sanitize(value), unsent);
}

function openLog(runnerId) {
  mkdirSync("log", { recursive: true });
  return (line) => appendFileSync(`log/${runnerId}.log`, `${new Date().toISOString()} ${line}\n`);
}

function processStatus(holder) {
  if (Number.isInteger(holder.overrideStatus)) return holder.overrideStatus;
  if (holder.adapter.failedOutsideTests()) return 1;
  for (const result of holder.results.values()) {
    if (result.status === "failed") return 1;
  }
  return 0;
}

function stayUntilExit() {
  return new Promise(() => {});
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeout(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), ms);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}
