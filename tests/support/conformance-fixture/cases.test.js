import fs from "node:fs";
import { beforeAll, describe, expect, test } from "vitest";

describe("group", () => {
  beforeAll(() => new Promise((resolve) => setTimeout(resolve, 500)));

  test("passes", () => {
    expect(1).toBe(1);
  });
});

test("fails", () => {
  expect(1).toBe(2);
});

test.skip("pends", () => {
  expect(1).toBe(1);
});

test("flake", () => {
  const file = process.env.SELECTIVE_FLAKE_FILE;
  const current = Number(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "0");
  const next = current + 1;
  fs.writeFileSync(file, String(next));
  expect(next).toBeGreaterThan(1);
});
