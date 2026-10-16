import fs from "node:fs";
import path from "node:path";
import parse from "bash-parser";

// 长任务 Skill 前台命令判定：用真实 Shell AST（bash-parser）替代正则拆段，
// 分辨管道、包装器、子命令/命令替换、find/awk/sed 的实际执行行为，并用
// realpath + 真实生效工作目录（exec 默认 CWD 或命令内 cd）定位授权业务文件。
//
// 导出：
//   analyzeShellCommand(command, { cwd })        — 纯静态分析（不判定授权范围）
//   matchAuthorizedExecution(analysis, { rootPath }) — 与授权根目录比对，给出显式结论

const SHELL_INTERPRETERS = new Set(["sh", "bash", "zsh", "ksh", "dash", "ash", "fish"]);
const INTERPRETER_SPECS = new Map([
  ...[...SHELL_INTERPRETERS].map(name => [name, { shell: true, valueFlags: ["-o", "+o"] }]),
  ["python", pythonSpec()], ["python3", pythonSpec()], ["python2", pythonSpec()],
  ["node", { codeFlags: ["-e", "--eval", "-p", "--print"], valueFlags: ["-r", "--require"] }],
  ["nodejs", { codeFlags: ["-e", "--eval", "-p", "--print"], valueFlags: ["-r", "--require"] }],
  ["deno", { valueFlags: ["-A", "--allow-all"] }],
  ["bun", {}], ["ruby", { codeFlags: ["-e"] }], ["perl", { codeFlags: ["-e"] }],
  ["php", { codeFlags: ["-r"] }], ["lua", { codeFlags: ["-e"] }],
  ["rscript", {}], ["pwsh", { codeFlags: ["-c", "-command"] }], ["powershell", { codeFlags: ["-c", "-command"] }],
]);
const STDIN_INTERPRETERS = new Set([...SHELL_INTERPRETERS, "python", "python3", "python2", "node", "perl", "ruby"]);
const WRAPPER_SPECS = new Map([
  ["env", { valueFlags: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string", "-a", "--argv0"] }],
  ["sudo", { valueFlags: ["-u", "--user", "-g", "--group", "-p", "--prompt", "-C", "--close-from", "-h", "--host", "-r", "--role", "-t", "--type", "-U", "--other-user"] }],
  ["doas", { valueFlags: ["-u"] }],
  ["timeout", { valueFlags: ["-k", "--kill-after", "-s", "--signal"], skipPositional: 1 }],
  ["stdbuf", { valueFlags: ["-i", "-o", "-e"] }],
  ["nice", { valueFlags: ["-n", "--adjustment"] }],
  ["ionice", { valueFlags: ["-c", "-n", "-p", "-u"] }],
  ["nohup", {}], ["setsid", {}], ["exec", {}], ["command", {}], ["builtin", {}], ["chronic", {}],
  ["uv", { subcommands: ["run"], valueFlags: ["--python", "--with", "--project", "--directory", "--index", "--extra", "--env-file", "--cache-dir", "-p", "--package"] }],
  ["xargs", { valueFlags: ["-n", "--max-args", "-I", "--replace", "-P", "--max-procs", "-L", "--max-lines", "-s", "--max-chars", "-a", "--arg-file", "-E", "--eof", "-d", "--delimiter"] }],
]);
const FIND_EXEC_MARKERS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const PROJECT_MENTION_LIMIT = 64;

function pythonSpec() {
  return { codeFlags: ["-c"], valueFlags: ["-m", "-W", "-X"] };
}

export function analyzeShellCommand(command, options = {}) {
  const cwd = typeof options?.cwd === "string" ? options.cwd : "";
  const out = {
    status: "parsed",
    reason: "",
    command: typeof command === "string" ? command : "",
    cwd,
    accesses: [],
    mentions: [],
  };
  if (!out.command.trim()) return out;
  let ast;
  try {
    ast = parse(out.command);
  } catch (error) {
    out.status = "indeterminate";
    out.reason = String(error?.message || error);
    out.mentions.push(out.command);
    return out;
  }
  walkCommandNode(ast, { base: cwd }, out);
  return out;
}

// 与授权根目录比对：仅执行/执行不确定类命中才拒绝；读取与写入不在这里拦截。
export function matchAuthorizedExecution(analysis, options = {}) {
  const rootRaw = typeof options?.rootPath === "string" ? options.rootPath : "";
  if (!rootRaw || !analysis) return { decision: "allow", basis: "", reason: "" };
  const rootReal = realpathSafe(rootRaw) || path.resolve(rootRaw);
  const mentionsRoot = (analysis.mentions ?? []).some(text => textMentionsRoot(text, rootRaw, rootReal));
  if (analysis.status === "indeterminate" && mentionsRoot) {
    return {
      decision: "block",
      basis: "indeterminate",
      reason: `命令无法按 Shell 语法解析（${analysis.reason || "unknown"}），但文本涉及长任务授权目录，按保守策略拒绝；请改用 muad_submit_long_task 提交。`,
    };
  }
  for (const access of analysis.accesses ?? []) {
    const decided = decideAccess(access, rootRaw, rootReal);
    if (decided) return decided;
  }
  return { decision: "allow", basis: "", reason: "" };
}

function decideAccess(access, rootRaw, rootReal) {
  if (!access || (access.kind !== "execute" && access.kind !== "execute-uncertain")) return null;
  if (access.certainty === "resolved" && access.path) {
    const covered = access.scopeDirectory
      ? isWithin(rootReal, access.path) || isWithin(access.path, rootReal)
      : isWithin(rootReal, access.path);
    if (covered) {
      return {
        decision: "block",
        basis: "execution",
        reason: `命令会执行长任务 Skill 目录内的 ${access.raw}（${access.path}）；请通过 muad_submit_long_task 提交，不得在会话内直接执行。`,
      };
    }
    return null;
  }
  const baseReal = access.base ? realpathSafe(access.base) || path.resolve(access.base) : "";
  const baseInRoot = baseReal ? isWithin(rootReal, baseReal) : false;
  if (baseInRoot || textMentionsRoot(access.raw, rootRaw, rootReal)) {
    return {
      decision: "block",
      basis: "indeterminate",
      reason: `无法确认 ${access.raw || "该命令"} 是否执行长任务 Skill 目录内脚本，按保守策略拒绝；请通过 muad_submit_long_task 提交。`,
    };
  }
  return null;
}

function walkCommandNode(node, ctx, out) {
  if (!node || typeof node !== "object") return;
  switch (node.type) {
    case "Script":
    case "CompoundList":
      walkSequential(node.commands, ctx, out);
      return;
    case "LogicalExpression":
      walkCommandNode(node.left, ctx, out);
      walkCommandNode(node.right, ctx, out);
      return;
    case "Pipeline":
      walkPipeline(node, ctx, out);
      return;
    case "Subshell":
      walkCommandNode(node.list, cloneContext(ctx), out);
      return;
    case "While":
      walkCommandNode(node.clause, ctx, out);
      walkCommandNode(node.do, ctx, out);
      return;
    case "If":
      walkCommandNode(node.clause, ctx, out);
      walkCommandNode(node.then, ctx, out);
      walkCommandNode(node.else, ctx, out);
      return;
    case "For":
      for (const word of node.wordlist ?? []) collectWord(word, ctx, out);
      walkCommandNode(node.do, ctx, out);
      return;
    case "Case":
      for (const item of node.cases ?? []) walkCommandNode(item?.body, ctx, out);
      return;
    case "Command":
      classifyCommand(node, ctx, out);
      return;
    default:
      collectWord(node, ctx, out);
  }
}

function walkSequential(commands, ctx, out) {
  for (const command of commands ?? []) walkCommandNode(command, ctx, out);
}

// 管道每个元素按子 shell 处理：元素内的 cd 不影响其他元素；cat <file> | 解释器
// 视为解释器执行该文件（bash <x.sh 的等价形态）。
function walkPipeline(node, ctx, out) {
  const elements = Array.isArray(node?.commands) ? node.commands : [];
  for (const element of elements) walkCommandNode(element, cloneContext(ctx), out);
  const last = elements.at(-1);
  const previous = elements.at(-2);
  if (!isStdinInterpreter(last) || !isCatReader(previous)) return;
  for (const item of catFileOperands(previous)) {
    addTargetAccess(out, item, ctx.base, "pipeline");
  }
}

function classifyCommand(node, ctx, out) {
  const prefix = Array.isArray(node?.prefix) ? node.prefix : [];
  for (const item of prefix) collectWord(item, ctx, out);
  const args = [];
  const redirects = [];
  for (const item of node?.suffix ?? []) {
    if (item?.type === "Redirect") redirects.push(item);
    else args.push(item);
  }
  collectWord(node?.name, ctx, out);
  for (const word of args) collectWord(word, ctx, out);
  for (const redirect of redirects) collectWord(redirect?.file, ctx, out);
  const nameInfo = wordInfo(node?.name);
  if (!nameInfo.static) {
    if (nameInfo.text) addAccess(out, { kind: "execute-uncertain", raw: nameInfo.text, base: ctx.base, via: "dynamic-program" });
    return;
  }
  const chain = resolveWrapperChain(nameInfo.text, args.map(wordInfo));
  if (chain.dynamicProgram) {
    addAccess(out, { kind: "execute-uncertain", raw: chain.dynamicProgram, base: ctx.base, via: "wrapper" });
    return;
  }
  if (chain.program === "cd") {
    applyDirectoryChange(chain.args, ctx);
    return;
  }
  classifyProgram(chain, redirects, ctx, out);
}

function classifyProgram(chain, redirects, ctx, out) {
  const program = basenameOf(chain.program);
  const spec = INTERPRETER_SPECS.get(program);
  if (spec) classifyInterpreter(program, spec, chain.args, redirects, ctx, out);
  else if (program === "find") classifyFind(chain.args, ctx, out);
  else if (program === "awk" || program === "gawk" || program === "mawk" || program === "nawk") classifyAwk(chain.args, ctx, out);
  else if (program === "sed") classifySed(chain.args, ctx, out);
  else classifyGeneric(chain, redirects, ctx, out);
}

// 解释器：脚本操作数按生效工作目录解析；-c/代码参数内的 Shell 代码递归解析；
// 无脚本操作数且从文件重定向 stdin 时视为执行该文件。
function classifyInterpreter(program, spec, args, redirects, ctx, out) {
  const operand = interpreterOperand(spec, args, ctx, out);
  if (operand.type === "script") addTargetAccess(out, operand.text, ctx.base, "interpreter");
  if (operand.type === "dynamic") addAccess(out, { kind: "execute-uncertain", raw: operand.text, base: ctx.base, via: "interpreter" });
  const noScript = operand.type === "none" || operand.type === "stdin";
  if (noScript && STDIN_INTERPRETERS.has(program)) {
    for (const redirect of redirects) addStdinRedirectAccess(redirect, ctx, out);
  }
}

function interpreterOperand(spec, args, ctx, out) {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (!arg.static) return { type: "dynamic", text: arg.text };
    const text = arg.text;
    if (text === "--") {
      index += 1;
      continue;
    }
    if (spec.codeFlags?.includes(text) || (spec.shell && isShellCodeFlag(text))) {
      const code = args[index + 1];
      if (spec.shell && code?.static && code.text) walkSubCommand(code.text, ctx, out);
      return { type: "code", text: "" };
    }
    if (spec.valueFlags?.includes(text)) {
      index += 2;
      continue;
    }
    if (text.startsWith("-")) {
      index += 1;
      continue;
    }
    if (text === "-") return { type: "stdin", text };
    if (text.includes("{}")) return { type: "dynamic", text };
    return { type: "script", text };
  }
  return { type: "none", text: "" };
}

function isShellCodeFlag(arg) {
  return arg.startsWith("-") && !arg.startsWith("--") && arg.slice(1).includes("c");
}

function classifyFind(args, ctx, out) {
  const searchPaths = [];
  let index = 0;
  while (index < args.length && (args[index].static ? !args[index].text.startsWith("-") : true)) {
    searchPaths.push(args[index++].text);
  }
  if (searchPaths.length === 0) searchPaths.push(".");
  const execWords = [];
  while (index < args.length) {
    const arg = args[index];
    if (arg.static && FIND_EXEC_MARKERS.has(arg.text)) {
      index += 1;
      while (index < args.length && !(args[index].static && [";", "+", ";;", "\\;"].includes(args[index].text))) {
        execWords.push(args[index++].text);
      }
    } else {
      index += 1;
    }
  }
  if (execWords.length === 0) {
    for (const searchPath of searchPaths) addAccess(out, { kind: "read", raw: searchPath, base: ctx.base, via: "find" });
    return;
  }
  classifyFindExec(execWords, searchPaths, ctx, out);
}

// find -exec 时被执行的不是 find 的路径参数而是匹配集合：把搜索范围标记为
// scopeDirectory，命中任一侧包含关系（范围内/范围覆盖授权根）时拒绝。
function classifyFindExec(execWords, searchPaths, ctx, out) {
  const chain = resolveWrapperChain(execWords[0] ?? "", execWords.slice(1).map(text => ({ text, static: true })));
  const program = basenameOf(chain.program);
  const interpreter = INTERPRETER_SPECS.get(program);
  if (interpreter) {
    const shellTemplate = interpreter.shell && chain.args.some(arg => arg.text.includes("{}"));
    const operand = interpreterOperand(interpreter, chain.args, ctx, out);
    if (shellTemplate || (operand.type === "dynamic" && operand.text.includes("{}"))) {
      for (const searchPath of searchPaths) addScopeAccess(out, searchPath, ctx.base, "find-exec");
      return;
    }
    if (operand.type === "script") addTargetAccess(out, operand.text, ctx.base, "find-exec");
    else if (operand.type === "dynamic") {
      addAccess(out, { kind: "execute-uncertain", raw: operand.text, base: ctx.base, via: "find-exec" });
    }
    return;
  }
  if (chain.program.includes("{}")) {
    for (const searchPath of searchPaths) addScopeAccess(out, searchPath, ctx.base, "find-exec");
    return;
  }
  if (isPathLike(chain.program)) addTargetAccess(out, chain.program, ctx.base, "find-exec");
}

function classifyAwk(args, ctx, out) {
  let index = 0;
  let programText = "";
  while (index < args.length) {
    const arg = args[index];
    if (!arg.static) break;
    if (["-F", "-v"].includes(arg.text)) {
      index += 2;
      continue;
    }
    if (arg.text === "-f" || arg.text === "--file") {
      if (args[index + 1]?.static) addTargetAccess(out, args[index + 1].text, ctx.base, "awk-file");
      index += 2;
      continue;
    }
    if (arg.text.startsWith("-")) {
      index += 1;
      continue;
    }
    programText = arg.text;
    index += 1;
    break;
  }
  for (const command of extractQuotedCalls(programText, "system")) walkSubCommand(command, ctx, out);
  for (; index < args.length; index += 1) {
    if (args[index].static && isPathLike(args[index].text)) {
      addAccess(out, { kind: "read", raw: args[index].text, base: ctx.base, via: "awk" });
    }
  }
}

function classifySed(args, ctx, out) {
  let index = 0;
  const scripts = [];
  while (index < args.length) {
    const arg = args[index];
    if (!arg.static) {
      index += 1;
      continue;
    }
    if (arg.text === "-e") {
      if (args[index + 1]?.static) scripts.push(args[index + 1].text);
      index += 2;
      continue;
    }
    if (arg.text === "-f" || arg.text === "--file") {
      if (args[index + 1]?.static) addTargetAccess(out, args[index + 1].text, ctx.base, "sed-file");
      index += 2;
      continue;
    }
    if (arg.text.startsWith("-")) {
      index += 1;
      continue;
    }
    if (scripts.length === 0) scripts.push(arg.text);
    else if (isPathLike(arg.text)) addAccess(out, { kind: "read", raw: arg.text, base: ctx.base, via: "sed" });
    index += 1;
  }
  for (const script of scripts) classifySedScript(script, ctx, out);
}

function classifySedScript(script, ctx, out) {
  const matches = String(script ?? "").matchAll(/(?:^|[;\n{}])\s*(?:[0-9$,\s]*?)e(?:\s+([^;\n]*))?/g);
  for (const match of matches) {
    const command = (match[1] ?? "").trim();
    if (command) walkSubCommand(command, ctx, out);
    else addAccess(out, { kind: "execute-uncertain", raw: `sed ${script}`, base: ctx.base, via: "sed-e" });
  }
}

function classifyGeneric(chain, redirects, ctx, out) {
  if (isPathLike(chain.program)) addTargetAccess(out, chain.program, ctx.base, "direct");
  for (const arg of chain.args) {
    if (arg.static && isPathLike(arg.text)) addAccess(out, { kind: "read", raw: arg.text, base: ctx.base, via: "argument" });
  }
  for (const redirect of redirects) {
    const file = wordInfo(redirect?.file);
    if (!file.static || !file.text || /^[0-9&-]+$/u.test(file.text)) continue;
    const kind = redirect?.op?.type === "less" ? "read" : "write";
    addAccess(out, { kind, raw: file.text, base: ctx.base, via: "redirect" });
  }
}

function addStdinRedirectAccess(redirect, ctx, out) {
  const file = wordInfo(redirect?.file);
  if (redirect?.op?.type !== "less") return;
  if (!file.static || !file.text) return;
  addTargetAccess(out, file.text, ctx.base, "stdin-redirect");
}

function resolveWrapperChain(program, args) {
  let chain = { program, args: [...args] };
  for (let guard = 0; guard < 10; guard += 1) {
    const spec = WRAPPER_SPECS.get(basenameOf(chain.program));
    if (!spec) return chain;
    chain = unwrapOnce(spec, chain.args);
    if (chain.dynamicProgram) return chain;
    if (!chain.program) return { program: "", args: [] };
  }
  return chain;
}

function unwrapOnce(spec, args) {
  let index = 0;
  let skippedPositional = 0;
  while (index < args.length) {
    const arg = args[index];
    if (!arg.static) return { program: "", args: [], dynamicProgram: arg.text };
    const text = arg.text;
    if (text === "--") {
      index += 1;
      continue;
    }
    if (isAssignment(text)) {
      index += 1;
      continue;
    }
    if (spec.subcommands?.includes(text)) {
      index += 1;
      continue;
    }
    if (spec.valueFlags?.some(flag => text === flag || text.startsWith(`${flag}=`))) {
      if (text.includes("=")) index += 1;
      else index += 2;
      continue;
    }
    if (spec.skipPositional && skippedPositional < spec.skipPositional) {
      skippedPositional += 1;
      index += 1;
      continue;
    }
    if (text.startsWith("-")) {
      index += 1;
      continue;
    }
    return { program: text, args: args.slice(index + 1) };
  }
  return { program: "", args: [] };
}

function applyDirectoryChange(args, ctx) {
  const target = args.find(arg => arg.static && arg.text && !arg.text.startsWith("-"))?.text;
  if (!target) return;
  if (target.includes("$") || target.includes("`")) {
    ctx.base = "";
    return;
  }
  if (path.isAbsolute(target)) ctx.base = target;
  else if (ctx.base) ctx.base = path.resolve(ctx.base, target);
  else ctx.base = "";
}

function addTargetAccess(out, raw, base, via) {
  if (typeof raw !== "string" || !raw.trim()) return;
  const resolved = resolveCandidate(raw, base);
  addAccess(out, { kind: "execute", certainty: resolved.certainty, raw, path: resolved.path, base, via });
}

function addScopeAccess(out, raw, base, via) {
  if (typeof raw !== "string" || !raw.trim()) return;
  const resolved = resolveCandidate(raw, base);
  addAccess(out, {
    kind: "execute",
    certainty: resolved.certainty,
    raw,
    path: resolved.path,
    base,
    scopeDirectory: true,
    via,
  });
}

function addAccess(out, access) {
  if (out.accesses.length >= PROJECT_MENTION_LIMIT) return;
  out.accesses.push({
    kind: access.kind,
    certainty: access.certainty === "resolved" ? "resolved" : "unresolved",
    raw: access.raw ?? "",
    path: access.path ?? "",
    base: access.base ?? "",
    scopeDirectory: access.scopeDirectory === true,
    via: access.via ?? "",
  });
}

function resolveCandidate(raw, base) {
  if (path.isAbsolute(raw)) return finalizeCandidate(raw);
  if (!base) return { certainty: "unresolved", path: "" };
  return finalizeCandidate(path.resolve(base, raw));
}

function finalizeCandidate(absolute) {
  const real = realpathSafe(absolute);
  return real
    ? { certainty: "resolved", path: real }
    : { certainty: "unresolved", path: absolute };
}

function walkSubCommand(text, ctx, out) {
  if (typeof text !== "string" || !text.trim()) return;
  let ast;
  try {
    ast = parse(text);
  } catch {
    out.mentions.push(text);
    return;
  }
  walkCommandNode(ast, cloneContext(ctx), out);
}

function collectWord(word, ctx, out) {
  if (!word || typeof word !== "object") return;
  const text = stripQuotes(typeof word.text === "string" ? word.text : "");
  if (text) out.mentions.push(text);
  for (const expansion of Array.isArray(word.expansion) ? word.expansion : []) {
    if (expansion?.commandAST) walkCommandNode(expansion.commandAST, cloneContext(ctx), out);
    else if (expansion?.type === "CommandExpansion" && typeof expansion.command === "string") walkSubCommand(expansion.command, ctx, out);
  }
}

function wordInfo(word) {
  const text = stripQuotes(typeof word?.text === "string" ? word.text : "");
  const expansions = Array.isArray(word?.expansion) ? word.expansion : [];
  return { text, static: expansions.length === 0 };
}

function extractQuotedCalls(text, callName) {
  const commands = [];
  const source = String(text ?? "");
  let index = source.indexOf(callName);
  while (index !== -1) {
    const match = /^\s*\(\s*(["'])([\s\S]*?)\1\s*\)/.exec(source.slice(index + callName.length));
    if (match) commands.push(match[2]);
    index = source.indexOf(callName, index + callName.length);
  }
  return commands;
}

function catFileOperands(node) {
  if (node?.type !== "Command" || !["cat", "tac"].includes(basenameOf(wordInfo(node.name).text))) return [];
  const files = [];
  for (const item of node.suffix ?? []) {
    if (item?.type === "Redirect") return [];
    const info = wordInfo(item);
    if (info.static && isPathLike(info.text)) files.push(info.text);
  }
  return files;
}

function isCatReader(node) {
  return catFileOperands(node).length > 0;
}

function isStdinInterpreter(node) {
  if (node?.type !== "Command") return false;
  const info = wordInfo(node.name);
  if (!info.static) return false;
  if (!STDIN_INTERPRETERS.has(basenameOf(info.text))) return false;
  const operands = (node.suffix ?? []).filter(item => item?.type !== "Redirect").map(item => wordInfo(item));
  return !operands.some(arg => !arg.static || (arg.text && !arg.text.startsWith("-")));
}

function cloneContext(ctx) {
  return { base: ctx.base };
}

function basenameOf(token) {
  return String(token ?? "").split("/").pop().toLowerCase().replace(/\.exe$/u, "");
}

function isPathLike(token) {
  return typeof token === "string" && token !== "" && (path.isAbsolute(token) || token.includes("/") ||
    /\.(?:py|sh|js|mjs|cjs|ts|go|rb|pl|bat|cmd|ps1|awk|sed)$/iu.test(token));
}

function isAssignment(token) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(token);
}

function stripQuotes(text) {
  if (typeof text !== "string" || text.length < 2) return typeof text === "string" ? text : "";
  const quote = text[0];
  if ((quote === '"' || quote === "'") && text[text.length - 1] === quote) return text.slice(1, -1);
  return text;
}

function realpathSafe(candidate) {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return "";
  }
}

function isWithin(root, target) {
  if (!root || !target) return false;
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function textMentionsRoot(text, rootRaw, rootReal) {
  if (typeof text !== "string" || !text) return false;
  const candidates = rootReal && rootReal !== rootRaw ? [rootRaw, rootReal] : [rootRaw];
  return candidates.some(candidate => candidate && text.includes(candidate));
}
