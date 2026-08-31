#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const nodes = [
  {
    stage: "prepare",
    started: "进度 smoke · prepare\n⏳ 中文 / English / 😀 / **Markdown** 按文本发送",
    completed: "进度 smoke · prepare\n✅ 执行环境已就绪",
  },
  {
    stage: "deliver",
    started: "进度 smoke · deliver\n⏳ 正在验证主动消息顺序",
    completed: "进度 smoke · deliver\n✅ stage/done 已全部提交",
  },
];

async function main() {
  const delayMs = progressDelay(process.env.PROGRESS_SMOKE_DELAY_MS);
  for (const node of nodes) {
    reportProgress("stage", node.stage, node.started);
    await delay(delayMs);
    reportProgress("done", node.stage, node.completed);
    await delay(delayMs);
  }
  process.stdout.write(`${JSON.stringify({
    status: "PROGRESS_NOTIFY_SMOKE_OK",
    nodes: nodes.length,
    notifications: nodes.length * 2,
  })}\n`);
}

function reportProgress(command, stage, text) {
  const result = spawnSync(
    "muad-progress",
    [command, "--stage", stage, "--text", text],
    {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, MUAD_PROGRESS_STRICT_BRIDGE: "1" },
    },
  );
  if (result.error || result.status !== 0) {
    // 透传子进程 stderr（如 muad-progress: bridge_unavailable），让
    // [exec-failed] 日志与最终回复都能看到真实失败原因。
    const detail = result.error?.message?.trim() ||
      result.stderr?.trim() ||
      `exit ${result.status ?? "unknown"}`;
    throw new Error(`muad-progress ${command} failed: ${detail}`);
  }
}

function progressDelay(value) {
  if (value === undefined || value.trim() === "") return 1_500;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10_000) {
    throw new Error("PROGRESS_SMOKE_DELAY_MS must be an integer from 0 to 10000");
  }
  return parsed;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "progress smoke failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
