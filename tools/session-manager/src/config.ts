import { AGENT_PATTERN, MAX_SESSION_KEY_LENGTH } from "./constants/runtime.js";
import { SessionManagerError } from "./errors.js";
import type { TrustedContext } from "./types.js";

export type CLIConfig = {
  consoleInternalURL: string;
  trustedContext: TrustedContext;
};

export function loadCLIConfig(env: NodeJS.ProcessEnv): CLIConfig {
  // 身份只来自 MUAD_SESSION_KEY（guard 的 resolve_exec_env 注入）。注意：exec 子进程
  // 可任意改写自身 env（字符串拼接 / env 字典赋值均可绕过字面扫描），因此这里的解析
  // 不能当作防伪边界——它只保证"密钥声称哪个 agent 就解析成哪个 agent"。真正的归属
  // 校验在服务端：console resolver 按 pod 校验 agent 归属，且 parseCredential /
  // validateCredential 强制 credential.agentId === 请求 agentId，CLI 绝不返回密钥声称
  // agent 以外的凭据。pod 内跨 agent 的密钥伪造需要 per-agent 证明（控制面侧变更），
  // 超出本模块能力范围。
  const sessionKey = String(env.MUAD_SESSION_KEY ?? "").trim();
  const consoleInternalURL = String(env.MUAD_CONSOLE_INTERNAL_URL ?? "").trim();
  const agentId = sessionAgentId(sessionKey);
  if (!agentId || sessionKey.length > MAX_SESSION_KEY_LENGTH || !consoleInternalURL) {
    throw new SessionManagerError("invalid_context");
  }
  return { consoleInternalURL, trustedContext: { agentId, sessionKey } };
}

function sessionAgentId(sessionKey: string): string {
  const normalized = sessionKey.startsWith("session:") ? sessionKey.slice("session:".length) : sessionKey;
  const [prefix, agentId] = normalized.split(":");
  if (prefix !== "agent" || !agentId || !AGENT_PATTERN.test(agentId)) return "";
  return agentId;
}
