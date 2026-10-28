# Agent rules

`npm run check` is the command CI runs (`simplicity guards` in `.github/workflows/test.yml`). It fails on the Oct 22 simplicity-review examples and passes on the rewrites from that review. An exception goes on the offending line with a reason: `eslint-disable-next-line <rule> -- <reason>`.

| Rule | Enforced by | Command | Review finding |
| --- | --- | --- | --- |
| Do not catch-and-ignore. Delete `try/catch` around `spawn()`, `openStdio()`, `child.kill()`, `stdin.write()`, and `stdin.end()`. An empty catch, or a catch whose only statement is `void 0`, is the same mistake. Node reports a missing binary as an `'error'` event, and `child.kill()` with a valid signal does not throw. | ESLint `no-restricted-syntax` in `eslint.config.js` (empty-catch selector plus the non-throwing child-process selectors). `npm run check` lints the red fixtures in `checks/fixtures/catch/red/` and requires those messages. | `npm run check` | Simplicity review #3, #5, #6 (`00a71df`, `transport.js` close, the dead missing-binary catch, `child.kill()` in the tests) |
| Do not optional-chain a Vitest API the pinned types mark as required. Call `errors()`, `ok()`, `state()`, `children.allSuites()`, `getGlobalTestNamePattern()`, and `runTestSpecifications()` results (`testModules`, `unhandledErrors`) directly. | `selective/no-defensive-vitest` (`tools/no-defensive-vitest.js`), which is `@typescript-eslint/no-unnecessary-condition` with a message that names those calls. `tsconfig.checkjs.json` turns on `checkJs` and `strictNullChecks` and resolves `vitest/node` to `checks/vitest-pin` (`vitest@4.1.1`). The peer floor in `packages/vitest/package.json` is `^4.1.1 \|\| ^5.0.0`; `npm run check` fails if that floor moves. `moduleHookErrors` is annotated as `TestModule` so a `?.` inside it fails. | `npm run check` | Simplicity review #9 (`00a71df`, `adapter.js` optional chaining on the pinned Vitest API) |

## Not enforced

- Repo-wide ESLint `no-empty` is not enforced. It also flags intentional empty functions already on main (`() => {}`, `async flushReporters() {}`). Empty catches and `void 0` catches are enforced by the catch-and-ignore rule above.
- `promise.catch(() => {})` on the test helper's exit timeout is not enforced. The review's #6 examples are `try/catch` around `child.kill()`, which this rule covers.
- `fixtures/vitest-review/tests/collect/syntax.test.js` is ignored by ESLint because the file is intentionally invalid JavaScript.
