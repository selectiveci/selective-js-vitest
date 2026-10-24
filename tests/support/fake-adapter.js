import { appendFileSync } from "node:fs";

const FIXTURES = [
  { id: "case-pass", status: "passed", line: 1, flake: false },
  { id: "case-fail", status: "failed", line: 2, flake: false },
  { id: "case-pend", status: "pending", line: 3, flake: false },
  { id: "case-flake", status: "failed", line: 4, flake: true },
];

export function createFakeAdapter() {
  const attempts = new Map();
  const cases = FIXTURES.map((item) => ({
    id: item.id,
    file_path: "tests/example.py",
    line_number: item.line,
    description: item.id,
    full_description: item.id,
    run_time: 0,
  }));
  return {
    versions() {
      return {
        language: "javascript",
        core: "0.1.0",
        framework: "vitest",
        frameworkVersion: "4.1.12",
        wrapper: "0.1.0",
        runtime: process.versions.node,
        testMap: /^(1|true|yes)$/i.test(process.env.SELECTIVE_TEST_MAP_DISABLE ?? "") ? "0" : "select",
      };
    },
    async start() {},
    record() {
      return Boolean(process.env.SELECTIVE_FAKE_DEP);
    },
    recordedDeps() {
      return new Map(process.env.SELECTIVE_FAKE_DEP ? [["case-pass", [process.env.SELECTIVE_FAKE_DEP]]] : []);
    },
    suiteRoot() {
      return "";
    },
    async discover() {
      return { testCases: cases, reason: cases.length ? "" : "No tests found" };
    },
    has(id) {
      return FIXTURES.some((item) => item.id === id);
    },
    prepare() {},
    async run(ids, onResult) {
      for (const id of ids) this.runOne(id, onResult);
    },
    runOne(id, onResult) {
      const fixture = FIXTURES.find((item) => item.id === id);
      const attempt = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, attempt);
      const status = fixture?.flake && attempt >= 2 ? "passed" : fixture?.status ?? "failed";
      const result = {
        id,
        description: id,
        full_description: id,
        status,
        file_path: "tests/example.py",
        line_number: fixture?.line ?? 1,
        run_time: 0.01,
        pending_message: status === "pending" ? "skipped" : null,
      };
      if (status === "failed") {
        result.failure_message_lines = ["assertion failed"];
        result.failure_formatted_backtrace = [
          `tests/example.py:${result.line_number}: in ${id}`,
        ];
      }
      onResult(result);
    },
    cancel() {},
    async flushReporters() {},
    async finish() {
      const file = process.env.SELECTIVE_FINISH_LOG;
      if (file) appendFileSync(file, "finish\n");
    },
    hookSeconds() {
      return {};
    },
    failedOutsideTests() {
      return false;
    },
  };
}
