import fs from "node:fs";
import { expect, test } from "vitest";

test.each([1, 2])("row %s", (n) => {
  const file = process.env.SELECTIVE_BODY_LOG;
  if (file) fs.appendFileSync(file, `row ${n}\n`);
  expect(n).toBeGreaterThan(0);
});

test("static after", () => {
  const file = process.env.SELECTIVE_BODY_LOG;
  if (file) fs.appendFileSync(file, "static\n");
  expect(true).toBe(true);
});
