import fs from "node:fs";

export function setup() {
  const file = process.env.SELECTIVE_SETUP_LOG;
  if (file) fs.appendFileSync(file, "setup\n");
}

export function teardown() {
  const file = process.env.SELECTIVE_SETUP_LOG;
  if (file) fs.appendFileSync(file, "teardown\n");
}
