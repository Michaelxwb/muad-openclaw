// Gateway 重启信号：9.6 起 SIGUSR1 改为调试用途，重启迁移到 SIGUSR2。
// 控制面通过 pod 内 prepare 结果拿到信号提示，按 pod 自身版本选择协议，
// 避免对旧版（2026.7.1）误发 USR2 或对新版误发 USR1 导致配置不生效。
import { spawnSync } from "node:child_process";

const VERSION_PATTERN = /(\d{4})\.(\d{1,2})\.(\d{1,2})/u;

export function gatewayRestartSignal(versionOutput) {
  const match = String(versionOutput ?? "").match(VERSION_PATTERN);
  if (!match) return "USR1";
  const [year, month, patch] = match.slice(1).map(Number);
  const atLeast96 =
    year > 2026 ||
    (year === 2026 && (month > 9 || (month === 9 && patch >= 6)));
  return atLeast96 ? "USR2" : "USR1";
}

export function detectGatewayRestartSignal(dependencies = {}) {
  const run = dependencies.spawnSync ?? spawnSync;
  try {
    const result = run("openclaw", ["--version"], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (result?.error || result?.status !== 0) return "USR1";
    return gatewayRestartSignal(result.stdout);
  } catch {
    return "USR1";
  }
}
