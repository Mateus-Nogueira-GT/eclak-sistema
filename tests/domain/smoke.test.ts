import { describe, expect, it } from "vitest";
import { cx } from "@/components/ui";

describe("cx", () => {
  it("junta classes e ignora valores falsos", () => {
    expect(cx("a", false, "b")).toBe("a b");
  });
});
