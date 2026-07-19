const ALLOWED_FIELDS = new Set(["skill_name", "input", "args", "script_path"]);
const SKILL_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;

export function readToolParams(raw) {
  if (!isObject(raw) || Object.keys(raw).some((key) => !ALLOWED_FIELDS.has(key))) {
    throw new Error("invalid muad_run_skill parameters");
  }
  const skillName = typeof raw.skill_name === "string" ? raw.skill_name.trim() : "";
  if (!SKILL_NAME_PATTERN.test(skillName)) throw new Error("skill_name required");
  if (raw.input !== undefined && typeof raw.input !== "string") {
    throw new Error("input must be a string");
  }
  if (raw.script_path !== undefined) return readTraditionalParams(raw, skillName);
  if (raw.args !== undefined && !isObject(raw.args)) throw invalidParams();
  return {
    mode: "managed", skillName,
    input: raw.input ?? "",
    args: raw.args ?? {},
  };
}

function readTraditionalParams(raw, skillName) {
  const scriptPath = typeof raw.script_path === "string" ? raw.script_path.trim() : "";
  const args = raw.args ?? [];
  if (!validRelativeScript(scriptPath) || !Array.isArray(args) || !args.every(validArgument)) {
    throw invalidParams();
  }
  return {
    mode: "traditional", skillName, input: raw.input ?? "", scriptPath, args: [...args],
  };
}

function validRelativeScript(value) {
  return value.length > 0 && !value.startsWith("/") && !value.includes("\\") &&
    !value.includes("\0") && !value.split("/").some((part) => !part || part.startsWith("."));
}

function validArgument(value) {
  return typeof value === "string" && value.length <= 4096 && !value.includes("\0");
}

function invalidParams() {
  return new Error("invalid muad_run_skill parameters");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
