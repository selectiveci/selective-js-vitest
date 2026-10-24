#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runSession } from "@selectiveci/core";
import { createVitestAdapter, vitestVersionAllowed } from "./adapter.js";

const require = createRequire(import.meta.url);
const corePackage = JSON.parse(
  readFileSync(require.resolve("@selectiveci/core/package.json"), "utf8"),
);
const wrapperPackage = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

const raw = process.argv.slice(2);
const debug = raw.includes("--debug");
const log = raw.includes("--log");
const args = raw.filter((arg) => arg !== "--debug" && arg !== "--log");
const execMode = args[0] === "exec";
const rest = execMode ? args.slice(1) : args;
if (rest[0] !== "vitest") {
  console.error("usage: selective [--debug] [--log] vitest [vitest args]");
  console.error("       selective [--debug] exec vitest [vitest args]");
  process.exit(1);
}

const adapter = createVitestAdapter({
  cwd: process.cwd(),
  argv: rest.slice(1),
  coreVersion: corePackage.version,
  wrapperVersion: wrapperPackage.version,
  execMode,
});
if (!vitestVersionAllowed(adapter.frameworkVersion())) {
  console.error(
    `selective vitest requires vitest ^4.1.1 or ^5, found ${adapter.frameworkVersion()}`,
  );
  process.exit(1);
}

if (execMode) {
  const code = await adapter.exec().catch((err) => {
    console.error(err.message);
    return 1;
  });
  process.exit(code);
}
const code = await runSession({ adapter, debug, log, cwd: process.cwd() });
process.exit(code);
