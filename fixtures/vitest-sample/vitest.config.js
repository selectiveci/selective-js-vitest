import fs from "node:fs";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

if (process.env.SELECTIVE_SIGNAL_LOG) {
  const file = process.env.SELECTIVE_SIGNAL_LOG;
  process.on("SIGTERM", function userTerm() {
    fs.appendFileSync(file, "user\n");
  });
}

export default defineConfig({
  test: {
    root,
    include: ["tests/**/*.{test,spec}.{js,ts}"],
    fileParallelism: true,
    maxWorkers: 4,
    isolate: true,
    globalSetup: ["./global-setup.js"],
    reporters: ["default", "../reason-reporter.js"],
  },
});
