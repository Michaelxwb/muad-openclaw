import assert from "node:assert/strict";
import { deliverOpenClawProgressEvent } from "../src/adapter.mjs";

const sent = [];
const result = deliverOpenClawProgressEvent(
  {
    type: "progress",
    skill: "xdr-alert",
    stage: "query",
    text: "正在查询 XDR 告警数据",
    visibility: "channel",
    privacy: "public",
  },
  { emitToolProgress: (payload) => sent.push(payload) },
);

assert.deepEqual(result, { ok: true, delivery: "sent" });
assert.deepEqual(sent[0], {
  text: "正在查询 XDR 告警数据",
  id: "query",
  name: "xdr-alert",
  phase: "query",
  status: "running",
});

const dropped = deliverOpenClawProgressEvent(
  { type: "progress", stage: "query", text: "internal", visibility: "internal" },
  { emitToolProgress: (payload) => sent.push(payload) },
);
assert.deepEqual(dropped, { ok: true, delivery: "dropped", reason: "non_channel" });

const statuses = [];
deliverOpenClawProgressEvent(
  { type: "done", text: "处理完成" },
  { emitToolProgress: (payload) => statuses.push(payload.status) },
);
deliverOpenClawProgressEvent(
  { type: "error", text: "处理失败" },
  { emitToolProgress: (payload) => statuses.push(payload.status) },
);
assert.deepEqual(statuses, ["done", "error"]);
