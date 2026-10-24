import { afterAll, describe, expect, test } from "vitest";

test("body", () => {
  expect(1).toBe(1);
});

afterAll(() => {
  throw new Error("after boom");
});

describe("nested", () => {
  test("inner", () => {
    expect(1).toBe(1);
  });
  afterAll(() => {
    throw new Error("nested after");
  });
});
