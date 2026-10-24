import { spawnSync } from "node:child_process";

const CORRELATED_COMMITS = 1000;
const TEST_FILE = /(^|\/)[^/]+\.(test|spec)\.[cm]?[jt]sx?$/;

export function isTestPath(filePath) {
  return TEST_FILE.test(filePath);
}

export function diffTestFiles({ cwd, targetBranch, suiteRoot, knownTests }) {
  const ref = `origin/${targetBranch}`;
  let diff = git(cwd, ["diff", "--name-only", ref]);
  if (diff.status !== 0) {
    const fetched = git(cwd, ["fetch", "--no-tags", "origin", targetBranch]);
    if (fetched.status !== 0) {
      return { ok: false, warning: `could not diff ${ref}` };
    }
    diff = git(cwd, ["diff", "--name-only", ref]);
    if (diff.status !== 0) return { ok: false, warning: `could not diff ${ref}` };
  }
  const changed = names(diff.stdout);
  const files = changed.filter((file) => testFile(file, suiteRoot, knownTests));
  return { ok: true, files, sources: changed.filter((file) => !files.includes(file)) };
}

export function correlateTestFiles({ cwd, targetBranch, suiteRoot, knownTests, sources }) {
  const changed = new Set(sources);
  const log = git(cwd, [
    "log",
    `origin/${targetBranch}`,
    "--no-merges",
    "--reverse",
    "-n",
    String(CORRELATED_COMMITS),
    "--name-only",
    "--pretty=format:%x1e",
  ]);
  if (log.status !== 0) return null;
  const correlated = {};
  const uncorrelated = {};
  let previous = [];
  for (const block of log.stdout.split("\x1e").slice(1)) {
    const files = [...new Set(names(block))];
    const tests = files.filter((file) => testFile(file, suiteRoot, knownTests));
    const linked = new Set();
    for (const source of [...previous, ...files].filter((file) => changed.has(file))) {
      correlated[source] ??= {};
      for (const test of tests) {
        correlated[source][test] = (correlated[source][test] ?? 0) + 1;
        linked.add(test);
      }
    }
    for (const test of tests) {
      if (!linked.has(test)) uncorrelated[test] = (uncorrelated[test] ?? 0) + 1;
    }
    previous = files;
  }
  return { correlated_files: correlated, uncorrelated_files: uncorrelated };
}

function testFile(file, suiteRoot, knownTests) {
  if (!underSuite(file, suiteRoot)) return false;
  return knownTests.has(file) || isTestPath(file);
}

function underSuite(file, suiteRoot) {
  if (!suiteRoot) return true;
  const prefix = suiteRoot.endsWith("/") ? suiteRoot : `${suiteRoot}/`;
  return file === suiteRoot || file.startsWith(prefix);
}

function names(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function git(cwd, args) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}
