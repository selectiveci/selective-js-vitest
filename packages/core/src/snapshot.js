import { spawnSync } from "node:child_process";
import { transportPath } from "./transport.js";

export const SNAPSHOT_MAX_BUFFER = 256 * 1024 * 1024;

export function interpretSnapshot(result) {
  if (result.error) return { ok: false, error: result.error };
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? "").trim();
    if (stderr === "not a git checkout") return { ok: false, error: null };
    return { ok: false, error: new Error(stderr || `exit ${result.status}`) };
  }
  try {
    return { ok: true, tree: JSON.parse(result.stdout) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

export function snapshotFailure(result) {
  if (result.error) return `transport --snapshot failed: ${result.error.message}`;
  return "working directory is not a git checkout; omitting test_map_tree";
}

export function snapshotTree(cwd) {
  const result = spawnSync(transportPath(), ["--snapshot", cwd], {
    cwd,
    encoding: "utf8",
    maxBuffer: SNAPSHOT_MAX_BUFFER,
  });
  return interpretSnapshot(result);
}
