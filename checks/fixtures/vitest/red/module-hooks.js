// Simplicity review finding 9, before (adapter.js moduleHookErrors and the
// collection-failure condition at 00a71df). The parameter type is the pinned
// Vitest TestModule; the review's source left it implicit.
/**
 * @param {import("vitest/node").TestModule | null | undefined} mod
 */
export function moduleHookErrors(mod) {
  if (!mod) return [];
  const errors = [...(mod.errors?.() ?? [])];
  for (const suite of mod.children?.allSuites?.() ?? []) errors.push(...(suite.errors?.() ?? []));
  return errors;
}

/**
 * @param {import("vitest/node").TestModule} mod
 * @param {readonly unknown[]} tests
 * @param {readonly unknown[]} errors
 */
export function failedDuringCollection(mod, tests, errors) {
  if (!tests.length && (mod.state?.() === "failed" || errors.length || mod.ok?.() === false)) return true;
  return false;
}

/**
 * @param {import("vitest/node").Vitest} vitest
 * @param {{ testModules: import("vitest/node").TestModule[], unhandledErrors: unknown[] }} outcome
 */
export function pinnedApis(vitest, outcome) {
  const pattern = vitest.getGlobalTestNamePattern?.() ?? vitest.config?.testNamePattern;
  const modules = outcome.testModules ?? [];
  const extra = outcome.unhandledErrors ?? [];
  return { pattern, modules, extra };
}
