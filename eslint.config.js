import tseslint from "typescript-eslint";
import noDefensiveVitest from "./tools/no-defensive-vitest.js";

const EMPTY_CATCH =
  "Empty catch swallows the error. Delete the try/catch. child.kill() with a valid signal does not throw, and spawn()/openStdio() report a missing binary as an 'error' event. If the call can throw, handle that error in the catch body.";
const VOID_CATCH =
  "`void 0` is an empty catch. Delete the try/catch and call the function directly. child.kill(\"SIGKILL\") does not throw; Node reports spawn failures as an 'error' event, not a throw.";
const KILL =
  "Don't catch child.kill(). A valid signal does not throw, and an exited child returns false. Call `child.kill(\"SIGKILL\")` directly.";
const SPAWN =
  "Don't catch spawn(). Node does not throw ENOENT or EACCES from spawn(); it emits an 'error' event. Call spawn() directly and handle 'error' on the ChildProcess. A missing transport is loadEnvironment's spawnSync path, not this catch.";
const OPEN_STDIO =
  "Don't catch openStdio(). spawn() does not throw a missing-binary error; Node emits 'error'. Call `const link = openStdio(url)` directly and let a real synchronous failure exit.";
const STDIN =
  "Don't catch stdin.write() or stdin.end(). EPIPE is an 'error' event, which the link already handles. Call `child.stdin.end(\"exit\\n\")` directly.";

function restrict(selector, message) {
  return { selector, message };
}

export default [
  {
    ignores: [
      "checks/vitest-pin/**",
      "checks/fixtures/**/red/**",
      "fixtures/vitest-review/tests/collect/syntax.test.js",
      "coverage/**",
    ],
  },
  {
    files: ["**/*.js"],
    rules: {
      "no-restricted-syntax": [
        "error",
        restrict("CatchClause > BlockStatement[body.length=0]", EMPTY_CATCH),
        restrict(
          "CatchClause > BlockStatement[body.length=1] > ExpressionStatement > UnaryExpression[operator='void']",
          VOID_CATCH,
        ),
        restrict(
          "TryStatement[handler] > BlockStatement.block CallExpression[callee.property.name='kill'][callee.object.name='child']",
          KILL,
        ),
        restrict(
          "TryStatement[handler] > BlockStatement.block CallExpression[callee.property.name='kill'][callee.object.property.name='child']",
          KILL,
        ),
        restrict(
          "TryStatement[handler] > BlockStatement.block CallExpression[callee.name='spawn']",
          SPAWN,
        ),
        restrict(
          "TryStatement[handler] > BlockStatement.block CallExpression[callee.name='openStdio']",
          OPEN_STDIO,
        ),
        restrict(
          "TryStatement[handler] > BlockStatement.block CallExpression[callee.property.name='write'][callee.object.property.name='stdin']",
          STDIN,
        ),
        restrict(
          "TryStatement[handler] > BlockStatement.block CallExpression[callee.property.name='end'][callee.object.property.name='stdin']",
          STDIN,
        ),
      ],
    },
  },
  {
    files: ["packages/vitest/src/adapter.js", "checks/fixtures/vitest/**/*.js"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: "./tsconfig.checkjs.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      selective: {
        rules: {
          "no-defensive-vitest": noDefensiveVitest,
        },
      },
    },
    rules: {
      "selective/no-defensive-vitest": "error",
    },
  },
];
