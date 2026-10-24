import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    root,
    include: ["tests/junit/**/*.test.js"],
    reporters: [
      ["junit", { outputFile: process.env.SELECTIVE_JUNIT_OUT || "junit.xml" }],
      "default",
    ],
    globalSetup: ["./junit-setup.js"],
  },
});
