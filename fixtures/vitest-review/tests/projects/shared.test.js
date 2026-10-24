import fs from "node:fs";
import { beforeAll, expect, test } from "vitest";

beforeAll(() => {
  if (process.env.SELECTIVE_HOOK_LOG) fs.appendFileSync(process.env.SELECTIVE_HOOK_LOG, "beforeAll\n");
});

test("mode is pass", () => {
  const file = process.env.SELECTIVE_BODY_LOG;
  if (file) fs.appendFileSync(file, `${process.env.PROJECT_MODE}\n`);
  expect(process.env.PROJECT_MODE).toBe("pass");
});

test("mode is set", () => {
  expect(process.env.PROJECT_MODE).toBeTruthy();
});
