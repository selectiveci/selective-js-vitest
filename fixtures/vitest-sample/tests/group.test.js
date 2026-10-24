import fs from "node:fs";
import { afterAll, beforeAll, expect, test } from "vitest";

const file = process.env.SELECTIVE_HOOK_LOG;
if (file) fs.appendFileSync(file, "module\n");

beforeAll(async () => {
  if (file) fs.appendFileSync(file, "beforeAll\n");
  await new Promise((resolve) => setTimeout(resolve, 50));
});

afterAll(() => {
  if (file) fs.appendFileSync(file, "afterAll\n");
});

test("alpha", () => {
  expect(true).toBe(true);
});

test("beta", () => {
  expect(true).toBe(true);
});

test("gamma", () => {
  expect(true).toBe(true);
});
