export interface SkillProgressItem {
  key: string;
  type: string;
  stage: string;
  text: string;
  ts: string;
}

export function parseSkillProgress(progressJson: string | null): SkillProgressItem[] {
  if (typeof progressJson !== "string" || progressJson.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(progressJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value, index) => {
      const item = parseProgressItem(value, index);
      return item ? [item] : [];
    });
  } catch {
    return [];
  }
}

function parseProgressItem(value: unknown, index: number): SkillProgressItem | null {
  if (!isRecord(value)) return null;
  const type = stringField(value.type);
  const stage = stringField(value.stage);
  const text = stringField(value.text);
  const ts = stringField(value.ts);
  if (!type && !stage && !text && !ts) return null;
  return { key: `${ts}|${type}|${stage}|${text}|${index}`, type, stage, text, ts };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}
