import { test } from "vitest";

throw new Error("collect boom");

test.each([1])("never %s", () => {});
