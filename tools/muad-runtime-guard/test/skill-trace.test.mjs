import assert from "node:assert/strict";
import {
  existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSkillAuditHooks } from "../src/skill-audit-hooks.mjs";
import { createSkillTraceExecutions } from "../src/skill-trace-executions.mjs";
import { createSkillTraceHooks } from "../src/skill-trace.mjs";
import { createTraceMetricsAccumulator } from "../src/skill-trace-metrics.mjs";
import { SkillTraceClient } from "../src/skill-trace-client.mjs";
import {
  cleanupSkillTraceSpools,
  counterFileFor,
  parseSkillTraceSpool,
  readSkillTraceCounter,
  spoolFileFor,
} from "../src/skill-trace-spool.mjs";

const EXECUTION_ID = "11111111-2222-4333-8444-555555555555";
const SESSION_KEY = "agent:alice:wecom:direct:wx-1";
const LOG_PREFIX = "[muad-runtime-guard][skill-trace]";

test("SkillTrace resolve_exec_env injects execution env and creates a 0700/0600 spool", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-trace-"));
  const { hooks, executions } = setup({ spoolRoot: root });
  register(executions, { executionId: EXECUTION_ID, skillName: "xdr-query" });

  const env = await hooks.resolveExecEnv({ toolName: "exec", runId: "run-1", sessionKey: SESSION_KEY }, context());

  assert.equal(env.MUAD_EXECUTION_ID, EXECUTION_ID);
  assert.equal(env.MUAD_SKILL_NAME, "xdr-query");
  assert.equal(env.MUAD_TRACE_SPOOL, path.join(root, `${EXECUTION_ID}.jsonl`));
  assert.equal(env.MUAD_SKILL_REQUEST_LIMIT, "50");
  assert.equal(statSync(root).mode & 0o777, 0o700);
  assert.equal(statSync(env.MUAD_TRACE_SPOOL).mode & 0o777, 0o600);
});

test("SkillTrace aggregates multi-process counts from the SDK sidecar", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-trace-"));
  // The SDK appends ".limit.json" to the spool file path; the guard must read
  // exactly that file, otherwise it falls back to one process's summary.
  assert.equal(
    counterFileFor(root, EXECUTION_ID),
    spoolFileFor(root, EXECUTION_ID) + ".limit.json",
  );
  writeFileSync(counterFileFor(root, EXECUTION_ID), JSON.stringify({
    interfaces: { "GET mssw:18080 /api/v1/ping": 6 },
    total: 6,
    errors: 1,
    hosts: { "mssw:18080": 6 },
    topInterfaces: [{ method: "GET", host: "mssw:18080", path: "/api/v1/ping", count: 6 }],
    aborted: true,
    abortInterface: "GET mssw:18080 /api/v1/ping",
    abortCount: 6,
    limit: 3,
  }));

  const counter = readSkillTraceCounter({ rootDir: root, executionId: EXECUTION_ID });
  const spool = [
    JSON.stringify({ v: 1, kind: "http", host: "mssw:18080", method: "GET", path: "/api/v1/ping", status: 200 }),
    // One process's summary only knows about its own request.
    JSON.stringify({ v: 1, kind: "summary", totalRequests: 1, errorCount: 0, aborted: false }),
  ].join("\n");
  const parsed = parseSkillTraceSpool(spool, { executionId: EXECUTION_ID, counter });

  assert.equal(parsed.metrics.cumulative, true);
  assert.equal(parsed.metrics.requestCount, 6);
  assert.equal(parsed.metrics.errorCount, 1);
  assert.equal(parsed.metrics.aborted, true);
  assert.equal(parsed.metrics.abortCount, 6);
  assert.deepEqual(parsed.metrics.topInterfaces, [
    { method: "GET", host: "mssw:18080", path: "/api/v1/ping", count: 6 },
  ]);
});

test("cumulative counter snapshots are merged idempotently across upload batches", () => {
  const accumulator = createTraceMetricsAccumulator();
  const snapshot = {
    cumulative: true,
    hasSummary: true,
    requestCount: 4,
    errorCount: 0,
    maxBurstPer10s: 4,
    detailTruncated: false,
    hosts: { "mssw:18080": 4 },
    topInterfaces: [{ host: "mssw:18080", method: "GET", path: "/api/v1/ping", count: 4 }],
    aborted: true,
    abortReason: "request_limit",
    abortInterface: "GET mssw:18080 /api/v1/ping",
    abortCount: 4,
  };

  // The same cumulative snapshot is uploaded after each exec; it must not add up.
  accumulator.merge(snapshot);
  accumulator.merge(snapshot);
  accumulator.merge(snapshot);
  const merged = accumulator.snapshot();

  assert.equal(merged.requestCount, 4);
  assert.equal(merged.errorCount, 0);
  assert.equal(merged.aborted, true);
  assert.equal(merged.abortCount, 4);
  assert.deepEqual(merged.topInterfaces, snapshot.topInterfaces);
});

test("incremental summaries without a sidecar still add up", () => {
  const accumulator = createTraceMetricsAccumulator();
  const batch = (count) => ({
    hasSummary: true,
    requestCount: count,
    errorCount: 0,
    hosts: { "mssw:18080": count },
    topInterfaces: [{ host: "mssw:18080", method: "GET", path: "/api/v1/ping", count }],
  });
  accumulator.merge(batch(2));
  accumulator.merge(batch(3));

  const merged = accumulator.snapshot();
  assert.equal(merged.requestCount, 5);
  assert.deepEqual(merged.topInterfaces, [
    { host: "mssw:18080", method: "GET", path: "/api/v1/ping", count: 5 },
  ]);
});

test("SkillTrace resolve_exec_env injects the requests compat env for configured business hosts", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-trace-"));
  const { hooks, executions } = setup({
    spoolRoot: root,
    config: { businessHosts: ["mssw.example.internal:8443", "mssp.example.internal"] },
  });
  register(executions, { executionId: EXECUTION_ID, skillName: "xdr-query" });

  const env = await hooks.resolveExecEnv(event(), context());

  assert.equal(env.MUAD_REQUESTS_COMPAT, "1");
  assert.equal(env.MUAD_BUSINESS_HOSTS, "mssw.example.internal:8443,mssp.example.internal");
});

test("SkillTrace leaves requests untouched when no business host is configured", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-trace-"));
  const { hooks, executions } = setup({ spoolRoot: root, config: { businessHosts: [] } });
  register(executions, { executionId: EXECUTION_ID, skillName: "xdr-query" });

  const env = await hooks.resolveExecEnv(event(), context());

  assert.equal(env.MUAD_REQUESTS_COMPAT, undefined);
  assert.equal(env.MUAD_BUSINESS_HOSTS, undefined);
});

test("SkillTrace resolve_exec_env fails closed for missing, conflicting, or unidentified mappings", async () => {
  const { hooks, executions, logs } = setup();
  const event = { toolName: "exec", runId: "run-1", sessionKey: SESSION_KEY };

  assert.equal(await hooks.resolveExecEnv(event, context()), undefined);

  register(executions, { executionId: EXECUTION_ID, skillName: "xdr-query" });
  register(executions, {
    executionId: "99999999-2222-4333-8444-555555555555", skillName: "other-skill",
  });
  assert.equal(await hooks.resolveExecEnv(event, context()), undefined);
  assert.ok(logs.some((line) => line.includes("action=resolve outcome=mapping_conflict")));

  executions.clear();
  register(executions, { executionId: EXECUTION_ID, skillName: "xdr-query" });
  assert.equal(await hooks.resolveExecEnv({ toolName: "exec" }, context()), undefined);
  assert.equal(await hooks.resolveExecEnv({ toolName: "read", sessionKey: SESSION_KEY }, context()), undefined);

  // A session key for another agent must never resolve alice's execution.
  assert.equal(await hooks.resolveExecEnv(
    { toolName: "exec", sessionKey: "agent:bob:wecom:direct:wx-1" },
    { agentId: "bob" },
  ), undefined);
});

test("SkillTrace resolves an exec without runId from the session's sole execution", async () => {
  const { hooks, executions } = setup();
  register(executions, { executionId: EXECUTION_ID, skillName: "xdr-query" });

  const env = await hooks.resolveExecEnv({ toolName: "exec", sessionKey: SESSION_KEY }, context());

  assert.equal(env.MUAD_EXECUTION_ID, EXECUTION_ID);
  assert.equal(env.MUAD_SKILL_NAME, "xdr-query");
  assert.match(env.MUAD_TRACE_SPOOL, new RegExp(`/${EXECUTION_ID}\\.jsonl$`, "u"));
});

test("SkillTrace session fallback fails closed when a session has two executions", async () => {
  const { hooks, executions, logs } = setup();
  register(executions, { executionId: EXECUTION_ID, skillName: "xdr-query" });
  register(executions, {
    executionId: "99999999-2222-4333-8444-555555555555",
    skillName: "other-skill",
    runId: "run-2",
  });

  assert.equal(await hooks.resolveExecEnv({ toolName: "exec", sessionKey: SESSION_KEY }, context()), undefined);
  assert.ok(logs.some((line) => line.includes("action=resolve outcome=mapping_conflict")));
});

test("SkillTrace uses the taskId as executionId for long task sessions", async () => {
  const { hooks, executions } = setup();
  const taskId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  executions.register({ agentId: "alice", taskId, skillName: "long-task-skill", executionId: taskId });

  const env = await hooks.resolveExecEnv(
    { toolName: "exec", sessionKey: `agent:alice:longtask:${taskId}:run-1` },
    context(),
  );

  assert.equal(env.MUAD_EXECUTION_ID, taskId);
  assert.equal(env.MUAD_SKILL_NAME, "long-task-skill");
  assert.match(env.MUAD_TRACE_SPOOL, new RegExp(`/${taskId}\\.jsonl$`, "u"));
});

test("SkillTrace parses 500 helper events plus a 600-request summary and carries the request Traceid", () => {
  const lines = [];
  for (let index = 1; index <= 500; index += 1) lines.push(httpLine(index));
  lines.splice(10, 0, "{not-json");
  lines.push(JSON.stringify({
    v: 1, ts: "2026-10-17T06:02:01Z", kind: "summary", totalRequests: 600,
    errorCount: 37, hosts: { mssw: 600 },
    topInterfaces: [{ host: "mssw", method: "GET", path: "/api/v1/targets/{id}", count: 590 }],
    maxBurst10s: 420, truncated: true, aborted: false,
  }));

  const parsed = parseSkillTraceSpool(lines.join("\n"), {
    executionId: EXECUTION_ID, now: Date.parse("2026-10-17T06:00:00Z"),
  });

  assert.equal(parsed.events.length, 500);
  assert.equal(parsed.metrics.requestCount, 600);
  assert.equal(parsed.metrics.errorCount, 37);
  assert.equal(parsed.metrics.distinctHosts, 1);
  assert.equal(parsed.metrics.maxBurstPer10s, 420);
  assert.equal(parsed.metrics.detailTruncated, true);
  assert.deepEqual(parsed.metrics.topInterfaces, [{ host: "mssw", method: "GET", path: "/api/v1/targets/{id}", count: 590 }]);
  assert.equal(parsed.metrics.aborted, false);
  assert.equal(parsed.events[0].eventId, `${EXECUTION_ID}:1`);
  assert.equal(parsed.events[0].kind, "http");
  assert.equal(parsed.events[0].status, "ok");
  assert.match(parsed.events[0].summary, /^GET mssw \/api\/v1\/targets\/1$/u);
  assert.equal(parsed.events[0].traceId, "tr-1");
  assert.equal(parsed.events[1].traceId, "tr-2");
  assert.doesNotMatch(JSON.stringify(parsed.events), /cookie|authorization|password/iu);
});

test("SkillTrace caps parsed events at 2000 and marks the detail truncated", () => {
  const lines = [];
  for (let index = 1; index <= 2100; index += 1) lines.push(httpLine(index));
  lines.push(JSON.stringify({ v: 1, kind: "summary", totalRequests: 2100, truncated: false }));

  const parsed = parseSkillTraceSpool(lines.join("\n"), { executionId: EXECUTION_ID });

  assert.equal(parsed.events.length, 2000);
  assert.equal(parsed.metrics.requestCount, 2100);
  assert.equal(parsed.metrics.detailTruncated, true);
});

test("SkillTrace client posts the batch to the internal trace endpoint with the pod token", async () => {
  const requests = [];
  const client = new SkillTraceClient({
    baseURL: "http://console.internal:8080/internal/v1",
    tokenFile: "/run/secrets/muad/pod-service-token",
    readToken: async () => "pod-token",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ code: 0, data: { storedEvents: 1, aborted: false } }), { status: 200 });
    },
  });
  const payload = { agentId: "alice", metrics: { requestCount: 1 }, events: [{ eventId: "e1" }] };

  const result = await client.report(EXECUTION_ID, payload);

  assert.deepEqual(result, { storedEvents: 1, aborted: false });
  assert.equal(requests[0].url, `http://console.internal:8080/internal/v1/skill-executions/${EXECUTION_ID}/trace`);
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers.Authorization, "Bearer pod-token");
  assert.deepEqual(JSON.parse(requests[0].init.body), payload);
});

test("SkillTrace client retries server failures but not deterministic rejections", async () => {
  const make = (status, code = 50000) => new SkillTraceClient({
    baseURL: "http://console.internal:8080/internal/v1",
    tokenFile: "/run/secrets/muad/pod-service-token",
    readToken: async () => "pod-token",
    fetch: async () => new Response(JSON.stringify({ code, message: "no" }), { status }),
  });

  await assert.rejects(make(503).report(EXECUTION_ID, {}), (error) => error.retryable === true);
  await assert.rejects(make(409, 40535).report(EXECUTION_ID, {}), (error) => error.retryable === false);
});

test("SkillTrace request limit env honours 0 (unlimited) and the legacy default", async () => {
  const unlimited = setup({ config: { skillRequestLimit: 0 } });
  register(unlimited.executions, { executionId: EXECUTION_ID, skillName: "xdr-query" });
  assert.equal(
    (await unlimited.hooks.resolveExecEnv(event(), context())).MUAD_SKILL_REQUEST_LIMIT,
    "0",
  );

  const legacy = setup({ config: { skillRequestLimit: undefined } });
  register(legacy.executions, { executionId: EXECUTION_ID, skillName: "xdr-query" });
  assert.equal(
    (await legacy.hooks.resolveExecEnv(event(), context())).MUAD_SKILL_REQUEST_LIMIT,
    "1000",
  );
});

test("SkillTrace audit dispatch promotes the same execution when the run starts", async () => {
  const executions = createSkillTraceExecutions();
  const reports = [];
  const audit = createSkillAuditHooks({
    config: {
      locale: "zh",
      skillAuditGrants: [
        { agentId: "alice", name: "xdr-query", rootPath: "/skills/xdr-query", source: "system" },
      ],
    },
    client: { report: async (request) => { reports.push(request); } },
    executions,
  });
  const ctx = { agentId: "alice", sessionKey: SESSION_KEY };

  await audit.beforeDispatch({ prompt: "/skill:xdr-query now" }, ctx);
  await audit.beforeAgentRun({ runId: "run-1" }, { ...ctx, runId: "run-1" });
  const promoted = executions.resolve({ agentId: "alice", sessionKey: SESSION_KEY, runId: "run-1" });
  assert.ok(promoted);
  assert.equal(promoted.skillName, "xdr-query");

  // A later report for the same run (read-SKILL.md path) must reuse the first
  // execution instead of manufacturing a two-execution conflict.
  await audit.beforeDispatch({ runId: "run-1", prompt: "/skill:xdr-query again" }, { ...ctx, runId: "run-1" });
  assert.equal(
    executions.resolve({ agentId: "alice", sessionKey: SESSION_KEY, runId: "run-1" }).executionId,
    promoted.executionId,
  );
  assert.equal(reports.length, 2);
});

test("SkillTrace hook enqueues upload work and returns within 50ms while the queue is blocked", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-trace-"));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const client = {
    report: async (executionId, payload) => {
      calls.push({ executionId, payload });
      await gate;
      return { storedEvents: payload.events.length };
    },
  };
  const { hooks, executions } = setup({ client, spoolRoot: root });
  register(executions, { executionId: EXECUTION_ID, skillName: "xdr-query" });
  const env = await hooks.resolveExecEnv(event(), context());
  writeFileSync(env.MUAD_TRACE_SPOOL, `${httpLine(1)}\n`, { flag: "a" });

  const started = performance.now();
  await hooks.afterToolCall(event(), context());
  const elapsed = performance.now() - started;

  assert.ok(elapsed < 50, `afterToolCall took ${elapsed}ms`);
  assert.deepEqual(await hooks.afterToolCall(event(), context()), undefined);
  release();
  await hooks.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executionId, EXECUTION_ID);
  assert.equal(calls[0].payload.agentId, "alice");
  assert.equal(calls[0].payload.events.length, 2);
  assert.equal(calls[0].payload.events[0].kind, "exec");
  assert.equal(calls[0].payload.events[0].seq, 1);
  assert.deepEqual(calls[0].payload.events.slice(1).map((item) => item.seq), [2]);
});

test("SkillTrace keeps the spool and retries the identical batch after a failed upload", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-trace-"));
  const calls = [];
  let fail = true;
  const client = {
    report: async (executionId, payload) => {
      calls.push({ executionId, payload });
      if (fail) {
        fail = false;
        throw Object.assign(new Error("console unavailable"), { retryable: true });
      }
      return { storedEvents: payload.events.length };
    },
  };
  const { hooks, executions, logs } = setup({ client, spoolRoot: root });
  register(executions, { executionId: EXECUTION_ID, skillName: "xdr-query" });
  const env = await hooks.resolveExecEnv(event(), context());
  writeFileSync(env.MUAD_TRACE_SPOOL, `${httpLine(1)}\n${httpLine(2)}\n`, { flag: "a" });

  await hooks.afterToolCall(event(), context());
  await hooks.flush();
  assert.equal(calls.length, 1);
  assert.equal(existsSync(env.MUAD_TRACE_SPOOL), true);
  assert.ok(logs.some((line) => line.includes("action=upload outcome=failed")));

  await hooks.afterToolCall(event(), context());
  await hooks.flush();
  assert.equal(calls.length, 2);
  assert.equal(existsSync(env.MUAD_TRACE_SPOOL), false);
  assert.deepEqual(
    calls[1].payload.events.map((item) => item.eventId),
    calls[0].payload.events.map((item) => item.eventId),
  );
});

test("SkillTrace keeps one exec event per exec with monotonic seq", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-trace-"));
  const calls = [];
  const client = { report: async (executionId, payload) => { calls.push({ executionId, payload }); return {}; } };
  const { hooks, executions } = setup({ client, spoolRoot: root });
  register(executions, { executionId: EXECUTION_ID, skillName: "xdr-query" });

  await hooks.resolveExecEnv(event(), context());
  await hooks.afterToolCall({
    ...event(), params: { command: "ls -la /opt/openclaw-skills/xdr-query" }, durationMs: 3,
  }, context());
  await hooks.flush();

  const env = await hooks.resolveExecEnv(event(), context());
  writeFileSync(env.MUAD_TRACE_SPOOL, `${httpLine(1)}\n${summaryLine(1)}\n`, { flag: "a" });
  await hooks.afterToolCall({
    ...event(), params: { command: "python3 /opt/openclaw-skills/xdr-query/scripts/run.py" }, durationMs: 100,
  }, context());
  await hooks.flush();

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].payload.events.map((item) => [item.seq, item.eventId, item.kind]), [
    [1, `${EXECUTION_ID}:1`, "exec"],
  ]);
  assert.deepEqual(calls[1].payload.events.map((item) => [item.seq, item.eventId, item.kind]), [
    [2, `${EXECUTION_ID}:2`, "exec"],
    [3, `${EXECUTION_ID}:3`, "http"],
  ]);
  assert.equal(calls[1].payload.events[0].summary,
    "python3 /opt/openclaw-skills/xdr-query/scripts/run.py");
});

test("SkillTrace accumulates metrics across exec batches", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-trace-"));
  const calls = [];
  const client = { report: async (executionId, payload) => { calls.push({ executionId, payload }); return {}; } };
  const { hooks, executions } = setup({ client, spoolRoot: root });
  register(executions, { executionId: EXECUTION_ID, skillName: "xdr-query" });

  for (const command of ["python3 run1.py", "python3 run2.py"]) {
    const env = await hooks.resolveExecEnv(event(), context());
    writeFileSync(env.MUAD_TRACE_SPOOL, `${httpLine(1)}\n${summaryLine(1)}\n`, { flag: "a" });
    await hooks.afterToolCall({ ...event(), params: { command } }, context());
    await hooks.flush();
  }

  assert.equal(calls.length, 2);
  assert.equal(calls[0].payload.metrics.requestCount, 1);
  assert.equal(calls[1].payload.metrics.requestCount, 2);
  assert.equal(calls[1].payload.metrics.errorCount, 0);
  assert.equal(calls[1].payload.metrics.distinctHosts, 1);
  assert.deepEqual(calls[1].payload.metrics.topInterfaces, [
    { host: "mssw", method: "GET", path: "/api/v1/targets/1", count: 2 },
  ]);
});

test("SkillTrace attribution slides its TTL while execs keep resolving", () => {
  let clock = 1_000;
  const executions = createSkillTraceExecutions({ now: () => clock, ttlMs: 1_000 });
  executions.register({
    agentId: "alice", sessionKey: SESSION_KEY, runId: "run-1",
    skillName: "xdr-query", executionId: EXECUTION_ID,
  });

  clock += 900;
  assert.ok(executions.resolveEntry({ agentId: "alice", sessionKey: SESSION_KEY, runId: "run-1" }).entry);
  clock += 900;
  assert.ok(executions.resolveEntry({ agentId: "alice", sessionKey: SESSION_KEY, runId: "run-1" }).entry);
  clock += 1_100;
  assert.equal(executions.resolveEntry({ agentId: "alice", sessionKey: SESSION_KEY, runId: "run-1" }).entry, null);
});

test("SkillTrace endSession clears the session fallback but keeps exact runId", () => {
  const executions = createSkillTraceExecutions();
  register(executions, { executionId: EXECUTION_ID, skillName: "xdr-query" });

  assert.ok(executions.resolveEntry({ agentId: "alice", sessionKey: SESSION_KEY }).entry);
  assert.equal(executions.endSession({
    agentId: "alice", sessionKey: SESSION_KEY, runId: "run-1",
  }), true);
  assert.equal(executions.resolveEntry({ agentId: "alice", sessionKey: SESSION_KEY }).entry, null);
  assert.ok(executions.resolveEntry({ agentId: "alice", sessionKey: SESSION_KEY, runId: "run-1" }).entry);
});

test("SkillTrace notify prefers the trusted turn sender over the session tail", async () => {
  const sessionKey = "agent:alice:wecom:direct:agent-alice";
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-trace-"));
  const notified = [];
  const client = { report: async () => ({}) };
  const notify = async (input) => { notified.push(input); return { ok: true }; };
  const { hooks, executions } = setup({
    client, notify, spoolRoot: root,
    trustedSender: (agentId, key) => agentId === "alice" && key === sessionKey ? "wx-trusted" : "",
  });
  register(executions, {
    executionId: EXECUTION_ID, skillName: "xdr-query", sessionKey,
  });
  const event = { toolName: "exec", runId: "run-1", sessionKey };
  const env = await hooks.resolveExecEnv(event, context());
  writeFileSync(env.MUAD_TRACE_SPOOL, [
    JSON.stringify({ v: 1, kind: "abort", reason: "request_limit", interface: "GET mssw /api/v1/ping", count: 4 }),
    JSON.stringify({ v: 1, kind: "summary", totalRequests: 4, aborted: true }),
  ].join("\n"), { flag: "a" });

  await hooks.afterToolCall(event, context());
  await hooks.flush();

  assert.equal(notified.length, 1);
  assert.equal(notified[0].channel, "wecom");
  assert.equal(notified[0].peerId, "wx-trusted");
});

test("SkillTrace aborted executions notify the mapped user without blocking trace upload", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-trace-"));
  const calls = [];
  const notified = [];
  const client = { report: async (executionId, payload) => { calls.push({ executionId, payload }); return {}; } };
  const notify = async (input) => { notified.push(input); return { ok: true }; };
  const { hooks, executions } = setup({ client, notify, spoolRoot: root });
  register(executions, { executionId: EXECUTION_ID, skillName: "xdr-query" });
  const env = await hooks.resolveExecEnv(event(), context());
  writeFileSync(env.MUAD_TRACE_SPOOL, [
    httpLine(1),
    JSON.stringify({ v: 1, ts: "2026-10-17T06:02:01Z", kind: "abort", reason: "request_limit", interface: "GET mssw /api/v1/targets/{id}", count: 1001, limit: 1000 }),
    JSON.stringify({ v: 1, ts: "2026-10-17T06:02:02Z", kind: "summary", totalRequests: 1001, aborted: true, truncated: false }),
  ].join("\n"), { flag: "a" });

  await hooks.afterToolCall(event(), context());
  await hooks.flush();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.metrics.aborted, true);
  assert.equal(calls[0].payload.metrics.abortInterface, "GET mssw /api/v1/targets/{id}");
  assert.deepEqual(calls[0].payload.events.map((item) => item.kind), ["exec", "http", "abort"]);
  assert.equal(calls[0].payload.events[2].status, "error");
  assert.equal(notified.length, 1);
  assert.equal(notified[0].channel, "wecom");
  assert.equal(notified[0].peerId, "wx-1");
  assert.match(notified[0].text, /xdr-query/u);
  assert.match(notified[0].text, /接口：GET mssw \/api\/v1\/targets\/\{id\}/u);
  assert.match(notified[0].text, /上限：单接口 50 次/u);
  assert.match(notified[0].text, /拦截：第 1001 次请求/u);
});

test("SkillTrace uploads one exec event when the Skill wrote no helper events", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-trace-"));
  const calls = [];
  const client = { report: async (executionId, payload) => { calls.push({ executionId, payload }); return {}; } };
  const { hooks, executions } = setup({ client, spoolRoot: root });
  register(executions, { executionId: EXECUTION_ID, skillName: "legacy-report" });
  await hooks.resolveExecEnv(event(), context());

  await hooks.afterToolCall({
    ...event(), params: { command: "python3 legacy_skill.py\n--flag" }, durationMs: 12,
  }, context());
  await hooks.flush();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.metrics.requestCount, 0);
  assert.equal(calls[0].payload.metrics.aborted, false);
  assert.equal(calls[0].payload.events.length, 1);
  assert.deepEqual(calls[0].payload.events[0], {
    eventId: `${EXECUTION_ID}:1`,
    seq: 1,
    occurredAt: calls[0].payload.events[0].occurredAt,
    kind: "exec",
    status: "ok",
    summary: "python3 legacy_skill.py --flag",
    detail: "",
    durationMs: 12,
  });
});

test("SkillTrace marks a failed exec event without leaking stderr", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-trace-"));
  const calls = [];
  const client = { report: async (executionId, payload) => { calls.push({ executionId, payload }); return {}; } };
  const { hooks, executions } = setup({ client, spoolRoot: root });
  register(executions, { executionId: EXECUTION_ID, skillName: "legacy-report" });
  await hooks.resolveExecEnv(event(), context());

  await hooks.afterToolCall({
    ...event(), params: { command: "python3 legacy_skill.py" },
    error: { stderr: "token=super-secret" },
  }, context());
  await hooks.flush();

  const execEvent = calls[0].payload.events[0];
  assert.equal(execEvent.kind, "exec");
  assert.equal(execEvent.status, "error");
  assert.equal(execEvent.detail, "exec_failed");
  assert.doesNotMatch(JSON.stringify(calls[0].payload), /super-secret/u);
});

test("SkillTrace notification failure is logged and does not affect the trace upload", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-trace-"));
  const calls = [];
  const client = { report: async (executionId, payload) => { calls.push({ executionId, payload }); return {}; } };
  const notify = async () => { throw new Error("IM offline"); };
  const { hooks, executions, logs } = setup({ client, notify, spoolRoot: root });
  register(executions, { executionId: EXECUTION_ID, skillName: "xdr-query" });
  const env = await hooks.resolveExecEnv(event(), context());
  writeFileSync(env.MUAD_TRACE_SPOOL, `${JSON.stringify({ v: 1, kind: "abort", reason: "request_limit", count: 1001 })}\n`, { flag: "a" });

  await hooks.afterToolCall(event(), context());
  await hooks.flush();

  assert.equal(calls.length, 1);
  assert.ok(logs.some((line) => line.includes("action=notify outcome=failed")));
});

test("SkillTrace drops work when the bounded queue is full and never blocks the hook", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-trace-"));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const client = { report: async () => { await gate; return {}; } };
  const { hooks, executions, logs } = setup({ client, spoolRoot: root, queueLimit: 1 });
  for (let index = 0; index < 5; index += 1) {
    const id = `00000000-0000-4000-8000-00000000000${index}`;
    executions.register({ agentId: "alice", sessionKey: SESSION_KEY, runId: `run-${index}`, skillName: "xdr-query", executionId: id });
    const env = await hooks.resolveExecEnv(
      { toolName: "exec", runId: `run-${index}`, sessionKey: SESSION_KEY }, context(),
    );
    writeFileSync(env.MUAD_TRACE_SPOOL, `${httpLine(index + 1)}\n`, { flag: "a" });
    const started = performance.now();
    await hooks.afterToolCall(
      { toolName: "exec", runId: `run-${index}`, sessionKey: SESSION_KEY }, context(),
    );
    assert.ok(performance.now() - started < 50);
  }
  assert.ok(logs.some((line) => line.includes("reason=queue_full")));
  release();
  await hooks.flush();
});

test("SkillTrace logs every diagnostic with the stable module prefix", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-trace-"));
  const client = { report: async () => { throw Object.assign(new Error("down"), { retryable: true }); } };
  const { hooks, executions, logs } = setup({ client, spoolRoot: root });
  register(executions, { executionId: EXECUTION_ID, skillName: "xdr-query" });
  const env = await hooks.resolveExecEnv(event(), context());
  writeFileSync(env.MUAD_TRACE_SPOOL, `${httpLine(1)}\n`, { flag: "a" });

  await hooks.afterToolCall(event(), context());
  await hooks.flush();

  assert.ok(logs.length > 0);
  for (const line of logs) assert.ok(line.startsWith(LOG_PREFIX), line);
});

test("SkillTrace startup cleanup removes only spool files older than 24h", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "skill-trace-"));
  const oldFile = path.join(root, "00000000-0000-4000-8000-000000000001.jsonl");
  const newFile = path.join(root, "00000000-0000-4000-8000-000000000002.jsonl");
  writeFileSync(oldFile, "{}\n");
  writeFileSync(newFile, "{}\n");
  const now = Date.now();
  utimesSync(oldFile, new Date(now - 25 * 60 * 60 * 1000), new Date(now - 25 * 60 * 60 * 1000));

  const result = cleanupSkillTraceSpools({ rootDir: root, now });

  assert.equal(result.removed, 1);
  assert.equal(existsSync(oldFile), false);
  assert.equal(existsSync(newFile), true);
  assert.equal(readFileSync(newFile, "utf8"), "{}\n");
});

function setup({ client, notify, config, spoolRoot, queueLimit, trustedSender } = {}) {
  const executions = createSkillTraceExecutions();
  const logs = [];
  const hooks = createSkillTraceHooks({
    executions,
    client: client ?? { report: async () => ({ storedEvents: 0 }) },
    notify: notify ?? (async () => ({ ok: true })),
    getConfig: () => ({ skillRequestLimit: 50, locale: "zh", ...(config ?? {}) }),
    spoolRoot,
    queueLimit,
    trustedSender,
    log: (line) => logs.push(line),
  });
  return { hooks, executions, logs };
}

function register(executions, { executionId, skillName, runId = "run-1", sessionKey = SESSION_KEY, agentId = "alice" }) {
  executions.register({
    agentId,
    sessionKey,
    runId,
    skillName,
    executionId,
  });
}

function event() {
  return { toolName: "exec", runId: "run-1", sessionKey: SESSION_KEY, senderId: "wx-1" };
}

function context() {
  return { agentId: "alice" };
}

function httpLine(index) {
  return JSON.stringify({
    v: 1,
    ts: new Date(Date.parse("2026-10-17T06:00:00Z") + index * 1000).toISOString(),
    kind: "http",
    host: "mssw",
    platform: "mssw",
    method: "GET",
    path: `/api/v1/targets/${index}`,
    status: index % 10 === 0 ? 500 : 200,
    durationMs: 10 + (index % 50),
    errorClass: index % 10 === 0 ? "http_500" : "",
    traceId: `tr-${index}`,
  });
}

function summaryLine(count) {
  return JSON.stringify({
    v: 1,
    ts: "2026-10-17T06:02:00Z",
    kind: "summary",
    totalRequests: count,
    errorCount: 0,
    hosts: { mssw: count },
    topInterfaces: [{ host: "mssw", method: "GET", path: "/api/v1/targets/1", count }],
    maxBurst10s: 1,
    truncated: false,
    aborted: false,
  });
}
