import { ESLint } from "eslint";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PEER = "^4.1.1 || ^5.0.0";

const redFiles = [
  ["checks/fixtures/catch/red/close.js", ["Don't catch stdin", "Don't catch child.kill"]],
  ["checks/fixtures/catch/red/missing-binary.js", ["Don't catch openStdio", "Don't catch spawn"]],
  ["checks/fixtures/catch/red/kill.js", ["`void 0` is an empty catch", "Empty catch swallows"]],
  [
    "checks/fixtures/vitest/red/module-hooks.js",
    ["Call it directly. vitest@4.1.1", "errors()", "Drop `??`", "testModules"],
  ],
];

const greenFiles = [
  "checks/fixtures/catch/green/close.js",
  "checks/fixtures/catch/green/missing-binary.js",
  "checks/fixtures/catch/green/kill.js",
  "checks/fixtures/vitest/green/module-hooks.js",
  "packages/vitest/src/adapter.js",
];

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function assertPin() {
  const pinJson = path.join(root, "checks/vitest-pin/node_modules/vitest/package.json");
  if (!existsSync(pinJson)) {
    run("npx", ["-y", "npm@11", "ci", "--prefix", "checks/vitest-pin"]);
  }
  const pinned = JSON.parse(readFileSync(pinJson, "utf8")).version;
  if (pinned !== "4.1.1") {
    console.error(`checks/vitest-pin resolved vitest@${pinned}. Pin vitest@4.1.1, the peerDependency floor whose types make errors(), ok(), state(), children.allSuites(), and getGlobalTestNamePattern() required.`);
    process.exit(1);
  }
  const peer = JSON.parse(readFileSync(path.join(root, "packages/vitest/package.json"), "utf8")).peerDependencies.vitest;
  if (peer !== PEER) {
    console.error(`packages/vitest peerDependency vitest must stay ${JSON.stringify(PEER)} so the type pin matches the versions the adapter accepts. Got ${JSON.stringify(peer)}.`);
    process.exit(1);
  }
}

function textOf(result) {
  return (result?.messages ?? []).map((message) => message.message).join("\n");
}

async function main() {
  assertPin();
  const red = new ESLint({ cwd: root, ignore: false });
  const formatter = await red.loadFormatter("stylish");
  console.log("RED: review examples (must fail)\n");
  const redResults = await red.lintFiles(redFiles.map(([file]) => file));
  console.log(formatter.format(redResults));
  let failed = false;
  for (const [file, phrases] of redFiles) {
    const result = redResults.find((item) => item.filePath.endsWith(file));
    const text = textOf(result);
    if (!result || result.errorCount === 0) {
      console.error(`expected ${file} to fail`);
      failed = true;
      continue;
    }
    for (const phrase of phrases) {
      if (!text.includes(phrase)) {
        console.error(`expected ${file} to say ${JSON.stringify(phrase)}`);
        failed = true;
      }
    }
  }
  if (failed) process.exit(1);

  const pass = new ESLint({ cwd: root });
  console.log("GREEN: fixed examples and the repository (must pass)\n");
  const passResults = await pass.lintFiles(["."]);
  const passText = formatter.format(passResults);
  console.log(passText || "eslint: no problems\n");
  for (const file of greenFiles) {
    const result = passResults.find((item) => item.filePath.endsWith(file));
    if (!result) {
      console.error(`expected ${file} to be linted`);
      failed = true;
      continue;
    }
    if (result.errorCount || result.warningCount) {
      console.error(`expected ${file} to pass`);
      failed = true;
    }
  }
  const errors = passResults.reduce((sum, item) => sum + item.errorCount, 0);
  if (failed || errors) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
