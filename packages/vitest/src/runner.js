import inspector from "node:inspector/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inject, TestRunner } from "vitest";

const CLIENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const running = new Set();
const shared = new Set();
let profiler = null;
let traceError = null;

export default class SelectiveTestRunner extends TestRunner {
  async onBeforeCollect(paths) {
    await super.onBeforeCollect?.(paths);
    if (inject("selectiveRecord")) await takeCoverage();
  }

  async onBeforeRunSuite(suite) {
    await super.onBeforeRunSuite(suite);
    const hooks = TestRunner.getSuiteHooks(suite);
    const afterAll = hooks.afterAll.map((hook) => perTest(hook, suite, "selectiveAfterAll"));
    hooks.aroundEach = [
      ...hooks.aroundAll.map((hook) => Object.assign((use) => hook(use, suite), hook)),
      ...hooks.aroundEach,
    ];
    hooks.beforeEach = [
      ...hooks.beforeAll.map((hook) => perTest(hook, suite, "selectiveBeforeAll")),
      ...hooks.beforeEach,
    ];
    hooks.afterEach =
      this.config.sequence.hooks === "stack"
        ? [...afterAll, ...hooks.afterEach]
        : [...hooks.afterEach, ...afterAll];
    hooks.aroundAll = [];
    hooks.beforeAll = [];
    hooks.afterAll = [];
  }

  async onBeforeRunTask(test) {
    await super.onBeforeRunTask(test);
    if (inject("selectiveRecord") && (test.mode === "run" || test.mode === "queued") && test.result?.state !== "fail") {
      if (running.size) for (const id of [...running, test.id]) shared.add(id);
      running.add(test.id);
      await takeCoverage();
    }
    test.meta.selectiveStart = performance.timeOrigin + performance.now();
  }

  async onAfterRunTask(test) {
    super.onAfterRunTask(test);
    test.meta.selectiveEnd = performance.timeOrigin + performance.now();
    if (!running.has(test.id)) return;
    const scripts = await takeCoverage();
    running.delete(test.id);
    if (shared.delete(test.id)) return;
    if (traceError) {
      test.meta.selectiveTraceError = traceError;
      return;
    }
    test.meta.selectiveDeps = [...new Set(scripts.filter(ran).map((script) => scriptPath(script.url)).filter(projectFile))];
  }
}

async function takeCoverage() {
  if (traceError) return null;
  try {
    profiler ??= startProfiler();
    const session = await profiler;
    return (await session.post("Profiler.takePreciseCoverage")).result;
  } catch (err) {
    traceError = err?.message || String(err);
    return null;
  }
}

async function startProfiler() {
  const session = new inspector.Session();
  session.connect();
  await session.post("Profiler.enable");
  await session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: false });
  return session;
}

function ran(script) {
  return script.functions.some((fn) => fn.ranges[0].count > 0);
}

function scriptPath(url) {
  if (url.startsWith("file://")) return fileURLToPath(url.replace(/[?#].*$/, ""));
  return path.isAbsolute(url) ? url : null;
}

function projectFile(file) {
  return file && !file.split(path.sep).includes("node_modules") && !file.startsWith(`${CLIENT_DIR}${path.sep}`);
}

function perTest(hook, suite, key) {
  return Object.assign(async (context) => {
    const start = performance.now();
    try {
      return await hook(suite);
    } finally {
      context.task.meta[key] = (context.task.meta[key] ?? 0) + (performance.now() - start) / 1000;
    }
  }, hook);
}
