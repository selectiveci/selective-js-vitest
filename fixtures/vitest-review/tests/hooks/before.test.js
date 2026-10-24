import { beforeAll, expect, test } from "vitest";

beforeAll(() => {
  throw new Error("boom in beforeAll");
});

test("after hook", () => {
  expect(1).toBe(1);
});
