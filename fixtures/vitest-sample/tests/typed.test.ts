import { expect, test } from "vitest";

test("typed adds", () => {
  const value: number = 1 + 1;
  expect(value).toBe(2);
});
