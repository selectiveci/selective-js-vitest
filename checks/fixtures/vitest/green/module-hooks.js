// Simplicity review finding 9, after.
/**
 * @param {import("vitest/node").TestModule} mod
 */
export function moduleHookErrors(mod) {
  return [mod, ...mod.children.allSuites()].flatMap((entity) => entity.errors());
}

/**
 * @param {import("vitest/node").TestModule} mod
 * @param {readonly unknown[]} tests
 * @param {readonly unknown[]} errors
 */
export function failedDuringCollection(mod, tests, errors) {
  if (!tests.length && (!mod.ok() || errors.length)) return true;
  return false;
}

/**
 * @param {import("vitest/node").Vitest} vitest
 * @param {{ testModules: import("vitest/node").TestModule[], unhandledErrors: unknown[] }} outcome
 */
export function pinnedApis(vitest, outcome) {
  const pattern = vitest.getGlobalTestNamePattern();
  const modules = outcome.testModules;
  const extra = outcome.unhandledErrors;
  return { pattern, modules, extra };
}
