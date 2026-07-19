import fs from "node:fs/promises";
import path from "node:path";

import { runSkill } from "./runner.mjs";

const INTERPRETERS = new Map([
  [".sh", "bash"],
  [".py", "python3"],
  [".js", "node"],
]);

export class TraditionalScriptError extends Error {
  constructor(message) {
    super(message);
    this.name = "TraditionalScriptError";
    this.code = "skill_script_rejected";
  }
}

export async function prepareTraditionalExecution({ lifecycle, context, grant, params }) {
  try {
    const manifest = await createTraditionalManifest(grant, params);
    lifecycle.activate({
      context, grant, activationMode: "runner", inputSummary: params.input,
    });
    return manifest;
  } catch (error) {
    lifecycle.reject({
      context, grant, skillName: grant.name, inputSummary: params.input,
      activationMode: "runner", errorCode: "skill_script_rejected",
      errorMessage: "Traditional Skill script was rejected",
    });
    if (error instanceof TraditionalScriptError) throw error;
    throw new TraditionalScriptError("Traditional Skill script was rejected");
  }
}

export function runTraditionalSkill(options) {
  const { manifest, argv = [], ...rest } = options;
  return runSkill({ manifest, args: { argv }, ...rest });
}

async function createTraditionalManifest(grant, params) {
  validateGrantAndParams(grant, params);
  const root = await fs.realpath(grant.rootPath);
  const script = path.resolve(root, params.scriptPath);
  if (!pathWithin(root, script)) throw new TraditionalScriptError("script escapes Skill root");
  const details = await fs.lstat(script);
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new TraditionalScriptError("script must be a regular file");
  }
  const realScript = await fs.realpath(script);
  if (!pathWithin(root, realScript)) throw new TraditionalScriptError("script escapes Skill root");
  return traditionalManifest(grant, root, params);
}

function validateGrantAndParams(grant, params) {
  if (grant.entryType !== "traditional-script") {
    throw new TraditionalScriptError("Skill is not a traditional script");
  }
  if (!safeRelativePath(params.scriptPath) || !grant.scriptFiles.includes(params.scriptPath)) {
    throw new TraditionalScriptError("script is not in the scanned allowlist");
  }
  if (!Array.isArray(params.args) || !params.args.every(validArgument)) {
    throw new TraditionalScriptError("invalid script arguments");
  }
  if (!INTERPRETERS.has(path.extname(params.scriptPath))) {
    throw new TraditionalScriptError("unsupported script type");
  }
}

function traditionalManifest(grant, root, params) {
  const interpreter = INTERPRETERS.get(path.extname(params.scriptPath));
  return {
    name: grant.name, runtime: "script", mode: "entrypoint", skillDir: root,
    progress: { source: "auto" },
    entrypoint: [interpreter, params.scriptPath, ...params.args],
    steps: [{ id: "execute", title: "执行脚本" }],
  };
}

function safeRelativePath(value) {
  if (typeof value !== "string" || path.isAbsolute(value) || value.includes("\\")) return false;
  const parts = value.split("/");
  return parts.length > 1 && parts.every((part) => part && !part.startsWith("."));
}

function validArgument(value) {
  return typeof value === "string" && value.length <= 4096 && !value.includes("\0");
}

function pathWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
