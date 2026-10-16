import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const PROC_ROOT = "/proc";

// 按“归属标记”枚举进程：标记必须是可信记录（如任务 skillRoot 前缀）中派生出的
// 绝对路径；只读 /proc，不依赖 ps 输出格式。zombie 进程视为已停止（容器 PID1 不回收）。
export function listProcessesByMarker(marker, deps = {}) {
  const readdir = deps.readdir ?? readdirSync;
  const readFile = deps.readFile ?? ((file) => readFileSync(file, "utf8"));
  const result = [];
  let entries = [];
  try {
    entries = readdir(PROC_ROOT);
  } catch {
    return result;
  }
  for (const name of entries) {
    if (!/^\d+$/u.test(name)) continue;
    let cmdline = "";
    try {
      cmdline = readFile(path.join(PROC_ROOT, name, "cmdline")).split("\u0000").join(" ").trim();
    } catch {
      continue;
    }
    if (!cmdline || !cmdline.includes(marker)) continue;
    let zombie = false;
    try {
      const stat = readFile(path.join(PROC_ROOT, name, "stat"));
      zombie = stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ");
    } catch {
      continue;
    }
    result.push({ pid: Number(name), cmdline, zombie });
  }
  return result;
}

// 终止仍存活的同归属进程；只有全部（非 zombie）进程消失才返回 ok。
// /proc 不可读（非 Linux 测试环境）时返回空集 → ok，保持既有停止确认语义。
export async function sweepOrphanProcesses(marker, options = {}) {
  if (typeof marker !== "string" || marker.trim().length === 0) return { ok: true, remaining: [] };
  const list = options.list ?? listProcessesByMarker;
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  const attempts = options.attempts ?? 40;
  const delayMs = options.delayMs ?? 250;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const survivors = list(marker).filter((item) => !item.zombie);
    if (survivors.length === 0) return { ok: true, remaining: [] };
    for (const item of survivors) {
      try {
        kill(item.pid, "SIGKILL");
      } catch {
        // 已退出或不可杀（权限/竞态）：交给下一轮枚举复核。
      }
    }
    await sleep(delayMs);
  }
  const remaining = list(marker).filter((item) => !item.zombie).map((item) => item.pid);
  return { ok: remaining.length === 0, remaining };
}
