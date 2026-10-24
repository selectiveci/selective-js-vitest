import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { transportPath } from "./transport.js";

const REQUIRED = [
  ["host", "SELECTIVE_HOST"],
  ["api_key", "SELECTIVE_API_KEY"],
  ["platform", "SELECTIVE_PLATFORM"],
  ["run_id", "SELECTIVE_RUN_ID"],
  ["run_attempt", "SELECTIVE_RUN_ATTEMPT"],
  ["branch", "SELECTIVE_BRANCH"],
  ["sha", "SELECTIVE_SHA"],
  ["git_repo_full_name", "SELECTIVE_GIT_REPO"],
  ["git_provider", "SELECTIVE_GIT_PROVIDER"],
];

export function loadEnvironment(cwd) {
  const bin = transportPath();
  const result = spawnSync(bin, ["--build-env"], {
    cwd,
    encoding: "utf8",
  });
  if (result.error) {
    result.error.missingTransport =
      result.error.code === "ENOENT" || result.error.code === "EACCES";
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      result.stderr?.trim() || "transport --build-env failed",
    );
  }
  const detected = JSON.parse(result.stdout);
  if (!detected.runner_id) {
    detected.runner_id = `selgen-${randomBytes(4).toString("hex")}`;
  }
  detected.runner_id = detected.runner_id.replace(/[^A-Za-z0-9._-]/g, "_");
  return detected;
}

export function missingSelectiveNames(env) {
  return REQUIRED.filter(([field]) => !env[field]).map(([, name]) => name);
}

export function buildWebsocketUrl({ env, versions, reconnect }) {
  const endpoint = new URL("/transport/websocket", env.host);
  const metadata = Object.fromEntries(
    Object.entries(env).filter(([key]) => !["host", "runner_id", "api_key", "run_id", "run_attempt"].includes(key)),
  );
  const params = {
    api_key: env.api_key,
    run_id: env.run_id,
    run_attempt: env.run_attempt,
    runner_id: env.runner_id,
    language: versions.language,
    core_version: versions.core,
    framework: versions.framework,
    framework_version: versions.frameworkVersion,
    framework_wrapper_version: versions.wrapper,
    runtime_version: versions.runtime,
    test_map: versions.testMap,
    test_map_record: versions.testMapRecord,
    remove_failed: "true",
    metadata: JSON.stringify(metadata),
  };
  if (reconnect) params.reconnect = "true";
  for (const [key, value] of Object.entries(params)) {
    endpoint.searchParams.set(key, value ?? "");
  }
  return endpoint.toString();
}
