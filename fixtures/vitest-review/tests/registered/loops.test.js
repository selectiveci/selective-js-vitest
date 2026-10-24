import fs from "node:fs";
import { describe, expect, test } from "vitest";
import "./imported.js";

function mark() {
  const file = process.env.SELECTIVE_BODY_LOG;
  const name = expect.getState().currentTestName;
  if (file && name) fs.appendFileSync(file, `${name}\n`);
}

test("static pass", () => {
  mark();
  expect(1).toBe(1);
});

for (const n of [1, 2]) {
  test(`loop ${n}`, () => {
    mark();
    expect(n).toBe(1);
  });
}

function helper(name, ok) {
  test(name, () => {
    mark();
    expect(ok).toBe(true);
  });
}
helper("helper pass", true);
helper("helper fail", false);

function fixture(name) {
  test(name, () => {
    mark();
    expect(true).toBe(true);
  });
}
for (const n of [1, 2]) fixture(`fixture ${n}`);

for (const n of [1, 2]) {
  describe(`block ${n}`, () => {
    test("inside", () => {
      mark();
      expect(n).toBe(1);
    });
  });
}

test("static fail", () => {
  mark();
  expect(1).toBe(2);
});
