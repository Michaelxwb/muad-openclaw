const ALLOWED_FIELDS = new Set(["skill_name", "input", "args"]);

export function readToolParams(raw) {
  if (!isObject(raw) || Object.keys(raw).some((key) => !ALLOWED_FIELDS.has(key))) {
    throw new Error("invalid muad_run_skill parameters");
  }
  const skillName = typeof raw.skill_name === "string" ? raw.skill_name.trim() : "";
  if (!skillName) throw new Error("skill_name required");
  if (raw.input !== undefined && typeof raw.input !== "string") {
    throw new Error("input must be a string");
  }
  if (raw.args !== undefined && !isObject(raw.args)) {
    throw new Error("args must be an object");
  }
  return {
    skillName,
    input: raw.input ?? "",
    args: raw.args ?? {},
  };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
