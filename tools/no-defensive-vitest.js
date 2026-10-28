import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const official = require(fileURLToPath(
  new URL(
    "../node_modules/@typescript-eslint/eslint-plugin/dist/rules/no-unnecessary-condition.js",
    import.meta.url,
  ),
)).default;

// Same check as @typescript-eslint/no-unnecessary-condition (optional chains and
// `??` on a non-nullish type). The message names the Vitest call to write instead.
const rule = {
  ...official,
  meta: {
    ...official.meta,
    docs: {
      ...official.meta.docs,
      description:
        "Disallow optional chaining and ?? on Vitest APIs that the pinned vitest@4.1.1 types mark as required.",
    },
    messages: {
      ...official.meta.messages,
      neverOptionalChain:
        "Call it directly. vitest@4.1.1 (the peerDependency floor; vitest 5 keeps these required) types this as non-nullish, so `?.` does not guard anything. Write errors(), ok(), state(), children.allSuites(), getGlobalTestNamePattern(), and runTestSpecifications() results (testModules, unhandledErrors) without `?.`.",
      neverNullish:
        "Drop `??`. vitest@4.1.1 (the peerDependency floor; vitest 5 keeps these required) types the left-hand side as non-nullish. errors() returns an array, and runTestSpecifications() returns testModules and unhandledErrors arrays. Use the value directly.",
    },
  },
};

export default rule;
