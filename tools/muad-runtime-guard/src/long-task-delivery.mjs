import { notifyUser } from "../../shared/notify-user.mjs";

// 长任务结果投递：把 openclaw agent --json 的 stdout 解析成可投递的多段结果，
// 并由 manager 在取消仲裁后决定是否发起投递（替代子 CLI 的无条件 --deliver）。
// - 结果解析容忍尾随诊断输出，但 envelope 非法时显式失败（fail loud，不静默丢结果）。
// - 投递保留多段顺序：每段文本一条消息，每个附件经共享 notifyUser 的 --media 发送。

const MAX_PAYLOADS = 64;

export function parseAgentResultPayloads(stdout) {
  const source = typeof stdout === "string" ? stdout.trim() : "";
  if (!source) return { ok: true, payloads: [] };
  let response = null;
  try {
    response = JSON.parse(source);
  } catch {
    // CLI 可能先输出诊断行；取最后一行的 JSON envelope。
    const lines = source.split(/\r?\n/u).filter((line) => line.trim().startsWith("{"));
    for (let index = lines.length - 1; index >= 0 && response === null; index -= 1) {
      try {
        response = JSON.parse(lines[index]);
      } catch {
        // try the previous line
      }
    }
    if (response === null) return { ok: false, reason: "result_invalid_json" };
  }
  const raw = response?.result?.payloads ?? response?.payloads;
  if (raw !== undefined && !Array.isArray(raw)) return { ok: false, reason: "result_schema_invalid" };
  const payloads = [];
  for (const item of raw ?? []) {
    const payload = normalizePayload(item);
    if (payload) payloads.push(payload);
    if (payloads.length >= MAX_PAYLOADS) break;
  }
  return { ok: true, payloads };
}

function normalizePayload(item) {
  if (typeof item === "string") {
    const value = item.trim();
    return value ? { text: value, media: [] } : null;
  }
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const text = typeof item.text === "string" ? item.text.trim() : "";
  const media = payloadMedia(item);
  if (!text && media.length === 0) return null;
  return { text, media };
}

function payloadMedia(item) {
  const refs = [];
  for (const field of ["media", "attachments", "files"]) {
    const value = item[field];
    if (value === undefined || value === null) continue;
    for (const entry of Array.isArray(value) ? value : [value]) {
      const ref = typeof entry === "string"
        ? entry.trim()
        : firstText(entry?.path, entry?.url, entry?.file, entry?.filePath);
      if (ref) refs.push(ref);
    }
  }
  return [...new Set(refs)];
}

export function createResultDelivery({ notify = notifyUser, log = () => {} } = {}) {
  async function send(input) {
    try {
      const result = await notify(input);
      return result?.ok === true;
    } catch (error) {
      log(`[muad-runtime-guard][longtask-delivery] notify failed reason=${errorText(error)}`);
      return false;
    }
  }

  // manager 专属投递许可入口：按段顺序投递文本与附件，返回可解释的投递结果。
  // 入参兼容解析器输出与原始 payload 形状（文本/字符串 media/对象 media）。
  return async function deliverResult(task, payloads) {
    const channel = text(task?.replyChannel);
    const peerId = text(task?.peerId);
    if (!channel || !peerId) return { delivered: false, sent: 0, failed: 0, reason: "route_unavailable" };
    let sent = 0;
    let failed = 0;
    const record = (ok) => { if (ok) sent += 1; else failed += 1; };
    for (const raw of Array.isArray(payloads) ? payloads : []) {
      const payload = normalizePayload(raw);
      if (!payload) continue;
      const textValue = text(payload.text);
      if (textValue) record(await send({ channel, peerId, text: textValue }));
      for (const ref of payload.media) {
        record(await send({ channel, peerId, text: "", media: ref }));
      }
    }
    const result = { delivered: failed === 0, sent, failed };
    if (failed > 0) log(`[muad-runtime-guard][longtask-delivery] partial delivery sent=${sent} failed=${failed}`);
    return result;
  };
}

function firstText(...values) {
  for (const value of values) {
    const candidate = text(value);
    if (candidate) return candidate;
  }
  return "";
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function errorText(error) {
  return String(error?.message || error).replace(/\s+/gu, " ").slice(0, 200);
}
