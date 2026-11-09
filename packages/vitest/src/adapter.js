import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { createVitest, parseCLI, version as vitestVersion } from "vitest/node";

const RUNNER = fileURLToPath(new URL("./runner.js", import.meta.url));
const PROGRESS = { passed: "✓", failed: "×", pending: "↓" };
const SIGNALS = ["SIGTERM", "SIGINT"];

export function vitestVersionAllowed(version) {
  const [major, minor, patch] = version.split(/[.-]/).map(Number);
  return major === 5 || (major === 4 && (minor > 1 || (minor === 1 && patch >= 1)));
}

export function createVitestAdapter({ cwd, argv, coreVersion, wrapperVersion, execMode = false }) {
  return new VitestAdapter({ cwd, argv, coreVersion, wrapperVersion, execMode });
}

class VitestAdapter {
  constructor({ cwd, argv, coreVersion, wrapperVersion, execMode }) {
    this.cwd = cwd;
    this.argv = argv;
    this.coreVersion = coreVersion;
    this.wrapperVersion = wrapperVersion;
    this.execMode = execMode;
    this.frameworkPackageVersion = vitestVersion;
    this.cached = null;
    this.byId = new Map();
    this.passed = new Set();
    this.active = null;
    this.clock = 0;
    this.startupShare = null;
    this.onResult = null;
    this.vitest = null;
    this.root = cwd;
    this.filters = [];
    this.beforeAllSeconds = 0;
    this.afterAllSeconds = 0;
    this.blamed = new Set();
    this.collectionFailure = false;
    this.userReporters = [];
    this.reportFiles = new Map();
    this.canRecord = false;
    this.deps = new Map();
    this.traceError = null;
    this.reporter = {
      onTestCaseResult: (testCase) => this.onTestCaseResult(testCase),
      onUserConsoleLog: (log) => this.onUserConsoleLog(log),
    };
  }

  frameworkVersion() {
    return this.frameworkPackageVersion;
  }

  testMap() {
    if (/^(1|true|yes)$/i.test(process.env.SELECTIVE_TEST_MAP_DISABLE ?? "")) return "0";
    return this.canRecord ? "record" : "select";
  }

  start() {
    return this.ensureStarted();
  }

  record() {
    if (this.canRecord) this.vitest.provide("selectiveRecord", true);
    return this.canRecord;
  }

  recordedDeps() {
    return this.traceError ? new Map() : this.deps;
  }

  versions() {
    return {
      language: "javascript",
      core: this.coreVersion,
      framework: "vitest",
      frameworkVersion: this.frameworkVersion(),
      wrapper: this.wrapperVersion,
      runtime: process.versions.node,
      testMap: this.testMap(),
    };
  }

  suiteRoot() {
    return path.relative(this.cwd, this.root);
  }

  async exec() {
    const discovered = await this.discover();
    if (!discovered.testCases.length) {
      console.error(discovered.reason || "No tests found");
      await this.finish();
      return 1;
    }
    console.log(JSON.stringify({ test_cases: discovered.testCases }, null, 2));
    await this.finish();
    return discovered.failed ? 1 : 0;
  }

  async discover() {
    if (this.cached) return this.cached;
    await this.ensureStarted();
    const specs = await this.vitest.globTestSpecifications(this.filters);
    if (!specs.length) {
      this.cached = {
        testCases: [],
        reason: `No test files found from ${this.cwd}`,
        failed: false,
      };
      return this.cached;
    }
    let collected;
    try {
      collected = await this.vitest.collectTests(specs);
    } catch (err) {
      this.collectionFailure = true;
      const reason = err?.message || String(err);
      console.error(`selective: collection failed: ${reason}`);
      this.cached = {
        testCases: [failedFileCase(this.cwd, "collection", reason)],
        reason,
        failed: true,
      };
      this.index(this.cached.testCases);
      return this.cached;
    }
    const collectedByKey = new Map(
      collected.testModules.map((mod) => [moduleKey(mod.project.name, mod.moduleId), mod]),
    );
    let cases = [];
    for (const spec of specs) {
      const key = moduleKey(spec.project.name, spec.moduleId);
      const mod = collectedByKey.get(key);
      if (!mod) {
        this.noteCollectionFailure(spec.moduleId, "was not collected");
        cases.push(failedFileCase(this.cwd, spec.moduleId, "was not collected"));
        continue;
      }
      const tests = [...mod.children.allTests()];
      const errors = moduleHookErrors(mod);
      if (!tests.length && (!mod.ok() || errors.length)) {
        const message = errorText(errors) || `${relativeToCwd(this.cwd, spec.moduleId)} failed during collection`;
        this.noteCollectionFailure(spec.moduleId, message);
        cases.push(failedFileCase(this.cwd, spec.moduleId, message, spec.project));
        continue;
      }
      for (const testCase of tests) {
        const item = this.toCase(testCase);
        const early = testCase.result();
        if (early.state === "failed") {
          const message = errorText(early.errors) || "failed during collection";
          this.noteCollectionFailure(testCase.module.moduleId, message);
          item.collectionError = message.split("\n").filter(Boolean);
        }
        cases.push(item);
      }
    }
    const pattern = this.namePattern();
    if (pattern) {
      cases = cases.filter(
        (testCase) =>
          testCase.collectionError ||
          pattern.test(testCase.full_description) ||
          pattern.test(testCase.description),
      );
    }
    this.index(cases);
    const testCases = cases.map(publicCase);
    this.cached = {
      testCases,
      reason: testCases.length ? "" : "No tests matched the filters",
      failed: this.collectionFailure,
    };
    return this.cached;
  }

  index(cases) {
    this.byId = new Map(cases.map((testCase) => [testCase.id, testCase]));
  }

  noteCollectionFailure(moduleId, message) {
    this.collectionFailure = true;
    console.error(
      `selective: ${relativeToCwd(this.cwd, moduleId)} failed during collection: ${message}`,
    );
  }

  has(id) {
    return this.byId.has(id);
  }

  prepare(id) {
    this.passed.delete(id);
    this.blamed.delete(id);
  }

  async run(ids, onResult) {
    const runs = [[]];
    for (const id of ids) {
      if (runs.at(-1).includes(id)) runs.push([]);
      runs.at(-1).push(id);
    }
    for (const unique of runs) await this.runOnce(unique, onResult);
  }

  async runOnce(ids, onResult) {
    this.onResult = onResult;
    this.active = new Map();
    const modules = new Map();
    for (const id of ids) {
      const record = this.byId.get(id);
      if (record.collectionError) {
        onResult(failedPayload(record));
        continue;
      }
      this.active.set(record.vitestId, record);
      const key = moduleKey(record.project.name, record.moduleId);
      if (!modules.has(key)) modules.set(key, { record, testIds: [] });
      modules.get(key).testIds.push(record.vitestId);
    }
    if (!modules.size) return;
    const specs = [...modules.values()].map(({ record, testIds }) =>
      record.project.createSpecification(record.moduleId, { testIds }),
    );
    this.clock = performance.timeOrigin + performance.now();
    this.startupShare = null;
    const outcome = await this.vitest.runTestSpecifications(specs, false);
    const records = [...this.active.values()];
    this.active = null;
    for (const mod of outcome.testModules) {
      const key = moduleKey(mod.project.name, mod.moduleId);
      const inModule = records.filter((record) => moduleKey(record.project.name, record.moduleId) === key);
      for (const error of moduleHookErrors(mod)) this.blame(error, inModule);
    }
    for (const error of outcome.unhandledErrors) {
      const inFile = records.filter((record) => record.moduleId === error.VITEST_TEST_PATH);
      const named = inFile.filter((record) => record.description === error.VITEST_TEST_NAME);
      this.blame(error, named.length ? named : inFile.length ? inFile : records);
    }
  }

  cancel() {
    return this.vitest.cancelCurrentRun("selective lost its connection");
  }

  blame(error, records) {
    const files = [...new Set(records.map((record) => record.file_path))].join(", ");
    const names = records.map((record) => record.full_description).join(", ");
    console.error(`selective: error outside a test in ${files}: ${error.message ?? error} (fails ${names})`);
    for (const record of records) this.blamed.add(record.id);
  }

  async flushReporters() {
    const modules = [...this.reportFiles.values()].map((cases) => {
      const latest = [...cases.values()];
      const module = latest.at(-1).module;
      const tasks = latest.map((testCase) => testCase.task);
      const state = tasks.some((task) => task.result?.state === "fail") ? "fail" : "pass";
      const task = { ...module.task, tasks, result: { ...module.task.result, state } };
      return Object.create(module, { task: { value: task } });
    });
    const failed = this.failedOutsideTests() || modules.some((mod) => mod.task.result.state === "fail");
    const reason = failed ? "failed" : "passed";
    for (const reporter of this.userReporters) await reporter.onTestRunEnd?.(modules, [], reason);
  }

  async finish() {
    await this.vitest?.close();
  }

  hookSeconds() {
    return {
      seconds_in_before_all_hooks: roundSeconds(this.beforeAllSeconds),
      seconds_in_after_all_hooks: roundSeconds(this.afterAllSeconds),
    };
  }

  failedOutsideTests() {
    return this.blamed.size > 0;
  }

  async ensureStarted() {
    if (this.vitest) return;
    const parsed = parseCLI(["vitest", ...this.argv]);
    this.filters = parsed.filter;
    const options = parsed.options;
    if (options.shard || options.changed) {
      console.error("selective: ignoring --shard and --changed");
    }
    options.watch = true;
    options.run = false;
    options.standalone = true;
    options.fileParallelism = false;
    options.maxWorkers = 1;
    options.isolate = false;
    options.includeTaskLocation = true;
    if (this.execMode) {
      options.silent = true;
      options.coverage = { enabled: false };
    } else {
      options.coverage = { ...options.coverage, cleanOnRerun: false, reportOnFailure: true };
    }
    delete options.shard;
    delete options.changed;
    delete options.related;
    const before = new Map(["exit", ...SIGNALS].map((event) => [event, process.listeners(event)]));
    this.vitest = await createVitest("test", options, { server: { watch: null } }, this.execMode ? { stdout: process.stderr } : {});
    for (const project of this.vitest.projects) {
      if (project.config.runner) {
        throw new Error(`selective: test.runner (${project.config.runner}) is not supported; Selective runs Vitest with its own runner`);
      }
      project.config.runner = RUNNER;
    }
    await this.vitest.standalone();
    const vitestExit = process.listeners("exit").filter((listener) => !before.get("exit").includes(listener));
    for (const signal of SIGNALS) {
      for (const listener of process.listeners(signal)) {
        if (vitestExit.includes(listener) && !before.get(signal).includes(listener)) process.removeListener(signal, listener);
      }
    }
    this.userReporters = [...this.vitest.reporters];
    this.vitest.reporters = [this.reporter];
    this.root = this.vitest.config.root || this.cwd;
    const coverage = this.vitest.config.coverage;
    this.canRecord =
      !this.execMode &&
      !process.env.NODE_V8_COVERAGE &&
      !(coverage.enabled && coverage.provider === "v8") &&
      !this.vitest.projects.some((project) => project.config.browser.enabled);
  }

  namePattern() {
    return this.vitest.getGlobalTestNamePattern();
  }

  toCase(testCase) {
    const moduleId = testCase.module.moduleId;
    return {
      id: testCase.id,
      vitestId: testCase.id,
      moduleId,
      project: testCase.project,
      file_path: relativeToCwd(this.cwd, moduleId),
      line_number: testCase.location?.line ?? 0,
      description: testCase.name,
      full_description: testCase.fullName,
      run_time: 0,
    };
  }

  onTestCaseResult(testCase) {
    const record = this.active?.get(testCase.id);
    if (!record) return;
    const meta = testCase.meta();
    if (meta.selectiveTraceError && !this.traceError) {
      this.traceError = meta.selectiveTraceError;
      console.error(`selective: test map recording stopped (${this.traceError}); tests run normally and this runner uploads no test map`);
    }
    if (meta.selectiveDeps) {
      const deps = this.deps.get(record.id) ?? new Set();
      for (const file of meta.selectiveDeps) deps.add(file);
      this.deps.set(record.id, deps);
    }
    const end = Math.max(meta.selectiveEnd ?? meta.selectiveStart ?? this.clock, this.clock);
    if (this.startupShare == null) {
      const startup = Math.max((meta.selectiveStart ?? end) - this.clock, 0);
      this.startupShare = startup / this.active.size;
      this.clock += startup;
    }
    const runTime = (end - this.clock + this.startupShare) / 1000;
    this.clock = end;
    this.beforeAllSeconds += meta.selectiveBeforeAll ?? 0;
    this.afterAllSeconds += meta.selectiveAfterAll ?? 0;
    const outcome = testCase.result();
    const suiteErrors = ancestorErrors(testCase);
    let status =
      outcome.state === "passed"
        ? "passed"
        : outcome.state === "failed"
          ? "failed"
          : "pending";
    if (status === "pending" && suiteErrors.length) status = "failed";
    if (status === "pending" && this.passed.has(record.id)) return;
    if (status === "passed") this.passed.add(record.id);
    else this.passed.delete(record.id);
    const payload = {
      id: record.id,
      description: record.description,
      full_description: record.full_description,
      status,
      file_path: record.file_path,
      line_number: record.line_number || testCase.location?.line || 0,
      run_time: runTime,
      pending_message: status === "pending" ? outcome.note || null : null,
    };
    if (status === "failed") {
      const fields = failureFields(record, outcome, this.cwd);
      if (suiteErrors.length && !(outcome.errors ?? []).length) {
        fields.failure_message_lines = suiteErrors.flatMap((error) =>
          String(error.message || error).split("\n"),
        );
      }
      Object.assign(payload, fields);
    }
    if (this.vitest.config.silent === "passed-only" && status === "failed") {
      for (const log of testCase.task.logs ?? []) writeLog(log);
    }
    console.log(`${PROGRESS[status]} ${record.file_path} > ${record.full_description} ${Math.round(runTime * 1000)}ms`);
    this.rememberReport(testCase);
    this.onResult?.(payload);
  }

  onUserConsoleLog(log) {
    const silent = this.vitest.config.silent;
    if (silent === true || silent === "passed-only") return;
    writeLog(log);
  }

  rememberReport(testCase) {
    const key = moduleKey(testCase.project.name, testCase.module.moduleId);
    if (!this.reportFiles.has(key)) this.reportFiles.set(key, new Map());
    this.reportFiles.get(key).set(testCase.id, testCase);
  }
}

function writeLog(log) {
  const text = log.content;
  const stream = log.type === "stderr" ? process.stderr : process.stdout;
  stream.write(text.endsWith("\n") ? text : `${text}\n`);
}

function publicCase(testCase) {
  return {
    id: testCase.id,
    file_path: testCase.file_path,
    line_number: testCase.line_number,
    description: testCase.description,
    full_description: testCase.full_description,
    run_time: testCase.run_time,
  };
}

function moduleKey(projectName, moduleId) {
  return `${projectName ?? ""}\0${moduleId}`;
}

function ancestorErrors(testCase) {
  const errors = [];
  for (let entity = testCase.parent; entity; entity = entity.parent) errors.push(...entity.errors());
  return errors;
}

/** @param {import("vitest/node").TestModule} mod */
function moduleHookErrors(mod) {
  return [mod, ...mod.children.allSuites()].flatMap((entity) => entity.errors());
}

function errorText(errors) {
  return (errors ?? [])
    .flatMap((error) => String(error?.message || error).split("\n"))
    .filter(Boolean)
    .join("\n");
}

function failedFileCase(cwd, moduleId, message, project) {
  const filePath = moduleId === "collection" ? "collection" : relativeToCwd(cwd, moduleId);
  return {
    id: `collection:${filePath}`,
    vitestId: null,
    moduleId,
    project,
    collectionError: [message],
    file_path: filePath,
    line_number: 1,
    description: filePath,
    full_description: filePath,
    run_time: 0,
  };
}

function failedPayload(record) {
  const message = record.collectionError?.[0] || "failed during collection";
  return {
    id: record.id,
    description: record.description,
    full_description: record.full_description,
    status: "failed",
    file_path: record.file_path,
    line_number: record.line_number || 1,
    run_time: 0,
    pending_message: null,
    failure_message_lines: record.collectionError?.length ? record.collectionError : [message],
    failure_formatted_backtrace: [`${record.file_path}:1: ${message}`],
  };
}

function failureFields(record, outcome, cwd) {
  const messages = [];
  const frames = [];
  for (const error of outcome.errors ?? []) {
    const message = error.message || error.name || "failed";
    messages.push(...stripVTControlCharacters(String(message)).split("\n"));
    if (error.diff) messages.push(...stripVTControlCharacters(String(error.diff)).split("\n"));
    for (const frame of error.stacks ?? []) {
      frames.push(formatFrame(frame, cwd));
    }
  }
  const project = [];
  const rest = [];
  for (const frame of frames) {
    if (frame.includes("node_modules") || frame.startsWith("/") || frame.startsWith("node:")) {
      rest.push(frame);
    } else project.push(frame);
  }
  if (!project.length) {
    project.push(
      `${record.file_path}:${record.line_number || 1}: in ${record.description}`,
    );
  }
  return {
    failure_message_lines: messages.length ? messages : ["failed"],
    failure_formatted_backtrace: [...project, ...rest],
  };
}

function formatFrame(frame, cwd) {
  const file = relativize(frame.file, cwd);
  return `${file}:${frame.line}:${frame.column}`;
}

function relativize(file, cwd) {
  const stripped = file.startsWith("file://") ? file.slice("file://".length) : file;
  if (path.isAbsolute(stripped)) {
    const rel = path.relative(cwd, stripped);
    if (!rel.startsWith("..")) return rel.split(path.sep).join("/");
  }
  return stripped.split(path.sep).join("/");
}

function relativeToCwd(cwd, moduleId) {
  const rel = path.relative(cwd, moduleId);
  return rel.split(path.sep).join("/");
}

function roundSeconds(value) {
  return Math.round(value * 1e6) / 1e6;
}
