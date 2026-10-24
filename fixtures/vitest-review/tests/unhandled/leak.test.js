import { expect, test } from "vitest";

test("leaks", () => {
  Promise.reject(new Error("leaked rejection"));
  expect(1).toBe(1);
});

test("clean", () => {
  expect(1).toBe(1);
});
