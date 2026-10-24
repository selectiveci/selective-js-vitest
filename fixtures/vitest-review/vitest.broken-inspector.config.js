import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    root,
    include: [["tests", "covered", "*.test.js"].join("/")],
    setupFiles: ["./break-inspector.js"],
  },
});
