import { expect, test } from "vitest";
import { two } from "../../src/two.js";

test("two", () => {
  expect(two()).toBe(2);
});
