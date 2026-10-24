import fs from "node:fs";
import { expect, test } from "vitest";

test("alpha", () => {
  console.log("marker-alpha");
  const file = process.env.SELECTIVE_FLAKE_FILE;
  const current = Number(file && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "0");
  const next = current + 1;
  if (file) fs.writeFileSync(file, String(next));
  expect(next).toBeGreaterThan(1);
});

test("beta", () => {
  console.log("marker-beta");
  expect(1).toBe(1);
});

test("gamma", () => {
  console.log("marker-gamma");
  expect(1).toBe(1);
});
