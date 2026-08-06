import { describe, expect, it } from "vitest";
import { memLimitToGB } from "../src/utils/memLimit";

describe("memLimitToGB", () => {
  it("converts unit-suffixed backend values to a bare GiB number", () => {
    expect(memLimitToGB("3g")).toBe("3");
    expect(memLimitToGB("2.5g")).toBe("2.5");
    expect(memLimitToGB("16G")).toBe("16");
    expect(memLimitToGB("512m")).toBe("0.5");
  });

  it("passes through bare numbers and empty values", () => {
    expect(memLimitToGB("8")).toBe("8");
    expect(memLimitToGB("")).toBe("");
    expect(memLimitToGB("  ")).toBe("");
  });
});
