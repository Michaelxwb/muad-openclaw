import fs from "node:fs/promises";
import path from "node:path";

const EXECUTABLES = new Set(["bash", "sh", "python3", "node"]);
const SCRIPT_EXTENSIONS = {
  bash: new Set([".sh"]),
  sh: new Set([".sh"]),
  python3: new Set([".py"]),
  node: new Set([".js", ".mjs", ".cjs", ".ts"]),
};

export function validateDeclaredCommand(command, field) {
  if (!Array.isArray(command) || command.length < 2) {
    throw new Error(`${field} must declare an interpreter and relative script`);
  }
  const normalized = command.map((part) => requirePart(part, field));
  const executable = normalized[0];
  const script = normalized[1];
  if (!EXECUTABLES.has(executable) || path.basename(executable) !== executable) {
    throw new Error(`${field} interpreter is not approved`);
  }
  for (const part of normalized.slice(1)) validateRelativeArgument(part, field);
  if (!script.startsWith("scripts/") || !SCRIPT_EXTENSIONS[executable].has(path.extname(script))) {
    throw new Error(`${field} script must be a declared scripts/ file`);
  }
  return normalized;
}

export async function verifyManifestCommands(manifest) {
  const commands = manifest.mode === "steps"
    ? manifest.steps.map((step) => step.command)
    : [manifest.entrypoint];
  const root = await fs.realpath(manifest.skillDir);
  for (const command of commands) {
    const script = await fs.realpath(path.resolve(root, command[1]));
    const details = await fs.stat(script);
    if (!details.isFile() || !isWithin(root, script)) {
      throw new Error("declared script escapes the Skill directory");
    }
  }
}

function requirePart(value, field) {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw new Error(`${field} entries must be non-empty strings`);
  }
  return value.trim();
}

function validateRelativeArgument(value, field) {
  if (path.isAbsolute(value) || /(^|=)\//u.test(value) ||
    /(^|[=\\/])\.\.([\\/]|$)/u.test(value) || value.includes("\\")) {
    throw new Error(`${field} contains an unsafe path`);
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
