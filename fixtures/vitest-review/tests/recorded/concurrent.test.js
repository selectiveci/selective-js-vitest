import { expect, test } from "vitest";
import { one } from "../../src/one.js";
import { two } from "../../src/two.js";

const pause = () => new Promise((resolve) => setTimeout(resolve, 50));

test.concurrent("together one", async () => {
  await pause();
  expect(one()).toBe(1);
});

test.concurrent("together two", async () => {
  await pause();
  expect(two()).toBe(2);
});
