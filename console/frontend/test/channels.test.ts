import { describe, expect, it } from "vitest";
import { channelMeta } from "../src/channels";

describe("channelMeta", () => {
  it("returns known channel metadata", () => {
    const meta = channelMeta("wecom");
    expect(meta.value).toBe("wecom");
    expect(meta.label.length).toBeGreaterThan(0);
    expect(meta.icon.length).toBeGreaterThan(0);
  });

  it("does not fall back to the first known channel for unknown ids", () => {
    const meta = channelMeta("custom-channel");
    expect(meta.value).toBe("custom-channel");
    expect(meta.label).toBe("custom-channel");
    expect(meta.icon).toBe("?");
  });

  it("labels empty channel ids as unknown", () => {
    const meta = channelMeta("");
    expect(meta.value).toBe("");
    expect(meta.label).toBe("未知通道");
    expect(meta.icon).toBe("?");
  });
});
