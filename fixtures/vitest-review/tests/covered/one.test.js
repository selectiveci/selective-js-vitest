import { expect, test } from "vitest";
import { one } from "../../src/one.js";

test("one", () => {
  expect(one()).toBe(1);
});
