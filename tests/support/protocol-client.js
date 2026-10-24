#!/usr/bin/env node
import { runSession } from "@selectiveci/core";
import { createFakeAdapter } from "./fake-adapter.js";

const code = await runSession({
  adapter: createFakeAdapter(),
  debug: process.argv.includes("--debug"),
  log: process.argv.includes("--log"),
  cwd: process.cwd(),
});
process.exit(code);
