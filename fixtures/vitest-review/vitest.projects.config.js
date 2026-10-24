import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    root,
    include: [],
    projects: [
      {
        test: {
          name: "A",
          include: ["tests/projects/shared.test.js"],
          env: { PROJECT_MODE: "fail" },
        },
      },
      {
        test: {
          name: "B",
          include: ["tests/projects/shared.test.js"],
          env: { PROJECT_MODE: "pass" },
        },
      },
    ],
  },
});
