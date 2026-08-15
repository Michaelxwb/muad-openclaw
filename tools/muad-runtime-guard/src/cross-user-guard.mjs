// Blocks the last reachable cross-agent vector in a multi-user pod: a business
// agent reaching another user's session artifacts (or the pod resolver token) by
// raw path through shell/file tools, forging its execution identity, or leaking
// session data into the channel. Skill scripts are the only sanctioned path to
// session state — via the trusted session-manager CLI and the injected
// MUAD_SESSION_KEY — so direct path access and credential dumps fail closed here.

const SESSION_ARTIFACT_PATTERNS = [
  // any agent's session-store directory (word boundary catches -name/-path globs)
  /\bsession-store\b/u,
  // the platform cookie bundle written by session-manager
  /\bbundle\.json\b/u,
  // per-skill session state files (<skill>.session.json)
  /\.session\.json\b/u,
];

// The pod service token is the resolver credential; reading it enables direct
// credential resolution for any agent in the pod. Unlike session artifacts it is
// never exempted by the directory-op whitelist below (chmod/chown of the token
// would enable reading it).
const POD_SERVICE_TOKEN_PATTERN = /\/run\/secrets\/muad\/pod-service-token\b/u;

// 本地正则仅为辅助防线：exec 子进程可任意改写自身 env（字符串拼接、env 字典赋值
// 都能绕过字面匹配），Node 进程内无法完全防伪。硬边界在服务端归属校验——console
// resolver 按 pod 校验 agent 归属（GetHumanUserByAgent(pod, agent)），session-manager
// CLI 亦校验 credential.agentId === 请求 agentId；本扫描只拦截明显的字面/拼接赋值形态。
const FORGED_SESSION_KEY_PATTERNS = [
  // 字面赋值：MUAD_SESSION_KEY=… / export MUAD_SESSION_KEY=…
  /MUAD_SESSION_KEY\s*=(?!=)/u,
  // env 字典写值：os.environ["MUAD_SESSION_KEY"]=… / env['MUAD_SESSION_KEY'] = …
  /["']MUAD_SESSION_KEY["']\s*\]\s*=(?!=)/u,
  // 拼接键写值：os.environ["MUAD_" + "SESSION_KEY"]=… / env["MUAD_"+"SESSION_KEY"]=…
  /["']MUAD_["']\s*\+\s*["']SESSION_KEY["']\s*\]?\s*=(?!=)/u,
  // putenv/setenv 拼接：os.putenv("MUAD_" + "SESSION_KEY", …)
  /(?:putenv|setenv)\s*\(\s*["']MUAD_["']\s*\+\s*["']SESSION_KEY/u,
];

// 目录操作白名单：这些命令只触碰目录元数据，不读取会话内容（mkdir -p session-store
// 等合法操作不再被误伤）。读取/拷贝类命令（cat/cp/find -exec 等）不在白名单内，仍拦截。
const DIRECTORY_OP_TOOLS = new Set([
  "mkdir", "mkdirp", "rmdir", "rm", "ls", "stat", "touch", "chmod", "chown", "du", "df",
]);

// 会话文件转储的结构特征（高精度）：只有 dump 出 session-manager 产物时才拦截，
// 单个字段的普通技术讨论（如提及 httpOnly）不再误伤整条回复。
const STRONG_SESSION_DUMP_MARKERS = [
  /"storageState"\s*:/u,
  /"credentialFingerprint"\s*:/u,
];
const WEAK_SESSION_DUMP_MARKERS = [
  /"httpOnly"\s*:\s*(?:true|false)\b/u,
  /"sameSite"\s*:/u,
  /"cookies"\s*:/u,
  /"origins"\s*:/u,
];
// 大段 base64（会话 cookie bundle 的常见编码形态）。
const BASE64_RUN = /[A-Za-z0-9+/]{64,}={0,2}/u;

const EXEC_TOOLS = new Set(["exec", "bash"]);
const FILE_CONTENT_TOOLS = new Set(["write", "edit", "apply_patch"]);

const SESSION_ACCESS_REASON =
  "session files are not readable through shell or scripts; use the trusted session-manager CLI";
const FORGED_KEY_REASON =
  "re-asserting MUAD_SESSION_KEY is disabled; the trusted execution context is injected automatically";
const SESSION_LEAK_REASON = "reply contains protected session data";

export function createCrossUserGuard({ config, log = () => {} }) {
  const mainAgentId = config?.mainAgentId;
  const refusal = refusalText(config?.locale);
  return {
    beforeToolCall: async (event, ctx) => {
      if (ctx?.agentId === mainAgentId) return undefined;
      const reason = scanToolCall(event);
      if (!reason) return undefined;
      diag(log, `blocked agent=${safeId(ctx?.agentId)} tool=${safeId(event?.toolName)} reason=${reason}`);
      return { block: true, blockReason: reason };
    },
    replyPayloadSending: async (event, ctx) => {
      const text = event?.payload?.text;
      if (typeof text !== "string" || !isSessionDump(text)) {
        return undefined;
      }
      diag(log, `blocked reply leak agent=${safeId(ctx?.agentId)}`);
      return { payload: { ...event.payload, text: refusal }, reason: SESSION_LEAK_REASON };
    },
  };
}

function scanToolCall(event) {
  const toolName = safeId(event?.toolName);
  const text = EXEC_TOOLS.has(toolName)
    ? shellCommandText(event)
    : FILE_CONTENT_TOOLS.has(toolName) ? fileContentText(event) : "";
  if (!text) return "";
  if (FORGED_SESSION_KEY_PATTERNS.some((pattern) => pattern.test(text))) return FORGED_KEY_REASON;
  return sessionAccessReason(text);
}

function sessionAccessReason(text) {
  if (POD_SERVICE_TOKEN_PATTERN.test(text)) return SESSION_ACCESS_REASON;
  if (!SESSION_ARTIFACT_PATTERNS.some((pattern) => pattern.test(text))) return "";
  if (directoryOpWhitelisted(text)) return "";
  return SESSION_ACCESS_REASON;
}

// 仅当命令首 token 是目录操作白名单工具时放行；其余命令触及会话产物一律拦截。
// 复合命令（&& / ; / 管道 / 换行拼接的多个命令）不享受白名单——`rm -rf x && cat
// y/session-store/bundle.json` 这类组合不能因首命令是 rm 而放行。
function directoryOpWhitelisted(text) {
  if (/[;&|]|\n/u.test(text)) return false;
  const first = String(text.trim().split(/\s+/u)[0] ?? "").split("/").pop().toLowerCase();
  return DIRECTORY_OP_TOOLS.has(first);
}

// 结构感知的会话转储检测：至少 1 个强特征，或 2 个以上弱特征（"同时含多个 session
// 字段"），或 1 个弱特征 + 大段 base64。单个字段的提及（如技术讨论里的 httpOnly）
// 不再触发拦截。
function isSessionDump(text) {
  const strong = STRONG_SESSION_DUMP_MARKERS.filter((pattern) => pattern.test(text)).length;
  if (strong > 0) return true;
  const weak = WEAK_SESSION_DUMP_MARKERS.filter((pattern) => pattern.test(text)).length;
  if (weak >= 2) return true;
  return weak >= 1 && BASE64_RUN.test(text);
}

function shellCommandText(event) {
  const params = record(event?.params);
  const parts = [];
  for (const key of ["command", "script", "cmd"]) {
    if (typeof params[key] === "string") parts.push(params[key]);
  }
  if (Array.isArray(params.commands)) {
    for (const item of params.commands) {
      if (typeof item === "string") parts.push(item);
    }
  }
  return parts.join("\n");
}

function fileContentText(event) {
  const params = record(event?.params);
  const parts = [];
  for (const key of ["content", "text"]) {
    if (typeof params[key] === "string") parts.push(params[key]);
  }
  if (typeof params.patch === "string") parts.push(params.patch);
  return parts.join("\n");
}

function refusalText(locale) {
  return locale === "en"
    ? "This reply contained protected session data and was blocked by the security policy. Session credentials are only available through trusted Skills; use the relevant Skill to check your session."
    : "该回复包含受保护的会话数据，已被安全策略拦截。会话凭据只能通过受信 Skill 读取，如需检查会话状态请使用对应 Skill。";
}

function diag(log, message) {
  log(`[cross-user] ${message}`);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeId(value) {
  return typeof value === "string" ? value.trim() : "unknown";
}
