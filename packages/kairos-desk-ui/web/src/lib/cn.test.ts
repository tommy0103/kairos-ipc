import { describe, expect, test } from "bun:test";
import { cn } from "./cn";

describe("cn", () => {
  test("merges conditional class lists and resolves Tailwind conflicts", () => {
    expect(cn("px-2 text-kd-muted", false && "hidden", ["px-3", "text-kd-blue"])).toBe("px-3 text-kd-blue");
  });
});
