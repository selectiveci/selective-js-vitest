import { fileURLToPath } from "node:url";

export default {
  test: {
    root: fileURLToPath(new URL("./conformance-fixture", import.meta.url)),
    include: ["cases.test.js"],
  },
};
