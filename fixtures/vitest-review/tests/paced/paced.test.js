import { expect, test } from "vitest";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const n of [1, 2, 3, 4, 5]) {
  test(`paced ${n}`, async () => {
    await sleep(30);
    expect(n).toBeGreaterThan(0);
  });
}
