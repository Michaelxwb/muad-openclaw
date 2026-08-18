// notify-user.mjs — 主动向 IM 用户推送消息的共享能力。
//
// 底层复用 openclaw 的 `message send` CLI：不跑模型、不依赖 IM 类型的
// target 格式（--target 传 channel 插件能识别的裸 peer id，插件自己 normalize
// user:/channel: 前缀）。调用方只需持有 channel + peerId + 文案，未来任何
// 插件（guard、session-manager、新 tools 插件）都能 import 复用。
//
// 为什么用 `message send` 而不是 `gateway call message.action`：
// `message.action` 走核心投递路径时不传播 dangerouslyAllowPrivateNetwork，
// 内网（如 host.docker.internal / 私有域名）会被 SSRF 守卫拦截返回 403；
// `message send` 走 channel 插件自身的 send 生命周期，正确读取账户配置的
// private-network opt-in，内网与公网都能投递。已实测：内网环境
// `openclaw message send --channel mattermost --target <裸 peerId> --message ...`
// 返回 ✅ Sent via Mattermost。
//
// 契约：
//   channel  投递通道（如 "mattermost" / "wecom"）
//   peerId   收件人 peer id（如 mattermost 的 user id；裸 id 或 user:/channel:
//            前缀均可，message send 会按 channel 插件自行归一化）
//   text     要推送的文案
//
// 返回值统一为 { ok: true } | { ok: false, error }，不抛异常、不泄露内部细节，
// 调用方按需决定是否记录/重试。

import { spawn } from "node:child_process";

const MESSAGE_SEND_TIMEOUT_MS = 30_000;
const MAX_STDERR_BYTES = 4 * 1024;

/**
 * 向指定 IM 用户推送一条消息。
 * @param {object} options
 * @param {string} options.channel 投递通道
 * @param {string} options.peerId 收件人 peer id（裸 id 或 user:/channel: 前缀均可）
 * @param {string} options.text 文案
 * @param {typeof spawn} [options.spawn] 注入 spawn 供测试
 * @param {(msg: string) => void} [options.log] 诊断日志
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function notifyUser({
  channel,
  peerId,
  text,
  spawn: spawnLike = spawn,
  log = () => {},
}) {
  const channelValue = String(channel ?? "").trim();
  const peerValue = String(peerId ?? "").trim();
  const textValue = String(text ?? "");
  if (!channelValue || !peerValue || textValue === "") {
    return { ok: false, error: "notify-user: channel, peerId, and text are required" };
  }
  const args = [
    "message", "send",
    "--channel", channelValue,
    "--target", peerValue,
    "--message", textValue,
    "--json",
  ];
  const result = await runOpenClaw(args, spawnLike, log);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  // openclaw message send 成功时 exit 0（--json 时 stdout 为 JSON）。这里不深究
  // 具体响应体，命令 exit 0 即视为投递成功。
  return { ok: true };
}

function runOpenClaw(args, spawnLike, log) {
  return new Promise((resolve) => {
    let settled = false;
    let stderr = "";
    let stdout = "";
    const child = spawnLike("openclaw", args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      resolve({ ok: false, error: `notify-user: openclaw message send timed out after ${MESSAGE_SEND_TIMEOUT_MS}ms` });
    }, MESSAGE_SEND_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-MAX_STDERR_BYTES);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: `notify-user: spawn openclaw failed: ${err.message}` });
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      const detail = (stderr || stdout || `exit code ${code}`).trim().slice(-500);
      log(`notify-user failed: ${detail}`);
      resolve({ ok: false, error: `notify-user: openclaw message send failed (${detail})` });
    });
  });
}
