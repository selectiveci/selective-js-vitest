import { expect, test } from "vitest";

test.only("focused", () => {
  expect(1).toBe(1);
});

test("sibling", () => {
  expect(1).toBe(1);
});

test.skip("author skip", () => {
  expect(1).toBe(1);
});
