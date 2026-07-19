import { describe, expect, it } from "vitest";
import { parseSkillProgress } from "../src/pages/audit/skillProgress";

describe("parseSkillProgress", () => {
  it.each([null, "", "{invalid", "{}", "[null,42,{}]"])(
    "returns an empty list for unusable input: %s",
    (input) => {
      expect(parseSkillProgress(input)).toEqual([]);
    },
  );

  it("keeps only string lifecycle fields from valid rows", () => {
    const result = parseSkillProgress(
      '[{"type":"tool","stage":"report","text":"done","ts":"2026-07-14T10:00:00Z","secret":42}]',
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "tool",
      stage: "report",
      text: "done",
      ts: "2026-07-14T10:00:00Z",
    });
    expect(result[0]).not.toHaveProperty("secret");
  });
});
