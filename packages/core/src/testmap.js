import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { transportPath } from "./transport.js";

export function buildFragment(deps, cwd) {
  const root = repoRoot(cwd);
  const ignored = (process.env.SELECTIVE_TEST_MAP_IGNORE ?? "")
    .split(",")
    .map((dir) => dir.trim())
    .filter(Boolean)
    .map((dir) => path.resolve(cwd, dir));
  const files = [];
  const index = new Map();
  const tests = [];
  for (const [id, paths] of deps) {
    const indexes = new Set();
    for (const file of paths) {
      const rel = repoPath(file, root, ignored);
      if (rel == null) continue;
      if (!index.has(rel)) index.set(rel, files.push(rel) - 1);
      indexes.add(index.get(rel));
    }
    tests.push({ id, deps: [...indexes].sort((a, b) => a - b) });
  }
  return { version: 1, files, tests };
}

function repoRoot(cwd) {
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  return realpathSync(top.status === 0 ? top.stdout.trim() : cwd);
}

function repoPath(file, root, ignored) {
  if (!existsSync(file)) return null;
  const real = realpathSync(file);
  if (ignored.some((dir) => real === dir || real.startsWith(`${dir}${path.sep}`))) return null;
  const rel = path.relative(root, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  return parts.includes("node_modules") ? null : parts.join("/");
}

export function uploadFragment(env, fragment) {
  return new Promise((resolve) => {
    const child = spawn(
      transportPath(),
      ["--upload-fragment", "--run-id", env.run_id, "--run-attempt", String(env.run_attempt), "--runner-id", env.runner_id],
      {
        env: { ...process.env, SELECTIVE_TEST_MAP_UPLOAD_KEY: env.api_key },
        stdio: ["pipe", "ignore", "pipe"],
      },
    );
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (err) => resolve(err.message));
    child.stdin.on("error", (err) => resolve(err.message));
    child.on("close", (code) => resolve(code === 0 ? null : Buffer.concat(stderr).toString().trim()));
    child.stdin.end(gzipSync(JSON.stringify(fragment)));
  });
}
