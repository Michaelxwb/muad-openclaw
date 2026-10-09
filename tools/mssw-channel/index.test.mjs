import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import plugin from "./index.mjs";
import { targetFor } from "./protocol.mjs";

function fakeRuntime(agentDir, executions) {
  return {
    channel: {
      routing: {
        resolveAgentRoute: ({ peer }) => ({
          agentId: peer.id === "alice" ? "alice" : "main",
        }),
      },
      session: {
        resolveStorePath: () => agentDir,
        recordInboundSession: async () => {},
      },
      reply: {
        finalizeInboundContext: (value) => value,
        dispatchReplyWithBufferedBlockDispatcher: async (value) => {
          executions.push(value.ctx);
          value.replyOptions.onPartialReply({ text: "部分回答" });
          await value.dispatcherOptions.deliver(
            { text: "完整回答" },
            { kind: "final" },
          );
        },
      },
    },
  };
}

function fixture(t) {
  const agentDir = mkdtempSync(path.join(tmpdir(), "muad-mssw-"));
  const hooks = new Map(),
    deliveries = [],
    executions = [];
  let route, channel;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, request) => {
    deliveries.push(JSON.parse(request.body));
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const api = {
    config: {
      channels: {
        mssw: { baseUrl: "http://platform", botToken: "test-only-token" },
      },
      agents: { list: [{ id: "alice", agentDir }] },
    },
    logger: { warn() {} },
    registerChannel: (value) => {
      channel = value.plugin;
    },
    registerHttpRoute: (value) => {
      route = value;
    },
    on: (name, fn) => hooks.set(name, fn),
    runtime: fakeRuntime(agentDir, executions),
  };
  plugin.register(api);
  t.after(() => {
    hooks.get("gateway_stop")();
    globalThis.fetch = originalFetch;
    rmSync(agentDir, { recursive: true, force: true });
  });
  return { agentDir, deliveries, executions, hooks, channel, route };
}
async function submit(f, body) {
  let status, result;
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = "POST";
  await f.route.handler(req, {
    writeHead(code) {
      status = code;
    },
    end(value) {
      result = JSON.parse(value);
    },
  });
  return { status, result };
}
async function settled() {
  for (let i = 0; i < 20; i++)
    await new Promise((resolve) => setImmediate(resolve));
}
const message = () => ({
  runId: randomUUID(),
  conversationId: randomUUID(),
  senderId: "alice",
  tenantId: "tenant-a",
  text: "你好",
});

test("native route is gateway-authenticated and repeated runs execute once", async (t) => {
  const f = fixture(t),
    body = message();
  assert.equal(f.route.auth, "gateway");
  assert.equal(f.route.path, "/mssw/messages");
  assert.equal((await submit(f, body)).status, 202);
  await settled();
  assert.equal((await submit(f, body)).status, 202);
  await settled();
  assert.equal(f.executions.length, 1);
  assert.equal(f.executions[0].Provider, "mssw");
  assert.equal(f.deliveries.at(-1).state, "complete");
  assert.equal(f.deliveries.at(-1).text, "完整回答");
  const saved = JSON.parse(
    readFileSync(path.join(f.agentDir, "mssw-delivery", body.runId + ".json")),
  );
  assert.equal(saved.outbox.length, 0);
});
test("unbound senders, caller-selected agents and conflicting retry ownership are rejected", async (t) => {
  const f = fixture(t),
    body = message();
  assert.equal((await submit(f, { ...body, senderId: "unknown" })).status, 403);
  assert.equal((await submit(f, { ...body, agentId: "alice" })).status, 403);
  await submit(f, body);
  await settled();
  assert.equal(
    (await submit(f, { ...body, tenantId: "tenant-b" })).status,
    403,
  );
  assert.equal(f.executions.length, 1);
});
test("outbound text retains its user, tenant and conversation", async (t) => {
  const f = fixture(t),
    body = message();
  await f.channel.outbound.sendText({
    to: targetFor(body.senderId, body.tenantId, body.conversationId),
    text: "后台通知",
    agentId: "alice",
  });
  assert.equal(f.deliveries[0].conversation_id, body.conversationId);
  assert.equal(f.deliveries[0].state, "notification");
});
test("a previous-process unfinished run is interrupted and delivered without agent reexecution", async (t) => {
  const f = fixture(t),
    body = message();
  const dir = path.join(f.agentDir, "mssw-delivery");
  mkdirSync(dir);
  writeFileSync(
    path.join(dir, body.runId + ".json"),
    JSON.stringify({
      ...body,
      prompt: body.text,
      agentId: "alice",
      ownerBoot: "previous-process",
      state: "running",
      sequence: 1,
      outbox: [],
    }),
  );
  f.hooks.get("gateway_start")();
  await submit(f, body);
  await settled();
  assert.equal(f.executions.length, 0);
  assert.equal(f.deliveries[0].state, "interrupted");
});
