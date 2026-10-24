import fs from "node:fs";
import { expect, test } from "vitest";

function mark() {
  const file = process.env.SELECTIVE_BODY_LOG;
  const name = expect.getState().currentTestName;
  if (file && name) fs.appendFileSync(file, `${name}\n`);
}

test("imported pass", () => {
  mark();
  expect(1).toBe(1);
});

test("imported fail", () => {
  mark();
  expect(1).toBe(2);
});
